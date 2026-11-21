# /// script
# requires-python = ">=3.11"
# dependencies = ["pypdf>=6"]
# ///
"""
browse-daemon.py — the browsing endpoint: Promnesia and hister APIs on one local store.

WHY this exists: the stock Promnesia extension (sidebar, visited marks) and the
stock hister extension (page capture, indexing rules) both need an HTTP server,
and neither may reach the Firefox profile (docs/d204). This daemon is that
server. It is the hybrid endpoint of docs/d205: the L2 APIs of both tools over
one SQLite store, with the same canonicalisation on every path.

WHY SQLite here and Parquet later: docs/d173 keeps the hot zone small and
docs/d178 fixes the one hot real-time read (the visited check). SQLite owns the
staging rows, the presence index, the recent documents, the rules table and a
posting index shaped for the cold tier - all of it hot. The cold generations
(Parquet visits, postings) are a later compaction step; the posting table is
already sorted by term so a Parquet rewrite is a row-group copy, not a redesign
(docs/d205, cold-shaped search). Nothing here claims to be that cold tier.

WHY one file: the pieces share the schema and the canonicaliser, and a reader
must see a route and the row it answers from without jumping files (docs/d113's
copy-unit rule keeps the folder whole, not the file count low).

HTTP surface, in the order the register lists it (docs/d205), on the port each
client already defaults to:

  hister      127.0.0.1:4433   GET  /search /api/config /api/profile /api/rules
                                    /api/document
                               POST /search /api/rules /api/add /api/add_pdf
                                    /api/delete /api/label /api/history
       plus the producer's ingest edge on the same listener:
              POST /ingest/slurp            visits, titles, bookmarks, removals
  promnesia   127.0.0.1:13131  GET|POST /visited /visits /search /search_around
                                    /status

Env: BROWSE_HISTER_ADDR (default 127.0.0.1:4433) - BROWSE_PROMNESIA_ADDR
     (default 127.0.0.1:13131) - BROWSE_DB (default XDG data
     dir/agent-warehouse/browse.sqlite) - BROWSE_TOKEN (static key, disabled by
     default; reads are never gated).

Usage: browse-daemon.sh [--print-config]
"""

from __future__ import annotations

import base64
import datetime as dt
import hmac
import json
import math
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
from collections import Counter, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from cannon import CanonifyException, canonify

SCHEMA_VERSION = 1
DAEMON_VERSION = "0.1.0"

# Two listeners, each on the port its own extension already defaults to: the
# hister extension is configured for http://127.0.0.1:4433/ (its webui/ext
# DEFAULT_SERVER_URL and the server's DefaultServerAddress) and Promnesia's
# server defaults to 13131 (its server.py --port). A stock client is therefore
# pointed at a stock port with no editing, and neither protocol's paths can
# shadow the other's.
#
# WHY the slurp ingest rides the hister listener instead of a third stack: it
# writes the same SQLite store as the hister face, so one process keeps one
# writer, one store and one schema; the envelope is the boundary that would let
# it split later without a client change.
HISTER_ADDR = os.environ.get("BROWSE_HISTER_ADDR") or "127.0.0.1:4433"
PROMNESIA_ADDR = os.environ.get("BROWSE_PROMNESIA_ADDR") or "127.0.0.1:13131"
_data_home = os.environ.get("XDG_DATA_HOME") or os.path.join(
    os.path.expanduser("~"), ".local", "share"
)
DB_PATH = os.environ.get("BROWSE_DB") or os.path.join(_data_home, "agent-warehouse", "browse.sqlite")
TOKEN = os.environ.get("BROWSE_TOKEN") or ""


def _env_int(name: str, fallback: int) -> int:
    """An env integer, or the default when absent, empty or not a number.

    A typo such as 8MB must not reach a comparison: a body ceiling that
    compares false is no ceiling, and a timeout that compares false never
    fires. The warning names the variable so the operator can see which one
    was ignored.
    """
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    try:
        value = int(raw)
    except ValueError:
        sys.stderr.write(
            "browse-daemon: " + name + "=" + repr(raw)
            + " is not an integer; using " + str(fallback) + "\n"
        )
        return fallback
    return value if value > 0 else fallback


# The HTTP faces are a local tool, not a public service, but every unbounded
# read is still a denial of service for the host: a client that declares a
# gigabyte body, or posts a form with a million fields, allocates before any
# route sees it. The ceilings are generous for the stock clients and tunable
# for a capture that is larger than usual.
MAX_BODY = _env_int("BROWSE_MAX_BODY", 8 * 1024 * 1024)
MAX_FORM_FIELDS = _env_int("BROWSE_MAX_FORM_FIELDS", 10_000)
MAX_PDF_BYTES = _env_int("BROWSE_MAX_PDF_BYTES", 32 * 1024 * 1024)
MAX_VISITED_URLS = _env_int("BROWSE_MAX_VISITED_URLS", 5_000)
# RFC 9457 problem details: every error body names a stable type and a title,
# so a client branches on the type rather than on a prose string.
PROBLEM_BASE = "https://agentcontainer.example/problems/"

# One thread per connection is the stdlib server's default, and a slow client
# can hold a thread for the socket timeout. A bounded pool turns connection
# exhaustion into a fast 503 instead of an unbounded thread count.
MAX_WORKERS = _env_int("BROWSE_MAX_WORKERS", 32)
# PDF extraction runs in a separate interpreter with rlimits and a timeout: a
# parser crash or a decompression bomb must not take the appender down with it.
PDF_TIMEOUT = _env_int("BROWSE_PDF_TIMEOUT", 20)
PDF_MAX_TEXT = _env_int("BROWSE_PDF_MAX_TEXT", 8 * 1024 * 1024)
try:
    PDF_RUNNER = shlex.split(os.environ.get("BROWSE_PDF_RUNNER", ""))
except ValueError as exc:
    raise SystemExit(f"browse-daemon: bad BROWSE_PDF_RUNNER: {exc}") from exc

# One writer at a time: SQLite allows a single writer, and every write here is a
# short transaction. The lock is held across the write, never across a response.
_write_lock = threading.Lock()

# The hot zone. visit and bookmark are keyed (src, key), which IS the
# (src, kind, key) dedupe identity of docs/d204: the table a row lands in names
# its kind, so a re-sent batch is absorbed without a second index. presence is
# the one complete resident structure (docs/d178) and is written in the same
# transaction as the row that proves it.
SCHEMA = """
CREATE TABLE IF NOT EXISTS visit(
  src TEXT NOT NULL, key TEXT NOT NULL,
  norm_url TEXT NOT NULL, orig_url TEXT NOT NULL,
  dt TEXT NOT NULL, context TEXT, duration REAL,
  locator_title TEXT, locator_href TEXT,
  transition TEXT, page_id TEXT, visit_id TEXT, via TEXT,
  PRIMARY KEY(src, key));
CREATE INDEX IF NOT EXISTS visit_norm ON visit(norm_url);
CREATE INDEX IF NOT EXISTS visit_dt ON visit(dt);

-- A bookmark carries its parent guid and index, not a folder path: the path is
-- a view derived from the parent chain the producer sends (docs/d204), and
-- storing it would go stale on every move.
CREATE TABLE IF NOT EXISTS bookmark(
  src TEXT NOT NULL, key TEXT NOT NULL,
  norm_url TEXT, orig_url TEXT,
  title TEXT, parent_id TEXT, position INTEGER, node_type TEXT,
  date_added INTEGER, date_modified INTEGER,
  PRIMARY KEY(src, key));
CREATE INDEX IF NOT EXISTS bookmark_parent ON bookmark(parent_id);

-- A title fact is keyed on the page guid and belongs to the page, not a visit
-- (docs/d204): a title learned later must not invent a visit, but the sidebar
-- should show it, so it lands here and backs the presence locator.
CREATE TABLE IF NOT EXISTS page_title(
  norm_url TEXT PRIMARY KEY, title TEXT, seen_at TEXT);

CREATE TABLE IF NOT EXISTS tombstone(
  kind TEXT NOT NULL, key TEXT NOT NULL,
  deleted_at TEXT NOT NULL, source TEXT,
  PRIMARY KEY(kind, key));

CREATE TABLE IF NOT EXISTS presence(
  norm_url TEXT PRIMARY KEY, orig_url TEXT NOT NULL,
  dt TEXT NOT NULL, src TEXT NOT NULL, context TEXT, duration REAL,
  locator_title TEXT, locator_href TEXT);

CREATE TABLE IF NOT EXISTS document(
  owner INTEGER NOT NULL, norm_url TEXT NOT NULL,
  url TEXT NOT NULL, title TEXT, text TEXT, html TEXT, favicon TEXT,
  language TEXT, label TEXT, added INTEGER NOT NULL, updated INTEGER NOT NULL,
  add_count INTEGER NOT NULL DEFAULT 1, type INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  PRIMARY KEY(owner, norm_url));

CREATE TABLE IF NOT EXISTS rule(name TEXT PRIMARY KEY, patterns TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS click(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL, title TEXT, query TEXT, added INTEGER NOT NULL);

-- The producer's per-stream high-water mark. It is recorded, never trusted to
-- skip a batch: a producer that resets its own sequence (a storage wipe, a
-- reinstall) would otherwise be answered as duplicates forever while nothing
-- was written. Row identity (src, kind, key) is the authority.
CREATE TABLE IF NOT EXISTS stream(name TEXT PRIMARY KEY, acked_high INTEGER NOT NULL);

-- The cold-shaped inverted index (docs/d205, Search). term_stats is the
-- dictionary and posting is the posting list, sorted by term and carrying no
-- positions: a cold query touches one contiguous term range, and a Parquet
-- rewrite keeps the same row order, so this is the ClickHouse-shaped
-- dictionary + postings pair rather than a text-index engine. doc_length is
-- the BM25 normaliser; field 0/1/2 is url/title/text.
CREATE TABLE IF NOT EXISTS term_stats(
  term TEXT PRIMARY KEY, doc_freq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS posting(
  term TEXT NOT NULL, owner INTEGER NOT NULL, norm_url TEXT NOT NULL,
  field INTEGER NOT NULL, tf INTEGER NOT NULL,
  PRIMARY KEY(term, owner, norm_url, field)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS posting_doc ON posting(owner, norm_url);
CREATE TABLE IF NOT EXISTS doc_length(
  owner INTEGER NOT NULL, norm_url TEXT NOT NULL, length INTEGER NOT NULL,
  PRIMARY KEY(owner, norm_url)) WITHOUT ROWID;

-- The store's own migration mark, separate from the wire's schema number: an
-- upgrade that changes the index shape clears and rebuilds the postings, while
-- the producer keeps sending schema 1.
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def log(message: str) -> None:
    sys.stdout.write(f"browse-daemon: {message}\n")
    sys.stdout.flush()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_store() -> None:
    # Browsing history is private: a 0755 directory and 0644 database are
    # readable by every other local user. The process umask covers the WAL/SHM
    # sidecars SQLite creates beside the main file.
    directory = os.path.dirname(DB_PATH) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    # The default store directory is this daemon's own; tighten an older 0755
    # one. A caller-chosen directory keeps its mode, because chmod on a shared
    # parent such as /tmp is not this process's decision.
    if os.path.basename(os.path.abspath(directory)) == "agent-warehouse":
        try:
            os.chmod(directory, 0o700)
        except OSError:
            pass
    with _write_lock, connect() as conn:
        conn.executescript(SCHEMA)
        ensure_index(conn)
    try:
        os.chmod(DB_PATH, 0o600)
    except OSError:
        pass


# --- canonicalisation and the time boundary ---------------------------------


def normalise(url: str) -> str:
    """The single normalisation every path uses (docs/d205, Canonicalization)."""
    try:
        return canonify(url or "")
    except CanonifyException:
        # An unparseable URL still has to answer the visited check; keeping it
        # verbatim answers "not seen" instead of folding it into another URL.
        return (url or "").strip()


def _moment(value: Any) -> dt.datetime:
    """Firefox sends epoch milliseconds; producers may send seconds or ISO text."""
    if value is None or value == "":
        return dt.datetime.now(dt.UTC)
    if isinstance(value, (int, float)):
        seconds = float(value) / 1000.0 if float(value) > 1e11 else float(value)
        return dt.datetime.fromtimestamp(seconds, dt.UTC)
    text = str(value).strip()
    if text.replace(".", "", 1).isdigit():
        return _moment(float(text))
    # IXDTF may carry a bracketed [Zone] annotation; the offset already fixes
    # the instant, and fromisoformat knows only the offset part.
    if text.endswith("]") and "[" in text:
        text = text[: text.rfind("[")].rstrip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    parsed = dt.datetime.fromisoformat(text)
    # Store one zone. The read faces compare and order these strings, and a
    # lexical comparison of "+02:00" against "+00:00" is a different instant
    # that sorts in the wrong place. The wire conversion back to the host zone
    # is _promnesia_dt's job, not storage's.
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.UTC)).astimezone(dt.UTC)


def _ms(moment: dt.datetime) -> int:
    return int(moment.timestamp() * 1000)


def _promnesia_dt(moment: dt.datetime) -> str:
    """The timestamp in IXDTF's numeric-offset form, in the host's timezone.

    RFC 9557 (IXDTF) is the modern spelling, but the stock Promnesia extension
    parses this field with Date.parse and then slices six characters off the
    end, so the bracketed [Zone] annotation would break it. The offset form is
    still IXDTF, and emitting the local wall clock plus its offset makes both
    the extension's dt_utc and dt_local correct. Upstream's own legacy
    "%d %b %Y %H:%M:%S %z" shape is the one thing not reproduced: it forced
    every consumer to guess the zone (docs/d205, Search).
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.UTC)
    return moment.astimezone().isoformat(timespec="seconds")


# --- ingest: the custom slurper (docs/d204) ---------------------------------


class BadRequest(Exception):
    pass


# d204 leaves Firefox's visit id open ("verify visitId stability"): the producer
# keys a visit on (raw URL, visit time) and sends that key, which survives a
# profile rebuild that renumbers the local visit rows. The daemon falls back to
# the same pair when a producer omits it, so one fact cannot land twice.
def _visit_key(record: dict[str, Any], norm_url: str) -> str:
    if record.get("key"):
        return str(record["key"])
    return f"{norm_url}@{_ms(_moment(record.get('visit_time', record.get('dt'))))}"


# The presence row is the one hot read (docs/d178), so its merge rule is a
# correctness rule: the earliest sighting owns dt, but a later row that knows a
# title or a context fills the blank. Promnesia's /visited answers a locus, and
# a blank title where the bookmark chain knew one is a worse answer than a
# slightly earlier row.
def _presence(
    conn: sqlite3.Connection,
    norm: str,
    url: str,
    at: str,
    src: str,
    context: str | None,
    title: str | None,
    href: str | None,
) -> None:
    conn.execute(
        "INSERT INTO presence"
        "(norm_url, orig_url, dt, src, context, duration, locator_title, locator_href)"
        " VALUES(?,?,?,?,?,NULL,?,?)"
        " ON CONFLICT(norm_url) DO UPDATE SET"
        " context=COALESCE(presence.context, excluded.context),"
        " locator_title=COALESCE(NULLIF(presence.locator_title,''), excluded.locator_title),"
        " locator_href=COALESCE(presence.locator_href, excluded.locator_href)",
        (norm, url, at, src, context, title, href),
    )


def _visit(conn: sqlite3.Connection, src: str, record: dict[str, Any]) -> bool:
    url = str(record.get("url") or "")
    if not url:
        raise BadRequest("visit record without url")
    norm = normalise(url)
    key = _visit_key(record, norm)
    at = _moment(record.get("visit_time", record.get("dt"))).isoformat()
    title = record.get("title")
    cursor = conn.execute(
        "INSERT OR IGNORE INTO visit(src, key, norm_url, orig_url, dt, context, duration,"
        " locator_title, locator_href, transition, page_id, visit_id, via)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            src,
            key,
            norm,
            url,
            at,
            record.get("context"),
            record.get("duration"),
            title,
            record.get("locator_href"),
            record.get("transition"),
            record.get("page_id"),
            record.get("visit_id"),
            record.get("via"),
        ),
    )
    if cursor.rowcount == 0:
        return False
    _presence(conn, norm, url, at, src, record.get("context"), title, None)
    return True


def _title(conn: sqlite3.Connection, url: str, title: str, at: str) -> bool:
    """A page-title fact: fill a blank locator, never overwrite a known title.

    Returns whether the fact was new, so a replayed batch is reported as
    duplicates rather than as fresh writes — the ack's counts are what the
    producer's backoff reads, and an idempotent row that always says "accepted"
    makes a stuck queue look busy.
    """
    norm = normalise(url)
    existing = conn.execute(
        "SELECT title FROM page_title WHERE norm_url = ?", (norm,)
    ).fetchone()
    if existing is not None and existing["title"] == title:
        return False
    conn.execute(
        "INSERT INTO page_title(norm_url, title, seen_at) VALUES(?,?,?)"
        " ON CONFLICT(norm_url) DO UPDATE SET title=excluded.title, seen_at=excluded.seen_at",
        (norm, title, at),
    )
    conn.execute(
        "UPDATE presence SET locator_title = ? WHERE norm_url = ? AND"
        " (locator_title IS NULL OR locator_title = '')",
        (title, norm),
    )
    return True


def _bookmark(conn: sqlite3.Connection, src: str, record: dict[str, Any]) -> bool:
    key = str(record.get("key") or "")
    if not key:
        raise BadRequest("bookmark record without key")
    url = record.get("url")
    existing = conn.execute(
        "SELECT * FROM bookmark WHERE src = ? AND key = ?", (src, key)
    ).fetchone()
    # A move or a rename is an event too: the row's parent, position and title
    # are facts the producer re-sends, and INSERT OR IGNORE would drop every
    # one after the first walk. Only date_added is immutable; the folder path
    # stays a view over the chain (docs/d204).
    node_type = str(
        record.get("node_type") or (existing["node_type"] if existing else "bookmark")
    )
    norm = normalise(str(url)) if url else (existing["norm_url"] if existing else None)
    orig_url = str(url) if url else (existing["orig_url"] if existing else None)
    title = record.get("title")
    if title is None and existing is not None:
        title = existing["title"]
    parent_id = record.get("parent_id")
    if parent_id is None and existing is not None:
        parent_id = existing["parent_id"]
    position = record.get("position")
    if position is None and existing is not None:
        position = existing["position"]
    at = record.get("date_added")
    added_ms = int(at) if isinstance(at, (int, float)) else None
    if existing is not None:
        # date_added is the one immutable fact: a move or a rename re-sends it,
        # and a partial event must not blank it.
        added_ms = existing["date_added"]
    modified = record.get("date_modified")
    modified_ms = int(modified) if isinstance(modified, (int, float)) else None
    if modified_ms is None and existing is not None:
        modified_ms = existing["date_modified"]
    values = (norm, orig_url, title, parent_id, position, node_type, added_ms, modified_ms)
    if existing is not None:
        if all(existing[name] == value for name, value in zip(
            ("norm_url", "orig_url", "title", "parent_id", "position", "node_type",
             "date_added", "date_modified"), values)):
            return False
        conn.execute(
            "UPDATE bookmark SET norm_url=?, orig_url=?, title=?, parent_id=?,"
            " position=?, node_type=?, date_added=?, date_modified=?"
            " WHERE src=? AND key=?",
            values + (src, key),
        )
    else:
        conn.execute(
            "INSERT INTO bookmark(src, key, norm_url, orig_url, title, parent_id,"
            " position, node_type, date_added, date_modified)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (src, key) + values,
        )
    if norm:
        # A bookmark is context, never a visit (docs/d204): enrich a page that
        # a visit already made present, but never create the visited mark from
        # the bookmark stream. That is why this is an UPDATE and not _presence.
        title = record.get("title")
        conn.execute(
            "UPDATE presence SET"
            " locator_title=COALESCE(NULLIF(locator_title,''), ?),"
            " locator_href=COALESCE(locator_href, ?)"
            " WHERE norm_url=?",
            (title, url, norm),
        )
        # A bookmark title is context, not a visit mutation. page_title is the
        # derived read-time locator, so a later real title event can replace it;
        # the visit row itself stays append-only.
        if title:
            conn.execute(
                "INSERT INTO page_title(norm_url, title, seen_at) VALUES(?,?,?)"
                " ON CONFLICT(norm_url) DO NOTHING",
                (norm, title, dt.datetime.now(dt.UTC).isoformat()),
            )
    return True


def _tombstone(
    conn: sqlite3.Connection, kind: str, key: str, at: str, source: str
) -> bool:
    """Record a removal mark, first-write-wins except for a global clear.

    A page or bookmark mark names one identity, so the first sighting is the
    fact and a replay changes nothing. A history clear is a timestamp: a second
    clear must move the mark forward, or the visits between the two clears stay
    visible forever.
    """
    existing = conn.execute(
        "SELECT deleted_at FROM tombstone WHERE kind = ? AND key = ?", (kind, key)
    ).fetchone()
    if existing is not None:
        if kind != "history-cleared":
            return False
        try:
            if _moment(str(existing["deleted_at"])) >= _moment(at):
                return False
        except (TypeError, ValueError, OverflowError):
            # A malformed stored mark must not hide a newer clear.
            if str(existing["deleted_at"]) >= at:
                return False
        conn.execute(
            "UPDATE tombstone SET deleted_at = ?, source = ? WHERE kind = ? AND key = ?",
            (at, source, kind, key),
        )
        return True
    conn.execute(
        "INSERT INTO tombstone(kind, key, deleted_at, source) VALUES(?,?,?,?)",
        (kind, key, at, source),
    )
    return True


def ingest_batch(envelope: dict[str, Any]) -> dict[str, Any]:
    """Apply one producer batch; returns the ack the extension treats as durable.

    The envelope and the record shapes are the producer's (the extension's
    wire contract, docs/d204): a batch is single-stream, every record carries
    its own src and kind, and the ack reports accepted, duplicates and the
    daemon version. The stream's sequence mark is recorded but never used to
    skip a batch: row identity decides what is a duplicate.
    """
    schema = envelope.get("schema")
    if schema != SCHEMA_VERSION:
        raise BadRequest(f"unsupported schema {schema!r}; this daemon speaks {SCHEMA_VERSION}")
    stream = str(envelope.get("stream") or "")
    if not stream:
        raise BadRequest("missing stream")
    records = envelope.get("records", [])
    if not isinstance(records, list):
        raise BadRequest("records must be an array")
    seq = envelope.get("stream_seq") or {}
    high = seq.get("high")
    high = int(high) if isinstance(high, (int, float)) else None
    accepted = duplicates = 0
    with _write_lock, connect() as conn:
        # The whole-batch shortcut a sequence number invites is NOT taken: a
        # producer that resets its own sequence (a storage wipe, a reinstall, a
        # restore from an older profile) would restart at 1 while this store
        # remembers a higher mark, and every subsequent batch would be answered
        # as a duplicate while nothing was written. Row identity is the
        # authority (src, kind, key), so a batch is always applied and the mark
        # is only recorded for observability.
        for record in records:
            if not isinstance(record, dict):
                raise BadRequest("each record must be an object")
            src = str(record.get("src") or "unknown")
            kind = str(record.get("kind") or "")
            fresh = False
            if kind == "visit":
                fresh = _visit(conn, src, record)
            elif kind == "title":
                fresh = _title(
                    conn,
                    str(record.get("url") or ""),
                    str(record.get("title") or ""),
                    _moment(record.get("seen_at")).isoformat(),
                )
            elif kind == "bookmark":
                fresh = _bookmark(conn, src, record)
            elif kind == "bookmark-removed":
                # A folder removal arrives once, with descendants filtered
                # out of the event, so the daemon resolves the subtree it
                # already stores (docs/d204's onRemoved note).
                key = str(record.get("key") or "")
                if not key:
                    raise BadRequest("bookmark-removed record without key")
                at = _moment(record.get("deleted_at")).isoformat()
                source = str(record.get("source") or "bookmark")
                fresh = _tombstone(conn, "bookmark", key, at, source)
                if record.get("cascade"):
                    for child in conn.execute(
                        "WITH RECURSIVE gone(key) AS ("
                        " SELECT key FROM bookmark WHERE parent_id = ?"
                        " UNION SELECT b.key FROM bookmark b JOIN gone g ON b.parent_id = g.key)"
                        " SELECT key FROM gone",
                        (key,),
                    ).fetchall():
                        _tombstone(conn, "bookmark", child["key"], at, source)
            elif kind == "visit-removed":
                # Firefox reports a page-level removal with no visit detail,
                # so the mark is keyed by canonical URL and hides every
                # visit of that page while the rows stay (d205: a mark, not
                # an erase).
                url = str(record.get("url") or "")
                if not url:
                    raise BadRequest("visit-removed record without url")
                fresh = _tombstone(
                    conn, "visit-removed", normalise(url),
                    _moment(record.get("deleted_at")).isoformat(),
                    str(record.get("source") or "local"),
                )
            elif kind == "history-cleared":
                # The user cleared history: a global mark. Expanding it into
                # per-row deletes would destroy an append-only archive on a
                # button press; the retention rule owns what it means.
                fresh = _tombstone(
                    conn, "history-cleared", "*",
                    _moment(record.get("deleted_at")).isoformat(),
                    str(record.get("source") or "local"),
                )
            else:
                raise BadRequest(f"unknown record kind: {kind!r}")
            if fresh:
                accepted += 1
            else:
                duplicates += 1

    if high is not None:
        with _write_lock, connect() as conn:
            conn.execute(
                "INSERT INTO stream(name, acked_high) VALUES(?,?)"
                " ON CONFLICT(name) DO UPDATE SET acked_high=excluded.acked_high",
                (stream, high),
            )
    return {
        "accepted": accepted,
        "duplicates": duplicates,
        "version": DAEMON_VERSION,
        "checkpoint": envelope.get("checkpoint"),
    }



# --- rules: the hister control plane ---------------------------------------


def load_rules(conn: sqlite3.Connection) -> dict[str, Any]:
    lists: dict[str, list[str]] = {"allow": [], "skip": [], "priority": [], "versioning": []}
    for row in conn.execute("SELECT name, patterns FROM rule"):
        if row["name"] in lists:
            lists[row["name"]] = [p for p in row["patterns"].split("\n") if p]
    return {**lists, "aliases": {}}


def save_rules(fields: dict[str, str]) -> None:
    """Store the form fields the extension posts; each is a space-separated list.

    The patterns are the producer's regex strings and are validated by compiling
    them with Python's re, a superset of the RE2 grammar upstream compiles, so a
    rule the hister extension accepted there compiles here.
    """
    updates: dict[str, str] = {}
    for name in ("allow", "skip", "priority", "versioning"):
        if name not in fields:
            continue
        found = fields[name].split()
        for pattern in found:
            try:
                re.compile(pattern)
            except re.error as exc:
                raise BadRequest(f"{name}: {exc}") from exc
        updates[name] = "\n".join(found)
    if not updates:
        return
    with _write_lock, connect() as conn:
        for name, patterns in updates.items():
            conn.execute(
                "INSERT INTO rule(name, patterns) VALUES(?,?)"
                " ON CONFLICT(name) DO UPDATE SET patterns=excluded.patterns",
                (name, patterns),
            )


def is_skipped(rules: dict[str, Any], norm_url: str) -> bool:
    """The server-side rule check docs/d205 requires of the capture path."""
    candidates = (norm_url, f"https://{norm_url}")
    skip = [re.compile(p) for p in rules["skip"]]
    if any(r.search(c) for r in skip for c in candidates):
        return True
    allow = [re.compile(p) for p in rules["allow"]]
    # An allow list is a whitelist: with patterns present, a URL matching none
    # is not captured at all (hister's semantics, and the point of the list).
    return bool(allow) and not any(r.search(c) for r in allow for c in candidates)



# --- the cold-shaped search index (docs/d205, Search) -----------------------

# WHY this shape and not SQLite FTS5: the index has to survive the move to
# Parquet. A term dictionary plus a posting list sorted by term is the shape
# ClickHouse's full-text index uses for slow storage, and a Parquet rewrite
# keeps it as row groups sorted by term. No positions are stored in v1, so a
# phrase is a candidate filter rather than an index lookup; that is the price of
# the cold-friendly row layout, and the results are deliberately naive.
FTS_SCHEMA = 1
FIELD_URL = 0
FIELD_TITLE = 1
FIELD_TEXT = 2
FIELD_WEIGHT = (3.0, 2.0, 1.0)
BM25_K1 = 1.2
BM25_B = 0.75
SEARCH_DEFAULT_LIMIT = 20
SEARCH_MAX_LIMIT = 100
SEARCH_MAX_TERMS = 16
TERM_PREFIX_LIMIT = 64

_TERM_RE = re.compile(r"\w+", re.UNICODE)
# Bleve's standard analyzer drops English stopwords; the same list keeps the
# posting list small without a stemmer (naive v1, docs/d205).
_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "but",
        "by",
        "for",
        "from",
        "has",
        "have",
        "he",
        "her",
        "his",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "me",
        "my",
        "no",
        "not",
        "of",
        "on",
        "or",
        "our",
        "she",
        "so",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "to",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "will",
        "with",
        "you",
        "your",
    }
)


def analyse(text: str) -> list[str]:
    return [
        term
        for term in (match.group(0).lower() for match in _TERM_RE.finditer(text or ""))
        if len(term) > 1 and term not in _STOPWORDS
    ]


def unindex_document(conn: sqlite3.Connection, owner: int, norm_url: str) -> None:
    terms = conn.execute(
        "SELECT DISTINCT term FROM posting WHERE owner=? AND norm_url=?",
        (owner, norm_url),
    ).fetchall()
    for row in terms:
        conn.execute(
            "UPDATE term_stats SET doc_freq = doc_freq - 1 WHERE term=?", (row["term"],)
        )
        conn.execute("DELETE FROM term_stats WHERE term=? AND doc_freq <= 0", (row["term"],))
    conn.execute("DELETE FROM posting WHERE owner=? AND norm_url=?", (owner, norm_url))
    conn.execute("DELETE FROM doc_length WHERE owner=? AND norm_url=?", (owner, norm_url))


def index_document(
    conn: sqlite3.Connection, owner: int, norm_url: str, url: str, title: str, text: str
) -> None:
    unindex_document(conn, owner, norm_url)
    counts: dict[str, Counter[int]] = defaultdict(Counter)
    for field, value in ((FIELD_URL, url), (FIELD_TITLE, title), (FIELD_TEXT, text)):
        for term in analyse(value):
            counts[term][field] += 1
    length = 0
    for term, tf_by_field in counts.items():
        for field, tf in tf_by_field.items():
            conn.execute(
                "INSERT INTO posting(term, owner, norm_url, field, tf) VALUES(?,?,?,?,?)",
                (term, owner, norm_url, field, tf),
            )
            length += tf
        conn.execute(
            "INSERT INTO term_stats(term, doc_freq) VALUES(?,1)"
            " ON CONFLICT(term) DO UPDATE SET doc_freq=doc_freq+1",
            (term,),
        )
    conn.execute(
        "INSERT INTO doc_length(owner, norm_url, length) VALUES(?,?,?)"
        " ON CONFLICT(owner, norm_url) DO UPDATE SET length=excluded.length",
        (owner, norm_url, length),
    )


def ensure_index(conn: sqlite3.Connection) -> None:
    """Build the postings when the store predates the index (docs/d205).

    The mark is a small integer rather than the wire schema: a changed index
    shape clears and rebuilds, while the producer keeps posting wire schema 1.
    """
    mark = conn.execute("SELECT value FROM meta WHERE key='fts_schema'").fetchone()
    try:
        current = int(mark["value"]) if mark is not None else -1
    except (TypeError, ValueError):
        current = -1
    if current == FTS_SCHEMA:
        return
    conn.execute("DELETE FROM posting")
    conn.execute("DELETE FROM term_stats")
    conn.execute("DELETE FROM doc_length")
    documents = conn.execute("SELECT owner,norm_url,url,title,text FROM document").fetchall()
    for row in documents:
        index_document(conn, row["owner"], row["norm_url"], row["url"], row["title"], row["text"])
    conn.execute(
        "INSERT INTO meta(key,value) VALUES('fts_schema',?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(FTS_SCHEMA),),
    )
    log(f"search index built over {len(documents)} document(s)")


_FILTER_NAMES = frozenset({"url", "domain", "site", "title", "label", "language", "type", "id"})


def parse_search_query(text: str, *, raw_text: str | None = None) -> dict[str, Any]:
    """Parse the small query dialect the delete path and search share.

    The dialect is deliberately not hister's full Bleve/query-string language:
    terms, quoted phrases, field:value filters, sort:, limit: and match-all are
    enough for the extension, the delete action and a web client, and every
    clause maps to one index or document column (docs/d205, Search).
    """
    query: dict[str, Any] = {
        "text": text if raw_text is None else raw_text,
        "terms": [],
        "phrases": [],
        "filters": [],
        "match_all": False,
        "sort": "",
        "limit": None,
        "offset": 0,
        "date_from": None,
        "date_to": None,
        "include_text": False,
        "include_html": False,
    }
    try:
        tokens = shlex.split(text or "")
    except ValueError as exc:
        raise BadRequest(f"invalid query: {exc}") from exc
    # The extension's older delete action posts a bare URL; treating it as an
    # exact url: filter keeps that client working without a special route.
    if len(tokens) == 1 and tokens[0].lower().startswith(("http://", "https://")):
        tokens = [f"url:{tokens[0]}"]
    for token in tokens:
        negate = token.startswith("-")
        body = token[1:] if negate else token
        if not body:
            continue
        if body == "*":
            query["match_all"] = True
            continue
        if ":" in body:
            name, value = body.split(":", 1)
            name = name.lower()
            if name == "sort":
                query["sort"] = value
                continue
            if name == "limit":
                try:
                    query["limit"] = int(value)
                except ValueError as exc:
                    raise BadRequest(f"bad limit {value!r}") from exc
                continue
            if name in _FILTER_NAMES and value:
                query["filters"].append((name, value, negate))
                continue
        if " " in body:
            phrase = body.strip()
            query["phrases"].append(phrase)
            for term in analyse(phrase):
                if term not in query["terms"]:
                    query["terms"].append(term)
            continue
        if body.endswith("*"):
            stem = "".join(analyse(body[:-1]))
            if stem and f"{stem}*" not in query["terms"]:
                query["terms"].append(f"{stem}*")
            continue
        for term in analyse(body):
            if term not in query["terms"]:
                query["terms"].append(term)
    query["terms"] = query["terms"][:SEARCH_MAX_TERMS]
    return query


def _as_scalar(value: Any) -> Any:
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _date_bound(value: Any, *, end: bool) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if text.isdigit():
        return int(text)
    try:
        day = dt.date.fromisoformat(text[:10])
    except ValueError:
        return None
    at = dt.datetime.combine(day, dt.time.max if end else dt.time.min, dt.UTC)
    return int(at.timestamp())


def search_query_from_params(params: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    raw_query = _as_scalar(params.get("query"))
    if isinstance(raw_query, str) and raw_query.strip():
        try:
            raw_query = json.loads(raw_query)
        except json.JSONDecodeError as exc:
            raise BadRequest(f"invalid query json: {exc}") from exc
    if isinstance(raw_query, dict):
        merged.update(raw_query)
    for key in (
        "text",
        "q",
        "match_all",
        "sort",
        "limit",
        "offset",
        "include_text",
        "include_html",
        "date_from",
        "date_to",
        "page_key",
    ):
        value = _as_scalar(params.get(key))
        if value is not None:
            merged[key] = value
    text = str(merged.get("text") or merged.get("q") or "")
    query = parse_search_query(text)
    if merged.get("match_all") in (True, 1, "1", "true", "True"):
        query["match_all"] = True
    if merged.get("sort"):
        query["sort"] = str(merged["sort"])
    page_key = merged.get("page_key")
    if isinstance(page_key, str) and page_key:
        try:
            decoded = json.loads(page_key)
            query["offset"] = int(decoded.get("offset", 0))
        except (json.JSONDecodeError, TypeError, ValueError):
            try:
                query["offset"] = int(page_key)
            except ValueError:
                raise BadRequest(f"bad page_key {page_key!r}") from None
    if merged.get("offset") not in (None, ""):
        try:
            query["offset"] = int(merged["offset"])
        except (TypeError, ValueError) as exc:
            raise BadRequest(f"bad offset {merged['offset']!r}") from exc
    limit = merged.get("limit")
    if limit in (None, ""):
        limit = query["limit"] if query["limit"] is not None else SEARCH_DEFAULT_LIMIT
    try:
        query["limit"] = max(1, min(SEARCH_MAX_LIMIT, int(limit)))
    except (TypeError, ValueError) as exc:
        raise BadRequest(f"bad limit {limit!r}") from exc
    query["offset"] = max(0, int(query["offset"]))
    query["date_from"] = _date_bound(merged.get("date_from"), end=False)
    query["date_to"] = _date_bound(merged.get("date_to"), end=True)
    query["include_text"] = merged.get("include_text") in (True, 1, "1", "true")
    query["include_html"] = merged.get("include_html") in (True, 1, "1", "true")
    return query


def _expand_query_term(conn: sqlite3.Connection, term: str) -> list[str]:
    if not term.endswith("*") or len(term) < 2:
        return [term]
    prefix = term[:-1]
    rows = conn.execute(
        "SELECT term FROM term_stats WHERE term >= ? AND term < ? ORDER BY term LIMIT ?",
        (prefix, f"{prefix}\uffff", TERM_PREFIX_LIMIT),
    ).fetchall()
    return [row["term"] for row in rows]


def _scored_urls(conn: sqlite3.Connection, query: dict[str, Any]) -> list[tuple[float, str]] | None:
    """Return (score, norm_url) or None for a match-all scan."""
    terms = query["terms"]
    if not terms:
        return None
    totals = conn.execute(
        "SELECT count(*) AS documents, avg(length) AS average FROM doc_length"
    ).fetchone()
    total = int(totals["documents"] or 0)
    average = float(totals["average"] or 1.0) or 1.0
    scores: dict[str, float] = defaultdict(float)
    matched: dict[str, set[int]] = defaultdict(set)
    for position, term in enumerate(terms):
        expanded = _expand_query_term(conn, term)
        if not expanded:
            return []
        for database_term in expanded:
            stat = conn.execute(
                "SELECT doc_freq FROM term_stats WHERE term=?", (database_term,)
            ).fetchone()
            frequency = int(stat["doc_freq"]) if stat is not None else 0
            if frequency == 0:
                continue
            idf = math.log(1.0 + (total - frequency + 0.5) / (frequency + 0.5))
            rows = conn.execute(
                "SELECT p.norm_url, p.field, p.tf, l.length FROM posting p"
                " JOIN doc_length l ON l.owner=p.owner AND l.norm_url=p.norm_url"
                " WHERE p.owner=0 AND p.term=?",
                (database_term,),
            ).fetchall()
            for row in rows:
                tf = float(row["tf"])
                length = float(row["length"]) or 1.0
                denominator = tf + BM25_K1 * (1.0 - BM25_B + BM25_B * length / average)
                scores[row["norm_url"]] += FIELD_WEIGHT[row["field"]] * idf * (
                    tf * (BM25_K1 + 1.0) / denominator
                )
                matched[row["norm_url"]].add(position)
    return [
        (score, url)
        for url, score in scores.items()
        if len(matched[url]) == len(terms)
    ]


def _documents_for_urls(
    conn: sqlite3.Connection, urls: list[str]
) -> dict[str, sqlite3.Row]:
    documents: dict[str, sqlite3.Row] = {}
    for start in range(0, len(urls), 500):
        chunk = urls[start : start + 500]
        placeholders = ",".join("?" for _ in chunk)
        for row in conn.execute(
            f"SELECT * FROM document WHERE owner=0 AND norm_url IN ({placeholders})", chunk
        ):
            documents[row["norm_url"]] = row
    return documents


def _domain(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _document_matches_filters(row: sqlite3.Row, query: dict[str, Any]) -> bool:
    url = row["url"] or ""
    norm = row["norm_url"] or ""
    for name, value, negate in query["filters"]:
        if name in ("url", "id"):
            wanted = value.removeprefix("0:")
            ok = normalise(wanted) == norm or wanted == url or f"0:{norm}" == value
        elif name in ("domain", "site"):
            ok = _domain(url) == value.lower().rstrip(".")
        elif name == "title":
            ok = value.lower() in (row["title"] or "").lower()
        elif name == "label":
            ok = (row["label"] or "").lower() == value.lower()
        elif name == "language":
            ok = (row["language"] or "").lower() == value.lower()
        else:  # type
            ok = str(row["type"]) == value
        if ok == negate:
            return False
    if query["date_from"] is not None and int(row["added"]) < query["date_from"]:
        return False
    if query["date_to"] is not None and int(row["added"]) > query["date_to"]:
        return False
    if query["phrases"]:
        haystack = f"{row['title'] or ''}\n{row['text'] or ''}".lower()
        if not all(phrase.lower() in haystack for phrase in query["phrases"]):
            return False
    return True


def matching_documents(
    conn: sqlite3.Connection, query: dict[str, Any]
) -> list[tuple[float, sqlite3.Row]]:
    scored = _scored_urls(conn, query)
    if scored is None:
        rows = conn.execute("SELECT * FROM document WHERE owner=0").fetchall()
        scored = [(0.0, row["norm_url"]) for row in rows]
    documents = _documents_for_urls(conn, [url for _, url in scored])
    priority: list[re.Pattern[str]] = []
    for pattern in query.get("priority", []):
        try:
            priority.append(re.compile(pattern))
        except re.error:
            # A rule stored before save_rules validated it must not take the
            # whole search down; it simply does not boost.
            continue
    matched: list[tuple[float, sqlite3.Row]] = []
    for score, norm in scored:
        row = documents.get(norm)
        if row is None:
            continue
        if not _document_matches_filters(row, query):
            continue
        if priority and any(
            pattern.search(row["url"] or "") or pattern.search(f"https://{norm}")
            for pattern in priority
        ):
            score += 100.0
        matched.append((score, row))
    if query["sort"] in ("date", "added"):
        matched.sort(key=lambda item: (int(item[1]["added"]), item[1]["norm_url"]))
    elif query["sort"] in ("-date", "-added"):
        matched.sort(key=lambda item: (-int(item[1]["added"]), item[1]["norm_url"]))
    else:
        matched.sort(key=lambda item: (-item[0], -int(item[1]["added"]), item[1]["norm_url"]))
    return matched


def _snippet(text: str, terms: list[str], size: int = 240) -> str:
    if not text:
        return ""
    lower = text.lower()
    positions = [lower.find(term) for term in terms if lower.find(term) >= 0]
    start = max(0, min(positions) - size // 3) if positions else 0
    return text[start : start + size]


def _document_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["norm_url"] if not row["owner"] else f"{row['owner']}:{row['norm_url']}",
        "url": row["url"],
        "domain": _domain(row["url"]) or (row["norm_url"].split("/")[0]),
        "html": row["html"] or "",
        "html_key": "",
        "title": row["title"] or "",
        "text": row["text"] or "",
        "favicon": row["favicon"] or "",
        "favicon_key": "",
        "score": 0,
        "added": row["added"],
        "updated": row["updated"],
        "type": row["type"],
        "language": row["language"] or "",
        "user_id": row["owner"],
        "label": row["label"] or "",
        "add_count": row["add_count"],
        "metadata": json.loads(row["metadata"]) if row["metadata"] else {},
        "processed": True,
    }


def hister_search(conn: sqlite3.Connection, params: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    query = search_query_from_params(params)
    query["priority"] = load_rules(conn)["priority"]
    matched = matching_documents(conn, query)
    total = len(matched)
    page = matched[query["offset"] : query["offset"] + query["limit"]]
    documents: list[dict[str, Any]] = []
    for score, row in page:
        document = _document_json(row)
        document["score"] = round(score, 6)
        if not query["include_text"]:
            document["text"] = _snippet(document["text"], query["terms"])
        if not query["include_html"]:
            document["html"] = ""
        documents.append(document)
    next_offset = query["offset"] + len(page)
    page_key = json.dumps({"offset": next_offset}) if next_offset < total else ""
    elapsed = int((time.monotonic() - started) * 1000)
    return {
        "total": total,
        "query": {
            "text": query["text"],
            "limit": query["limit"],
            "sort": query["sort"],
            "page_key": json.dumps({"offset": query["offset"]}) if query["offset"] else "",
            "match_all": query["match_all"],
            "include_html": query["include_html"],
            "include_text": query["include_text"],
            "semantic_enabled": False,
        },
        "documents": documents,
        "history": [],
        "search_duration": f"{elapsed}ms",
        "query_suggestion": "",
        "page_key": page_key,
        "semantic_enabled": False,
    }


# The worker is a separate process on purpose. The main daemon is the
# appender; a media parser is the one component whose input is an arbitrary
# file, so it gets its own interpreter, address-space/CPU/file limits and a
# wall-clock timeout. A container or bwrap wrapper is the stronger boundary for
# a host that accepts hostile PDFs; this is the boundary that ships here.
PDF_WORKER = r"""
import io
import resource
import sys


def limit(kind, value):
    try:
        resource.setrlimit(kind, (value, value))
    except (OSError, ValueError):
        pass


limit(resource.RLIMIT_CPU, 10)
limit(resource.RLIMIT_AS, 512 * 1024 * 1024)
limit(resource.RLIMIT_NOFILE, 64)
limit(resource.RLIMIT_FSIZE, 1024 * 1024)
limit(resource.RLIMIT_CORE, 0)

from pypdf import PdfReader

data = sys.stdin.buffer.read()
reader = PdfReader(io.BytesIO(data))
text = "\n\f\n".join((page.extract_text() or "") for page in reader.pages).strip()
sys.stdout.buffer.write(text.encode("utf-8"))
"""


def extract_pdf_text(data: bytes) -> str:
    """Extract PDF text out of process, under rlimits and a wall clock.

    The dependency is pypdf (BSD) and it is declared in the PEP 723 header, so
    this stays a single-file tool (docs/d113). Upstream fails the capture when a
    PDF has no extractable text; the same 5xx is returned here rather than
    storing a document the search index cannot see.
    """
    try:
        completed = subprocess.run(
            PDF_RUNNER + [sys.executable, "-I", "-c", PDF_WORKER],
            input=data,
            capture_output=True,
            timeout=PDF_TIMEOUT,
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "LANG": "C.UTF-8",
            },
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("pdf extraction timed out") from exc
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()
        last = detail.splitlines()[-1] if detail else "worker exited nonzero"
        raise RuntimeError(last)
    text = completed.stdout.decode("utf-8", "replace")
    if len(text.encode("utf-8")) > PDF_MAX_TEXT:
        raise RuntimeError("pdf text exceeds the configured ceiling")
    return text


# --- the Promnesia face (pinned from promnesia's server.py) -----------------

# A removed page hides its visits, but the presence row survives: "have I seen
# this URL" stays true for an archive, and only the visit list answers a
# deletion (docs/d204's append-only rule, docs/d205's pending erasure).
_VISIT_SELECT = (
    "SELECT visit.*, COALESCE(NULLIF(visit.locator_title, ''), page_title.title)"
    " AS effective_title FROM visit LEFT JOIN page_title"
    " ON page_title.norm_url = visit.norm_url"
)

_VISIBLE_VISIT = (
    " AND NOT EXISTS (SELECT 1 FROM tombstone t"
    " WHERE t.kind='visit-removed' AND t.key = visit.norm_url)"
    # A global clear hides every visit up to its timestamp, while the rows and
    # the presence mark stay: the archive still knows the page was seen
    # (docs/d204's mark-not-erase rule). julianday() compares the instants, so
    # an older row stored with a numeric offset is not hidden by lexical
    # accident.
    " AND NOT EXISTS (SELECT 1 FROM tombstone t"
    " WHERE t.kind='history-cleared' AND t.key = '*'"
    " AND julianday(visit.dt) <= julianday(t.deleted_at))"
)


def _visit_json(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    title = row["effective_title"] if "effective_title" in keys else row["locator_title"]
    return {
        "dt": _promnesia_dt(_moment(row["dt"])),
        "src": row["src"] or "unnamed",
        "context": row["context"],
        "duration": row["duration"],
        "locator": {"title": title, "href": row["locator_href"]},
        "original_url": row["orig_url"],
        "normalised_url": row["norm_url"],
    }


def _visits_envelope(url: str, norm: str, rows: list[sqlite3.Row]) -> dict[str, Any]:
    return {"original_url": url, "normalised_url": norm, "visits": [_visit_json(r) for r in rows]}


def promnesia_visits(url: str) -> dict[str, Any]:
    norm = normalise(url) or url.strip()
    with connect() as conn:
        rows = conn.execute(
            _VISIT_SELECT
            + " WHERE (visit.norm_url = ? OR (visit.context IS NOT NULL"
            " AND substr(visit.norm_url, 1, ?) = ? AND visit.norm_url != ?))"
            + _VISIBLE_VISIT
            + " ORDER BY julianday(visit.dt)",
            (norm, len(norm), norm, norm),
        ).fetchall()
    return _visits_envelope(url, norm, rows)


def _like_escape(value: str) -> str:
    """Escape LIKE metacharacters: a literal search for 100% is not a wildcard."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def promnesia_search(text: str) -> dict[str, Any]:
    needle = f"%{_like_escape(text.strip())}%"
    with connect() as conn:
        rows = conn.execute(
            _VISIT_SELECT
            + " WHERE (visit.norm_url LIKE ? ESCAPE '\\'"
            " OR visit.orig_url LIKE ? ESCAPE '\\'"
            " OR visit.context LIKE ? ESCAPE '\\'"
            " OR COALESCE(NULLIF(visit.locator_title, ''), page_title.title)"
            " LIKE ? ESCAPE '\\')"
            + _VISIBLE_VISIT
            + " ORDER BY julianday(visit.dt) DESC LIMIT 500",
            (needle, needle, needle, needle),
        ).fetchall()
    return _visits_envelope(text, text.strip(), rows)


def promnesia_search_around(timestamp: float) -> dict[str, Any]:
    centre = dt.datetime.fromtimestamp(float(timestamp), dt.UTC)
    start = (centre - dt.timedelta(hours=3)).isoformat()
    end = (centre + dt.timedelta(minutes=2)).isoformat()
    with connect() as conn:
        rows = conn.execute(
            _VISIT_SELECT
            + " WHERE julianday(visit.dt) BETWEEN julianday(?) AND julianday(?)"
            + _VISIBLE_VISIT
            + " ORDER BY julianday(visit.dt)",
            (start, end),
        ).fetchall()
    # Upstream answers with this literal placeholder URL and its extension
    # ignores the envelope's URL fields here, so mirroring keeps a stock
    # client's logs identical.
    return _visits_envelope("http://dummy.org", "http://dummy.org", rows)


def promnesia_visited(urls: list[str]) -> list[dict[str, Any] | None]:
    norms = [normalise(u) for u in urls]
    answers: dict[str, dict[str, Any]] = {}
    with connect() as conn:
        for norm in set(norms):
            row = conn.execute("SELECT * FROM presence WHERE norm_url = ?", (norm,)).fetchone()
            if row is not None:
                answers[norm] = _visit_json(row)
                continue
            doc = conn.execute(
                "SELECT * FROM document WHERE norm_url = ? ORDER BY owner LIMIT 1", (norm,)
            ).fetchone()
            if doc is None:
                continue
            # A captured page with no visit row is still "seen": the hister
            # extension posts content and the slurper may lag behind it.
            answers[norm] = {
                "dt": _promnesia_dt(_moment(doc["added"])),
                "src": "hister",
                "context": doc["title"],
                "duration": None,
                "locator": {"title": doc["title"], "href": doc["url"]},
                "original_url": doc["url"],
                "normalised_url": norm,
            }
    return [answers.get(norm) for norm in norms]


def promnesia_status() -> dict[str, Any]:
    stats: dict[str, Any]
    try:
        with connect() as conn:
            stats = {
                "total_visits": conn.execute("SELECT count(*) AS n FROM visit").fetchone()["n"],
                "documents": conn.execute("SELECT count(*) AS n FROM document").fetchone()["n"],
                "tombstones": conn.execute("SELECT count(*) AS n FROM tombstone").fetchone()["n"],
            }
    except sqlite3.Error as exc:
        # /status answers even when the store is broken (docs/d205); the SQL
        # words stay in the log, the response carries only the failure.
        log("ERROR /status store: " + repr(exc))
        stats = {"ERROR": "store error"}
    return {"version": DAEMON_VERSION, "db": DB_PATH, "stats": stats}


# --- the hister face -------------------------------------------------------


def hister_config() -> dict[str, Any]:
    return {
        "version": DAEMON_VERSION,
        "baseUrl": "/",
        "basePath": "",
        "wsUrl": "",
        "title": "hister (datalakehouse)",
        "subtitle": "",
        "colorScheme": "auto",
        "searchUrl": "",
        "openResultsOnNewTab": True,
        "showSuggestions": False,
        "hotkeys": {},
        "authMode": "token" if TOKEN else "none",
        "authenticated": True,
        "public": False,
        "canWrite": True,
        "canConfigure": False,
        "historyEnabled": True,
        "userId": 0,
        # docs/d205: semantic search is accepted on the wire and reported off.
        "semanticEnabled": False,
        "maxBatchBodyBytes": 8 * 1024 * 1024,
        "search": {"semantic": False},
    }


def hister_document(url: str, owner: int = 0) -> dict[str, Any] | None:
    norm = normalise(url)
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM document WHERE owner = ? AND norm_url = ?", (owner, norm)
        ).fetchone()
    if row is None:
        return None
    return _document_json(row)


def _int_value(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _metadata_json(value: Any) -> str | None:
    """Normalise the producer's metadata to the object JSON upstream stores.

    The stock extension sends a JSON *string* (its content script serialises
    meta tags), while a hand-written client sends an object. Both are stored in
    the one object form so /api/document and search return the same shape.
    """
    if value in (None, ""):
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = {"raw": value}
    return json.dumps(value, separators=(",", ":"))


def hister_add(payload: dict[str, Any]) -> int:
    """Upsert one captured document; returns the HTTP status the extension reads."""
    url = str(payload.get("url") or "")
    if not url:
        raise BadRequest("missing url")
    norm = normalise(url)
    with connect() as conn:
        if is_skipped(load_rules(conn), norm):
            return 406
    if payload.get("sensitive"):
        # docs/d205 asks for 422 on sensitive content, but extraction is the
        # producer's job, so only the producer's own verdict can raise it.
        return 422
    now = int(time.time())
    metadata = _metadata_json(payload.get("metadata"))
    with _write_lock, connect() as conn:
        existing = conn.execute(
            "SELECT added, add_count FROM document WHERE owner = 0 AND norm_url = ?", (norm,)
        ).fetchone()
        added = int(existing["added"]) if existing else now
        add_count = int(existing["add_count"]) + 1 if existing else 1
        conn.execute(
            "INSERT INTO document(owner, norm_url, url, title, text, html, favicon, language,"
            " label, added, updated, add_count, type, metadata)"
            " VALUES(0,?,?,?,?,?,?,?,?,?,?,?,?,?)"
            # A re-add that carries only the URL (the extension's label and
            # permission paths do) must not erase the stored body, so a null or
            # empty field keeps the stored value; only real content replaces it.
            " ON CONFLICT(owner, norm_url) DO UPDATE SET"
            " url=excluded.url,"
            " title=COALESCE(NULLIF(excluded.title,''), document.title),"
            " text=COALESCE(NULLIF(excluded.text,''), document.text),"
            " html=COALESCE(NULLIF(excluded.html,''), document.html),"
            " favicon=COALESCE(NULLIF(excluded.favicon,''), document.favicon),"
            " language=COALESCE(NULLIF(excluded.language,''), document.language),"
            " label=COALESCE(NULLIF(excluded.label,''), document.label),"
            " updated=excluded.updated, add_count=excluded.add_count, type=excluded.type,"
            " metadata=COALESCE(excluded.metadata, document.metadata)",
            (
                norm,
                url,
                payload.get("title"),
                payload.get("text"),
                payload.get("html"),
                payload.get("favicon"),
                payload.get("language"),
                payload.get("label"),
                added,
                now,
                add_count,
                _int_value(payload.get("type"), 0),
                metadata,
            ),
        )
        # The stored row is the index's input, not the request: a metadata-only
        # re-add keeps the old body and its postings must stay identical.
        stored = conn.execute(
            "SELECT * FROM document WHERE owner=0 AND norm_url=?", (norm,)
        ).fetchone()
        index_document(conn, 0, norm, stored["url"], stored["title"], stored["text"])
        conn.execute(
            "INSERT OR IGNORE INTO presence"
            "(norm_url, orig_url, dt, src, context, duration, locator_title, locator_href)"
            " VALUES(?,?,?,?,?,NULL,?,?)",
            (
                norm,
                url,
                dt.datetime.now(dt.UTC).isoformat(),
                "hister",
                payload.get("title"),
                payload.get("title"),
                url,
            ),
        )
    return 201


def hister_label(url: str, label: str) -> bool:
    with _write_lock, connect() as conn:
        cursor = conn.execute(
            "UPDATE document SET label = ? WHERE owner = 0 AND norm_url = ?",
            (label, normalise(url)),
        )
        return cursor.rowcount > 0


def hister_delete(query: str, dry_run: bool) -> dict[str, Any]:
    """Delete documents matching the same query dialect as /search.

    Upstream's /api/delete is a query, not a URL (the extension sends
    url:"..." and domain:...), so this shares parse_search_query and
    matching_documents. A document is a capture, not a visit: the visit rows and
    the presence mark stay, and only the search history upstream also removes
    (its click table) is cleared (docs/d205, Search).
    """
    parsed = parse_search_query(query)
    if not (parsed["terms"] or parsed["filters"] or parsed["phrases"] or parsed["match_all"]):
        raise BadRequest("empty delete query")
    parsed["priority"] = []
    with _write_lock, connect() as conn:
        matched = matching_documents(conn, parsed)
        if dry_run:
            return {"matched": len(matched)}
        for _, row in matched:
            unindex_document(conn, 0, row["norm_url"])
            conn.execute(
                "DELETE FROM click WHERE url=? OR url=?",
                (row["url"], f"https://{row['norm_url']}"),
            )
            conn.execute(
                "DELETE FROM document WHERE owner=0 AND norm_url=?", (row["norm_url"],)
            )
    return {"deleted": len(matched)}


def hister_history(payload: dict[str, Any]) -> None:
    row = payload.get("resultData") or payload
    url = str(row.get("url") or "")
    if not url:
        raise BadRequest("history row without url")
    with _write_lock, connect() as conn:
        conn.execute(
            "INSERT INTO click(url, title, query, added) VALUES(?,?,?,?)",
            (url, row.get("title"), row.get("query"), int(time.time())),
        )


# --- HTTP plumbing ---------------------------------------------------------

# Chrome and Firefox exempt an extension's background fetch from CORS; Safari
# preflights every one. The headers hister's own server sends are answered here
# so the stock extension needs no different server on either browser.
_EXTENSION_ORIGINS = ("moz-extension://", "safari-web-extension://", "chrome-extension://")
_ALLOW_HEADERS = "Content-Type, X-Access-Token, X-Hister-Public, X-CSRF-Token, Authorization"

# A static key gates the write faces only. The stock Promnesia extension has no
# field to carry a key and the default bind is loopback, so gating its reads
# would lock the sidebar out of its own data; the operator who binds wider takes
# the key as the network secret (docs/d204, docs/d205).
_WRITE_PATHS = (
    "/ingest/slurp",
    "/api/add",
    "/api/delete",
    "/api/label",
    "/api/rules",
    "/api/history",
)


class PayloadTooLarge(BadRequest):
    """A request body or field count above the configured ceiling."""


class Handler(BaseHTTPRequestHandler):
    """The shared machinery; SURFACE names the protocol the listener answers."""

    protocol_version = "HTTP/1.1"
    # A slow or stalled client must not pin a handler thread forever; the stock
    # extensions finish in milliseconds, so 30 seconds is already generous.
    timeout = 30
    SURFACE = ""

    def log_message(self, format: str, *args: Any) -> None:
        # The stdlib logger writes an unstructured line per request; _dispatch
        # emits one line with the status and the duration instead, so this is
        # silenced rather than duplicated.
        return

    def _send(self, status: int, payload: Any = None, *, problem: bool = False) -> None:
        self._status = status
        if getattr(self, "_responded", False):
            return
        self._responded = True
        body = b"" if payload is None else json.dumps(
            payload, separators=(",", ":"), allow_nan=False
        ).encode()
        self.send_response(status)
        if body:
            self.send_header(
                "content-type",
                "application/problem+json" if problem else "application/json",
            )
        self.send_header("content-length", str(len(body)))
        self._cors()
        self.end_headers()
        if body and self.command != "HEAD":
            try:
                self.wfile.write(body)
            except OSError:
                # The client disconnected; the request is over, not a server
                # failure worth a second response or a traceback.
                pass

    def _problem(self, status: int, slug: str, title: str, detail: str) -> None:
        self._send(
            status,
            {
                "type": PROBLEM_BASE + slug,
                "title": title,
                "status": status,
                "detail": detail,
            },
            problem=True,
        )

    def _cors(self) -> None:
        origin = self.headers.get("Origin") or ""
        if not (origin and origin.startswith(_EXTENSION_ORIGINS)):
            return
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            self.headers.get("Access-Control-Request-Headers") or _ALLOW_HEADERS,
        )
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")

    def _body(self) -> bytes:
        raw = self.headers.get("content-length")
        if raw is None:
            return b""
        try:
            length = int(raw)
        except ValueError as exc:
            raise BadRequest("invalid content-length") from exc
        if length < 0:
            raise BadRequest("negative content-length")
        if length > MAX_BODY:
            raise PayloadTooLarge(f"body exceeds {MAX_BODY} bytes")
        return self.rfile.read(length) if length else b""

    def _json(self) -> dict[str, Any]:
        raw = self._body()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw, parse_constant=self._reject_constant)
        except ValueError as exc:
            # JSONDecodeError and a rejected NaN/Infinity are both request
            # errors: the parser accepts those constants by default, and a
            # non-finite timestamp then fails deep in the store instead.
            raise BadRequest(f"invalid json: {exc}") from exc
        if not isinstance(parsed, dict):
            raise BadRequest("body must be an object")
        return parsed

    @staticmethod
    def _reject_constant(value: str) -> Any:
        raise ValueError(f"non-finite number {value} is not JSON")

    def _form(self) -> dict[str, str]:
        try:
            text = self._body().decode()
            parsed = urllib.parse.parse_qs(
                text, keep_blank_values=True, max_num_fields=MAX_FORM_FIELDS
            )
        except (UnicodeDecodeError, ValueError) as exc:
            raise BadRequest(f"invalid form body: {exc}") from exc
        return {k: v[0] for k, v in parsed.items()}

    def _query(self) -> dict[str, list[str]]:
        try:
            return urllib.parse.parse_qs(
                urllib.parse.urlsplit(self.path).query,
                keep_blank_values=True,
                max_num_fields=MAX_FORM_FIELDS,
            )
        except ValueError as exc:
            raise BadRequest(f"invalid query string: {exc}") from exc

    def _path(self) -> str:
        return urllib.parse.urlsplit(self.path).path.rstrip("/") or "/"

    def _authorised(self) -> bool:
        # A preflight never carries the key: the browser sends it on the real
        # request, so requiring it here would fail every cross-origin POST.
        if not TOKEN or self.command != "POST" or not self._path().startswith(_WRITE_PATHS):
            return True
        header = self.headers.get("X-Access-Token") or ""
        if not header:
            auth = self.headers.get("Authorization") or ""
            header = auth[7:] if auth.lower().startswith("bearer ") else ""
        # compare_digest keeps the comparison independent of the matching
        # prefix; plain == leaks the position of the first wrong byte to anyone
        # measuring a wide bind.
        return hmac.compare_digest(header.encode("utf-8"), TOKEN.encode("utf-8"))

    def _dispatch(self) -> None:
        started = time.monotonic()
        path = self._path()
        self._status = 0
        self._responded = False
        try:
            if self.command == "OPTIONS":
                self._send(204)
            elif not self._authorised():
                self._problem(401, "unauthorized", "Unauthorized", "missing or bad token")
            else:
                self._route(path)
        except PayloadTooLarge as exc:
            self._problem(413, "payload-too-large", "Payload too large", str(exc))
        except BadRequest as exc:
            self._problem(400, "interface-error", "Interface error", str(exc))
        except sqlite3.Error as exc:
            # The store's words stay in the log: a table or SQL fragment in a
            # response body is a schema leak (the sbex error rule).
            log("ERROR " + self.command + " " + path + " store: " + repr(exc))
            self._problem(500, "store-error", "Store error", "the store could not answer")
        except Exception:  # noqa: BLE001 - request boundary: a handler bug is a 500, not a crash
            log(
                "ERROR " + self.command + " " + path + " "
                + traceback.format_exc().replace("\n", " | ")
            )
            self._problem(500, "internal-error", "Internal error", "the request failed")
        finally:
            # Observability (docs/d205): one line per request, and the timing is
            # what tells an operator whether the visited check kept its budget.
            elapsed = int((time.monotonic() - started) * 1000)
            log(f"{self.command} {path} {self._status} {elapsed}ms")

    def _route(self, path: str) -> None:
        # Each listener answers only its own protocol's paths: a hister path on
        # the Promnesia port is a misconfigured client, and answering it there
        # would hide the misconfiguration behind a working-looking response.
        if self.SURFACE == "promnesia":
            if path == "/status":
                self._send(200, promnesia_status())
            elif path == "/visited":
                self._send(200, promnesia_visited(self._visited_urls()))
            elif path == "/visits":
                self._send(200, promnesia_visits(self._url_param()))
            elif path == "/search":
                self._promnesia_or_hister_search()
            elif path == "/search_around":
                self._search_around()
            else:
                self._problem(
                    404, "not-found", "Not found", f"unknown path on {self.SURFACE}: {path}"
                )
            return
        if path == "/ingest/slurp":
            self._ingest()
        elif path == "/search":
            self._hister_search()
        elif path.startswith("/api/"):
            self._hister(path)
        else:
            self._problem(
                404, "not-found", "Not found", f"unknown path on {self.SURFACE}: {path}"
            )

    def _hister_search(self) -> None:
        params = self._json() if self.command == "POST" else self._query()
        with connect() as conn:
            self._send(200, hister_search(conn, params))

    def _promnesia_or_hister_search(self) -> None:
        body = self._json() if self.command == "POST" else {
            k: v[0] for k, v in self._query().items()
        }
        # The path is shared (docs/d205): a url parameter is Promnesia's visit
        # search, everything else is the hister query dialect. Now that the
        # postings exist there is no reason to refuse the second shape.
        if "url" in body:
            url = _as_scalar(body.get("url"))
            self._send(200, promnesia_search(str(url if isinstance(url, str) else "")))
            return
        with connect() as conn:
            self._send(200, hister_search(conn, body))

    def _search_around(self) -> None:
        body = self._json() if self.command == "POST" else self._query()
        timestamp = body.get("timestamp")
        if isinstance(timestamp, list):
            timestamp = timestamp[0] if timestamp else None
        if timestamp in (None, ""):
            raise BadRequest("missing timestamp")
        try:
            centre = float(timestamp)
        except (TypeError, ValueError) as exc:
            raise BadRequest(f"bad timestamp: {timestamp!r}") from exc
        if not math.isfinite(centre):
            raise BadRequest("timestamp must be finite")
        self._send(200, promnesia_search_around(centre))

    def _ingest(self) -> None:
        # A schema the daemon does not speak is a 409 and a permanent reject on
        # the producer's side: a retry of the same bytes cannot succeed, so the
        # producer must be upgraded rather than the batch re-sent.
        payload = self._json()
        try:
            self._send(200, ingest_batch(payload))
        except BadRequest as exc:
            if "unsupported schema" not in str(exc):
                raise
            self._problem(409, "unsupported-schema", "Unsupported schema", str(exc))

    def _hister(self, path: str) -> None:
        if path == "/api/config":
            self._send(200, hister_config())
        elif path == "/api/profile":
            # Upstream's single-user mode answers 200 with no body (its
            # UserHandling branch is off); the extension treats that as user 0,
            # exactly as it did before. Returning a synthetic user_id made the
            # extension believe the server had accounts.
            self._send(200)
        elif path == "/api/rules":
            if self.command == "POST":
                save_rules(self._form())
                self._send(200)
                return
            with connect() as conn:
                self._send(200, load_rules(conn))
        elif path == "/api/document":
            url = (self._query().get("url") or [""])[0]
            if not url:
                raise BadRequest("missing url")
            document = hister_document(url)
            if document is None:
                # HEAD is the extension's "already indexed" probe, and 200/404 is
                # the whole contract; a GET answer carries the document.
                self._problem(404, "not-found", "Not found", "document not found")
                return
            self._send(200, None if self.command == "HEAD" else document)
        elif path == "/api/add":
            if self.command != "POST":
                self._problem(405, "method-not-allowed", "Method not allowed", "POST only")
                return
            if "json" in (self.headers.get("content-type") or ""):
                payload = self._json()
            else:
                payload = self._form()
            self._send(hister_add(payload))
        elif path == "/api/add_pdf":
            payload = self._json()
            document = payload.get("document")
            if not isinstance(document, dict):
                raise BadRequest("missing document field")
            pdf = payload.get("pdf") or ""
            if not isinstance(pdf, str) or not pdf:
                raise BadRequest("missing pdf field")
            # Check the encoded length before decoding: b64decode of a
            # declared-gigabyte string allocates the whole payload first.
            if len(pdf) > (MAX_PDF_BYTES * 4 // 3) + 8:
                raise PayloadTooLarge(f"pdf exceeds {MAX_PDF_BYTES} bytes")
            try:
                data = base64.b64decode(pdf, validate=True)
            except (ValueError, TypeError) as exc:
                raise BadRequest(f"pdf must be base64-encoded: {exc}") from exc
            if len(data) > MAX_PDF_BYTES:
                raise PayloadTooLarge(f"pdf exceeds {MAX_PDF_BYTES} bytes")
            try:
                text = extract_pdf_text(data)
            except Exception as exc:  # noqa: BLE001 - a malformed PDF is a request error, not a crash
                # Upstream fails the capture rather than storing a document the
                # index cannot see; the same 5xx keeps the extension's error
                # badge meaningful. The parser's words stay in the log: a
                # response body is not the place for a library trace.
                log("ERROR /api/add_pdf extraction: " + repr(exc))
                self._problem(
                    500, "extraction-error", "Extraction failed", "pdf text extraction failed"
                )
                return
            if not text:
                self._problem(
                    500,
                    "extraction-error",
                    "Extraction failed",
                    "pdf contains no extractable text",
                )
                return
            raw_metadata = document.get("metadata")
            submitted: Any = raw_metadata
            if isinstance(raw_metadata, str):
                try:
                    submitted = json.loads(raw_metadata)
                except json.JSONDecodeError:
                    submitted = {"raw": raw_metadata}
            metadata: dict[str, Any] = (
                dict(submitted) if isinstance(submitted, dict) else {}
            )
            metadata["pdf_bytes"] = len(data)
            self._send(
                hister_add(
                    {**document, "type": 2, "text": text, "html": "", "metadata": metadata}
                )
            )
        elif path == "/api/label":
            payload = self._json()
            url = str(payload.get("url") or "")
            if not url:
                raise BadRequest("missing url")
            if not hister_label(url, str(payload.get("label") or "")):
                self._problem(404, "not-found", "Not found", "document not found")
                return
            self._send(200, {"ok": True})
        elif path == "/api/delete":
            payload = self._json()
            query = str(payload.get("query") or "")
            if not query:
                raise BadRequest("missing query")
            self._send(200, hister_delete(query, bool(payload.get("dry_run"))))
        elif path == "/api/history":
            if self.command != "POST":
                self._problem(405, "method-not-allowed", "Method not allowed", "POST only")
                return
            hister_history(self._json())
            self._send(201)
        elif path in ("/api/versions", "/api/facets"):
            # Upstream serves both, but the hister extension calls neither
            # (docs/d205's research item), and the web UI is out of scope, so the
            # deferral is answered instead of a guessed model.
            self._problem(
                501, "not-implemented", "Not implemented", f"{path} is not built (docs/d205)"
            )
        else:
            self._problem(404, "not-found", "Not found", "unknown path")

    def _url_param(self) -> str:
        if self.command == "POST":
            value = self._json().get("url")
            if value is not None:
                return value[0] if isinstance(value, list) else str(value)
        return (self._query().get("url") or [""])[0]

    def _visited_urls(self) -> list[str]:
        if self.command == "POST":
            urls = self._json().get("urls") or []
            if not isinstance(urls, list):
                raise BadRequest("urls must be an array")
            values = [str(u) for u in urls]
        else:
            params = self._query()
            values = [str(u) for u in params.get("urls", []) + params.get("url", [])]
        if len(values) > MAX_VISITED_URLS:
            raise PayloadTooLarge(f"more than {MAX_VISITED_URLS} urls")
        return values

    # Every method the surface uses goes through one dispatcher, so logging,
    # auth, CORS and error mapping have one home.
    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def do_OPTIONS(self) -> None:
        self._dispatch()


class HisterHandler(Handler):
    SURFACE = "hister"


class PromnesiaHandler(Handler):
    SURFACE = "promnesia"


def parse_addr(addr: str, *, env: str) -> tuple[str, int]:
    sep = addr.rfind(":")
    try:
        if sep <= 0:
            raise ValueError("no port")
        port = int(addr[sep + 1 :])
        if not 0 <= port <= 65_535:
            raise ValueError("port outside 0-65535")
        return addr[:sep].strip("[]"), port
    except ValueError as exc:
        # A bad address is a startup failure with the env var's name in it: the
        # operator reads which variable to fix instead of a traceback.
        raise SystemExit(f"browse-daemon: bad {env} {addr!r} (want host:port): {exc}") from exc


def _is_loopback(host: str) -> bool:
    return host in ("127.0.0.1", "::1", "localhost", "[::1]")


def check_bind(addr: str, env: str) -> None:
    """Refuse a wide bind with no key; warn when only the writes are gated.

    A non-loopback bind with an empty BROWSE_TOKEN exposes the write faces to
    the network, and a non-loopback bind with a key still exposes every read
    because the stock Promnesia client cannot carry one. The first case is a
    startup failure; the second is the operator's explicit choice and is
    reported once.
    """
    host, _ = parse_addr(addr, env=env)
    if _is_loopback(host):
        return
    if not TOKEN:
        raise SystemExit(
            "browse-daemon: " + env + "=" + repr(addr)
            + " binds a non-loopback address without BROWSE_TOKEN; refusing to"
            " expose unauthenticated writes"
        )
    log("warning: " + env + " binds " + host + "; reads stay unauthenticated")


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with a hard cap on concurrent handler threads."""

    daemon_threads = True
    request_queue_size = 64

    def __init__(self, server_address: tuple[str, int], handler: type[Handler]) -> None:
        super().__init__(server_address, handler)
        self._slots = threading.BoundedSemaphore(MAX_WORKERS)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._slots.acquire(blocking=False):
            line_break = bytes((13, 10))
            try:
                request.sendall(
                    b"HTTP/1.1 503 Service Unavailable" + line_break
                    + b"content-length: 0" + line_break
                    + b"connection: close" + line_break + line_break
                )
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def serve(handler: type[Handler], addr: str, env: str) -> BoundedThreadingHTTPServer:
    host, port = parse_addr(addr, env=env)
    server = BoundedThreadingHTTPServer((host, port), handler)
    log(f"{handler.SURFACE} listening on http://{host}:{port}")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main(argv: list[str]) -> int:
    if any(a in ("-h", "--help") for a in argv):
        print("usage: browse-daemon.sh [--print-config]")
        return 0
    if "--print-config" in argv:
        print(
            json.dumps(
                {
                    "hister": HISTER_ADDR,
                    "promnesia": PROMNESIA_ADDR,
                    "db": DB_PATH,
                    "token": bool(TOKEN),
                    "pdf_runner": bool(PDF_RUNNER),
                    "pdf_timeout_s": PDF_TIMEOUT,
                },
                indent=2,
            )
        )
        return 0
    os.umask(0o077)
    check_bind(HISTER_ADDR, "BROWSE_HISTER_ADDR")
    check_bind(PROMNESIA_ADDR, "BROWSE_PROMNESIA_ADDR")
    init_store()
    servers = [
        serve(HisterHandler, HISTER_ADDR, "BROWSE_HISTER_ADDR"),
        serve(PromnesiaHandler, PROMNESIA_ADDR, "BROWSE_PROMNESIA_ADDR"),
    ]
    log(f"db={DB_PATH} token={'yes' if TOKEN else 'no'}")
    try:
        # The main thread parks on the first listener's loop; the second runs
        # beside it, so one Ctrl-C or SIGTERM ends both.
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
