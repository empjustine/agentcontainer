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
import io
import json
import math
import os
import re
import shlex
import sqlite3
import sys
import threading
import time
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
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with _write_lock, connect() as conn:
        conn.executescript(SCHEMA)
        ensure_index(conn)


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
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.UTC)


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
    conn.execute(
        "UPDATE visit SET locator_title = ? WHERE norm_url = ? AND"
        " (locator_title IS NULL OR locator_title = '')",
        (title, norm),
    )
    return True


def _bookmark(conn: sqlite3.Connection, src: str, record: dict[str, Any]) -> bool:
    key = str(record.get("key") or "")
    if not key:
        raise BadRequest("bookmark record without key")
    url = record.get("url")
    node_type = str(record.get("node_type") or "bookmark")
    # A folder has no URL and therefore no presence: the bookmark is context,
    # not a visit (docs/d205's bookmark row).
    norm = normalise(str(url)) if url else None
    at = record.get("date_added")
    added_ms = int(at) if isinstance(at, (int, float)) else None
    modified = record.get("date_modified")
    modified_ms = int(modified) if isinstance(modified, (int, float)) else None
    cursor = conn.execute(
        "INSERT OR IGNORE INTO bookmark(src, key, norm_url, orig_url, title, parent_id,"
        " position, node_type, date_added, date_modified)"
        " VALUES(?,?,?,?,?,?,?,?,?,?)",
        (
            src,
            key,
            norm,
            str(url) if url else None,
            record.get("title"),
            record.get("parent_id"),
            record.get("position"),
            node_type,
            added_ms,
            modified_ms,
        ),
    )
    if cursor.rowcount == 0:
        return False
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
        conn.execute(
            "UPDATE visit SET locator_title=?"
            " WHERE norm_url=? AND (locator_title IS NULL OR locator_title = '')",
            (title, norm),
        )
    return True


def _tombstone(
    conn: sqlite3.Connection, kind: str, key: str, at: str, source: str
) -> bool:
    cursor = conn.execute(
        "INSERT OR IGNORE INTO tombstone(kind, key, deleted_at, source) VALUES(?,?,?,?)",
        (kind, key, at, source),
    )
    return cursor.rowcount > 0


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


def extract_pdf_text(data: bytes) -> str:
    """Extract the text the upstream server indexes for /api/add_pdf.

    The dependency is pypdf (BSD) and it is declared in the PEP 723 header, so
    this stays a single-file tool (docs/d113). Upstream fails the capture when a
    PDF has no extractable text; the same 5xx is returned here rather than
    storing a document the search index cannot see.
    """
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return "\n\f\n".join((page.extract_text() or "") for page in reader.pages).strip()


# --- the Promnesia face (pinned from promnesia's server.py) -----------------

# A removed page hides its visits, but the presence row survives: "have I seen
# this URL" stays true for an archive, and only the visit list answers a
# deletion (docs/d204's append-only rule, docs/d205's pending erasure).
_VISIBLE_VISIT = (
    " AND NOT EXISTS (SELECT 1 FROM tombstone t"
    " WHERE t.kind='visit-removed' AND t.key = visit.norm_url)"
)


def _visit_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "dt": _promnesia_dt(_moment(row["dt"])),
        "src": row["src"] or "unnamed",
        "context": row["context"],
        "duration": row["duration"],
        "locator": {"title": row["locator_title"], "href": row["locator_href"]},
        "original_url": row["orig_url"],
        "normalised_url": row["norm_url"],
    }


def _visits_envelope(url: str, norm: str, rows: list[sqlite3.Row]) -> dict[str, Any]:
    return {"original_url": url, "normalised_url": norm, "visits": [_visit_json(r) for r in rows]}


def promnesia_visits(url: str) -> dict[str, Any]:
    norm = normalise(url) or url.strip()
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM visit WHERE (norm_url = ? OR (context IS NOT NULL"
            " AND substr(norm_url, 1, ?) = ? AND norm_url != ?))"
            + _VISIBLE_VISIT
            + " ORDER BY dt",
            (norm, len(norm), norm, norm),
        ).fetchall()
    return _visits_envelope(url, norm, rows)


def promnesia_search(text: str) -> dict[str, Any]:
    needle = f"%{text.strip()}%"
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM visit WHERE (norm_url LIKE ? OR orig_url LIKE ?"
            " OR context LIKE ? OR locator_title LIKE ?)"
            + _VISIBLE_VISIT
            + " ORDER BY dt DESC LIMIT 500",
            (needle, needle, needle, needle),
        ).fetchall()
    return _visits_envelope(text, text.strip(), rows)


def promnesia_search_around(timestamp: float) -> dict[str, Any]:
    centre = dt.datetime.fromtimestamp(float(timestamp), dt.UTC)
    start = (centre - dt.timedelta(hours=3)).isoformat()
    end = (centre + dt.timedelta(minutes=2)).isoformat()
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM visit WHERE dt BETWEEN ? AND ?"
            + _VISIBLE_VISIT
            + " ORDER BY dt",
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
        # /status answers even when the store is broken (docs/d205).
        stats = {"ERROR": str(exc)}
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


class Handler(BaseHTTPRequestHandler):
    """The shared machinery; SURFACE names the protocol the listener answers."""

    protocol_version = "HTTP/1.1"
    SURFACE = ""

    def log_message(self, format: str, *args: Any) -> None:
        # The stdlib logger writes an unstructured line per request; _dispatch
        # emits one line with the status and the duration instead, so this is
        # silenced rather than duplicated.
        return

    def _send(self, status: int, payload: Any = None) -> None:
        self._status = status
        body = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        if body:
            self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self._cors()
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

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
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")

    def _body(self) -> bytes:
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def _json(self) -> dict[str, Any]:
        raw = self._body()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise BadRequest(f"invalid json: {exc}") from exc
        if not isinstance(parsed, dict):
            raise BadRequest("body must be an object")
        return parsed

    def _form(self) -> dict[str, str]:
        parsed = urllib.parse.parse_qs(self._body().decode(), keep_blank_values=True)
        return {k: v[0] for k, v in parsed.items()}

    def _query(self) -> dict[str, list[str]]:
        return urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True)

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
        return header == TOKEN

    def _dispatch(self) -> None:
        started = time.monotonic()
        path = self._path()
        self._status = 0
        try:
            if self.command == "OPTIONS":
                self._send(204)
            elif not self._authorised():
                self._send(401, {"error": "missing or bad token"})
            else:
                self._route(path)
        except BadRequest as exc:
            self._send(400, {"error": str(exc)})
        except sqlite3.Error as exc:
            self._send(500, {"error": f"store error: {exc}"})
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
                self._send(404, {"error": f"unknown path on {self.SURFACE}: {path}"})
            return
        if path == "/ingest/slurp":
            self._ingest()
        elif path == "/search":
            self._hister_search()
        elif path.startswith("/api/"):
            self._hister(path)
        else:
            self._send(404, {"error": f"unknown path on {self.SURFACE}: {path}"})

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
        self._send(200, promnesia_search_around(float(timestamp)))

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
            self._send(409, {"error": str(exc)})

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
                self._send(404)
                return
            self._send(200, None if self.command == "HEAD" else document)
        elif path == "/api/add":
            if self.command != "POST":
                self._send(405, {"error": "POST only"})
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
            if not pdf:
                raise BadRequest("missing pdf field")
            try:
                data = base64.b64decode(pdf, validate=True)
            except (ValueError, TypeError) as exc:
                raise BadRequest(f"pdf must be base64-encoded: {exc}") from exc
            try:
                text = extract_pdf_text(data)
            except Exception as exc:  # noqa: BLE001 - a malformed PDF is a request error, not a crash
                # Upstream fails the capture rather than storing a document the
                # index cannot see; the same 5xx keeps the extension's error
                # badge meaningful.
                self._send(500, {"error": f"pdf text extraction: {exc}"})
                return
            if not text:
                self._send(500, {"error": "pdf contains no extractable text"})
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
                self._send(404, {"error": "document not found"})
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
                self._send(405, {"error": "POST only"})
                return
            hister_history(self._json())
            self._send(201)
        elif path in ("/api/versions", "/api/facets"):
            # Upstream serves both, but the hister extension calls neither
            # (docs/d205's research item), and the web UI is out of scope, so the
            # deferral is answered instead of a guessed model.
            self._send(501, {"error": f"{path} is not built (docs/d205)"})
        else:
            self._send(404, {"error": "unknown path"})

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
            return [str(u) for u in urls]
        params = self._query()
        return [str(u) for u in params.get("urls", []) + params.get("url", [])]

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
        return addr[:sep].strip("[]"), int(addr[sep + 1 :])
    except ValueError as exc:
        # A bad address is a startup failure with the env var's name in it: the
        # operator reads which variable to fix instead of a traceback.
        raise SystemExit(f"browse-daemon: bad {env} {addr!r} (want host:port): {exc}") from exc


def serve(handler: type[Handler], addr: str, env: str) -> ThreadingHTTPServer:
    host, port = parse_addr(addr, env=env)
    server = ThreadingHTTPServer((host, port), handler)
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
                },
                indent=2,
            )
        )
        return 0
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
