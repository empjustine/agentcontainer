---
id: datalakehouse
type: module-design
status: active
title: "datalakehouse — local history and session stores → MotherDuck via the duckdb CLI"
parent: architecture
references: [d046, d113, d139, d167, d172, d173, d179, d180, d181, d203, d204, d205]
tags: [atuin, motherduck, duckdb, sync]
---

# datalakehouse

Syncs atuin's local `history.db` into the MotherDuck database `md:atuin`
(`main.history`) with the conventional duckdb CLI. The MotherDuck MCP server
stays what d046 scopes it to — connection info, one-off queries, docs — and the
scheduled path itself is a plain shell script plus a duckdb binary, delivered
through the repo's toolchain and vault chain (`./environment.sh`).
pi is the only harness with a reader. The transport carries any of them: a row
names its `source`, and the sender lands a source it has no promoted table for in
the `mdw.harness` envelope with the row verbatim (d221). d167 records every
harness's persistence format and the guaranteed-fields shapes; d221 records the
OpenCode and mistral-vibe readers still to write and what each needs. The session
collection leg, its read side, its ingest route and its postmortem sweep span
d179 to d184. Mistral-vibe support is pending in both this unit and
`coding-agent/run.mjs`.

The browsing-history side has both halves. `browse-daemon.py` serves the stock
Promnesia and hister extensions from one hot store, and
[`firefox-extension/`](firefox-extension/README.md) is the producer that fills
it: a Firefox add-on that streams visits, titles, bookmarks and removals over
`POST /ingest/slurp`. Its storage tiers are designed at d173, the clipper and
hister comparisons at d174, d175 and d177, the workload at d178, and the
task-level requirements are d204 and d205.
The retired tailscale+promnesia stack those records replaced is gone from the
worktree.

## Usage

```sh
./dev-tools.sh duckdb                          # once per host: pin the MotherDuck-compatible duckdb
./environment.sh ./datalakehouse/atuin-warehouse-sync.sh [--prune] [--print-source] [path]
```

- `path` — a `history.db` file, or a directory containing one. Optional: with
  no argument the script resolves the source itself (order below).
- `--print-source` — resolve and print the source path, then exit; needs no
  token, so it is also the debugging entry point.
- `--prune` — mirror source deletions into the warehouse. Default runs are
  upsert-only.
- Environment: `motherduck_token` (canonical; `MOTHERDUCK_TOKEN` is accepted
  too), `ATUIN_WAREHOUSE_DB` (target `md:` database, default `atuin`), and the
  atuin/XDG variables below for source discovery only.
- Exit codes: `64` usage, `66` no source found, `69` duckdb outside the
  supported range, `3` source has no `history` table.

### Source resolution

The resolution mirrors atuin's own precedence so an unattended run needs no
argv; the first existing file wins:

1. the explicit argv — which never falls back, because naming a path that is
   not a file must fail rather than silently mirror a different host's history;
2. `$PWD/history.db`;
3. `config.toml`'s `db_path`, else `data_dir/history.db`, with the config file
   found in atuin's own order (`ATUIN_CONFIG_DIR`, `ATUIN_HOME`,
   `~/.atuin/config.toml`, the legacy XDG config dir);
4. atuin's `unconfigured_data_dir` rules: `ATUIN_HOME/data` when `ATUIN_HOME`
   is set, else `~/.atuin/data` when that directory exists, else the first
   existing legacy directory (`$XDG_DATA_HOME/atuin`, `~/.local/share/atuin`),
   else `~/.atuin/data`.

**Deviations:** the mirror reproduces precedence, not toml semantics. A value
inside `config.toml` receives no shell or environment expansion (a leading
`~` is expanded), and a relative path is used as given. A host whose config
relies on those must pass the path explicitly.

### Coding-harness sessions

```sh
./environment.sh ./datalakehouse/agent-warehouse-sync.sh \
  [--session-dir DIR] [--agent-dir DIR] [--spool FILE] [--dry] [--print-rows] [--report-orphans]
./environment.sh ./datalakehouse/agent-warehouse-daemon.sh   # the write-only ingest route; folds its own spool when it holds the token
./environment.sh ./datalakehouse/agent-warehouse-spool-send.sh   # fold the spool into the warehouse, streamed
```

The sync is the postmortem sweep of d184: it walks the pi session root and the
agent dir's delegation/ directory, promotes each transcript's guaranteed fields
and keeps every entry verbatim in a JSON payload column, and hands the rows to
the sender, which owns every schema and every insert (d221). Rows land in
`md:agent` (`mdw.pi.session`, `mdw.pi.entry`) with first-write-wins on each
natural key. An entry is immutable by `(session_id, id)`, and re-writing an
unchanged row would leave a new MotherDuck version in failsafe on every run
(d203). No ThinkRail field is stored (d183). A direct run self-heals a missing `md:agent` by connecting to it once (DuckDB has
no `CREATE DATABASE` statement, so connecting is the create route) and retrying; a
read-scaling token cannot create one, so create it once in the MotherDuck UI if the
run refuses. The resolver, `--print-roots`, `--dry`, `--print-rows` and
`--report-orphans` need no token, and resolution precedes the vault round-trip
exactly as the atuin sibling's does.
Cold Parquet archiving of session rows is a pending task of this unit (d203):
export rows outside the hot window to zstd Parquet, keep the hot window in
MotherDuck, and verify the archive before pruning.

The daemon is the host-side, write-only `POST /ingest/session` sink of d181: no
read-back and no delete, appending to the same spool the sync already reads, so a
sandbox hands over events without holding write access to the archive.

The daemon runs in the foreground and does not fork itself; backgrounding is the
orchestration layer's job. Its dedupe is a conditional insert (`INSERT OR IGNORE`
against a SQLite primary key), so a re-posted row is skipped durably and the sync
re-posting every run appends nothing new. The key is recorded only **after** the
line is appended: recording it first would let a disk-full append lose the row
forever, because the replay would then be answered as a duplicate. On startup the
ledger is reseeded from every tail the sender still globs, streamed line by line,
so a pre-upgrade or crash-damaged ledger repairs itself without reading a
hundreds-of-MiB spool into memory. It is then vacuumed and WAL-checkpointed on
every start (`PRAGMA optimize`, `VACUUM`, `wal_checkpoint(TRUNCATE)`), so the
append-only key table does not carry its freelist into the next run. Identity is the transcript's own **session id**
(pi's header id) and, per entry, the entry id; the file path is stored as a
location attribute, never as the key, because the same session has a different
path inside a sandbox and on the host. A pi header is recognized by its `type`,
not its line position, so a file that concatenates two sessions splits back into
two by their own ids. `AGENT_INGEST_TOKEN` is optional on loopback, where any
local process can already reach the route; a non-loopback bind without it refuses
to start, because the write gate is the whole boundary there. Invalid input
answers an RFC 9457 `application/problem+json` document (a `400` names
`interface-error`), so a client branches on `type` rather than on prose.

A row also says what it is (d221). `source` names the harness and `kind` splits a
session row from an entry; absent `source` means `pi`, so rows written before the
field exist stay valid. pi rows keep `mdw.pi.*`; any other source lands in
`mdw.harness.session`/`mdw.harness.entry` with the row verbatim until its reader
defines the promoted shape over those rows (d167). An unidentified row is keyed
by the SHA-256 of its canonical JSON, not by the spool file and line: the sender
renames the live tail to `.rm.<pid>` and a direct fold renumbers the same row on
every run, so a file/line key minted a new primary key and the warehouse stored a
duplicate each time. The daemon keys a foreign row by source and accepts
`message_id` as an entry id, because two harnesses mint ids independently.

When the process holds `motherduck_token` (the usual `./environment.sh` start),
the daemon also folds its own spool: it runs `agent-warehouse-spool-send.sh` at
`AGENT_WAREHOUSE_SPOOL_MAX_BYTES` (default 32 MiB; `0` disables it), at startup for
whatever tail an earlier run left (a frozen `spool.rm.*` included) and after an append
that crosses the threshold. The sender owns one shared `<spool>.lock`: the
daemon, an operator run and a sync `--direct` leg all take it, so a second sender
exits `75` (temporary failure) and the daemon treats that as busy, not as a
failed fold. With `flock` the kernel releases the lock when the process dies; the
POSIX `mkdir` fallback checks the recorded pid and reclaims a dead owner. A failed
fold backs off `AGENT_WAREHOUSE_SPOOL_SEND_RETRY` ms (default 60000) and retries
from a timer, so an idle daemon does not wait for the next POST. The pending count
is measured from the files at startup and around every fold, and a non-numeric
numeric variable warns and falls back to its default. Without the token it only
spools and says so at startup; the spool then grows without a ceiling until an
operator runs the sender (docs/d217).

**The route is the sync's default
transport** — `http://127.0.0.1:8787` or `AGENT_WAREHOUSE_ROUTE` — needing no
MotherDuck token and no duckdb; the route's own `AGENT_INGEST_TOKEN` may still be
required. A plaintext route off loopback is refused because it would carry that
key in the clear; `--direct` is the alternative that uploads straight to
MotherDuck.
`--rm` removes a processed file only after the transport ack, and only when the
file is older than `AGENT_WAREHOUSE_RM_GRACE` seconds (default 300); it is meant for
postmortem runs and the historical pile, never for a live session, and a
just-modified file is kept and reported as possibly live. A **route** ack only
proves the row reached the host spool, not the warehouse: `--rm` in route mode
warns that the source is then the last copy only until the next fold. Use
`--direct` when the source must not be the last copy.
The collector is its own tool: `agent-warehouse-spool-send.sh` folds an existing
spool into the warehouse by reading batches bounded by both rows (`AGENT_WAREHOUSE_BATCH_ROWS`) and bytes
(`AGENT_WAREHOUSE_BATCH_BYTES`), so a hundreds-of-MiB pending spool never has to
fit in the engine at once and one 100-KB row cannot make a 5000-row batch. It
freezes the live tail first and deletes a frozen file only after it is fully
consumed and acked; a recreated live tail is never read or deleted in the same
pass, because rows appended between the last read and the `rm` would be lost. A
malformed or unidentifiable line is a dead letter: it is appended to
`<spool>.dead.ndjson` (or `AGENT_WAREHOUSE_DEADLOG`) with its last session
header, the lines before it and the lines after it (`AGENT_WAREHOUSE_DLQ_CONTEXT`,
default 3), so it can be repaired
without the live tail blocking forever. The dead-letter queue is append-only and
never consumed automatically; a record is keyed by the content hash of the bad
line, so re-reading a rotated tail does not duplicate it. A line that cannot be
quarantined keeps its tail instead. The rotation is
unilateral: the daemon appends by path on every request, so the next append creates
a fresh spool, and a daemon holding a persistent file handle would keep writing the
renamed inode. **A direct run of the sync clears the consumed spool**: it rotates
the tail first, hands the raw tails and the parsed rows to the sender in one fold,
and removes only the tails it read after the ack, independent of `--rm` (which governs the
session files). A **route** run never touches the spool: the daemon already holds
those rows, so re-posting them would only exercise the dedupe. A `--dry` or report
run has no side effect and counts the spool rows on their own.
The roots are searched **recursively** for `*.jsonl`, so `--session-dir` may
point at any tree: pi's `--<cwd>--/` shape is not assumed, and a historic pile with
sessions at mixed depths (or several `agentcontainer-<ts>` revisions) is read as-is.
A `.jsonl` whose first line is not a pi session header is **skipped** (another
tool's stream, such as mistral-vibe's `messages.jsonl`, or a fragment), so it
contributes no rows and is never a `--rm` candidate.
The route post is batched under `AGENT_WAREHOUSE_BATCH_BYTES` (default 4 MiB) so a
row's large content array cannot overflow the daemon's `AGENT_INGEST_MAX_BODY`
(default 8 MiB) or its `AGENT_INGEST_MAX_ROWS` (default 10000) in a single
request.

### The browsing endpoint (Promnesia and hister)

```sh
uv run --script ./datalakehouse/browse-daemon.py            # foreground, one log line per request
BROWSE_TOKEN=… ./environment.sh ./datalakehouse/browse-daemon.sh   # the static key on the write faces
```

One daemon serves both browser clients over one SQLite store: the stock
Promnesia extension reads the visit and visited faces, the stock hister
extension posts page captures and reads the indexing rules (d205). The
canonicaliser is Promnesia's own `cannon.py`, vendored (MIT) because
`/visited` answers only when both sides normalise a URL identically
(d172, d176).

- Two listeners on the ports each client already defaults to: the hister API
  (and this unit's ingest edge) on `BROWSE_HISTER_ADDR` (default
  `127.0.0.1:4433`), the Promnesia protocol on `BROWSE_PROMNESIA_ADDR`
  (default `127.0.0.1:13131`). Each answers its own `/search`: the hister
  listener serves the document query dialect, the Promnesia listener serves the
  visit search, and the Promnesia path also answers a hister-shaped request
  because the two protocols share that path upstream (d205).
- `BROWSE_DB` (default `$XDG_DATA_HOME/agent-warehouse/browse.sqlite`) and
  `BROWSE_TOKEN`.
- `BROWSE_TOKEN` gates the **write** faces (`/ingest/slurp`, `/api/add`,
  `/api/add_pdf`, `/api/delete`, `/api/label`, `POST /api/rules`,
  `/api/history`). Reads stay open because the Promnesia extension has no field
  to carry a key and the default bind is loopback. A non-loopback bind without
  a key refuses to start; a non-loopback bind with a key still leaves every read
  unauthenticated, so the key is a write secret, not a network secret.
- Invalid values answer an RFC 9457 `application/problem+json` document: a
  `400` names `interface-error`, a `413` names `payload-too-large`, and a store
  failure keeps its words in the log while the body names `store-error`.
- `BROWSE_MAX_BODY` (default 8 MiB), `BROWSE_MAX_PDF_BYTES` (default 32 MiB),
  `BROWSE_MAX_VISITED_URLS` (default 5000) and `BROWSE_MAX_FORM_FIELDS` (default 10000) bound the allocations a request can force before its route runs. A
  request over a body ceiling answers `413`.
- The store is created `0700`/`0600`: browsing history is private to the user.
  Timestamps are stored in UTC, so a lexical compare of an offset form cannot
  sort the wrong instant; a `history-cleared` mark hides the visits up to its
  timestamp on both visit faces while the presence row (and the archive) stays.
  A `visit` row is never updated; a later title or bookmark title fills the
  derived `page_title`/`presence` and the read faces join it, so the append-only
  fact stays append-only. A bookmark move updates the stored parent, position and
  title while `date_added` stays immutable.
- `BROWSE_PDF_TIMEOUT` (default 20 s) and `BROWSE_PDF_MAX_TEXT` (default 8 MiB)
  bound PDF extraction, which runs in a separate interpreter with CPU,
  address-space and file-size rlimits. The daemon is the appender; a media
  parser gets its own process. `BROWSE_PDF_RUNNER` prefixes that worker with an
  operator command (for example a `bwrap --unshare-net --die-with-parent … --` or
  `systemd-run --scope -p MemoryMax=… --` wrapper); for hostile PDFs, run the
  daemon in a container or use that runner for a namespace/container boundary.
- `--print-config` prints the resolved address, store and whether a key is set.

The producer half is the Firefox add-on in `firefox-extension/`; its README
carries the install path, the consent gate and the permission contract. It needs
no key when the daemon runs without `BROWSE_TOKEN`, and the same key on its
options page when the daemon has one. The slurper **is** the import path: there
is no separate Promnesia-DB or hister-DB importer, and a second browser (Edge) is
a second producer of the same envelope, not a migration of an old store.

The ingest verb is the custom slurper of d204: the extension in
`firefox-extension/` is its producer, and the batch is the one stream-shaped
envelope that producer builds — every record carries its own `src` and `kind`,
and a batch belongs to one stream.

```json
POST /ingest/slurp
{"schema":1,"producer":"agentcontainer-slurp/0.1.0","stream":"visit",
 "stream_seq":{"low":1,"high":3,"acked":0},"checkpoint":{"cursor":"…"},
 "records":[
  {"src":"firefox-history","kind":"visit","key":"<json [url, visit_time]>",
   "url":"https://…","visit_time":1712345678901,"title":"…","via":"backfill"},
  {"src":"firefox-history","kind":"title","key":"title:<page guid>",
   "url":"https://…","title":"…","seen_at":1712345679000},
  {"src":"firefox-bookmarks","kind":"bookmark","key":"<node id>",
   "node_type":"bookmark","url":"https://…","title":"…","parent_id":"<guid>",
   "position":0,"date_added":1712345600000},
  {"src":"firefox-bookmarks","kind":"bookmark-removed","key":"<node id>",
   "node_type":"folder","cascade":true,"deleted_at":1712345700000,
   "source":"bookmark"},
  {"src":"firefox-history","kind":"visit-removed","key":"https://…",
   "url":"https://…","deleted_at":1712345700000,"source":"local"},
  {"src":"firefox-history","kind":"history-cleared","key":"*",
   "deleted_at":1712345700000,"source":"local"}]}
→ 200 {"accepted":N,"duplicates":N,"version":"…","checkpoint":{…}}
```

- A batch is one transaction with one ack, and the dedupe identity is
  `(src, kind, key)`; a re-sent batch answers `accepted: 0`.
- A replayed batch is answered as duplicates by row identity, never by the
  sequence mark alone: a producer that resets its own sequence (a storage wipe,
  a reinstall, a restored older profile) restarts at 1 while the daemon still
  remembers a higher mark, and a mark-based shortcut would answer every later
  batch as a duplicate while writing nothing. `stream_seq` is recorded for
  observability, not trusted for skipping.
- A `schema` the daemon does not speak is a `409`, which the producer treats as
  a permanent reject: a retry of the same bytes cannot succeed.
- The daemon canonicalises every URL; the producer sends raw ones.
- `visit-removed` is page-granular, because Firefox reports no visit detail on
  removal: the mark hides that page's visits, while the visited check still
  answers yes.
- A removal erases exactly what Firefox named (d204's "What a removal may
  erase"): a `bookmark-removed` carries an exact node guid, so it is an erase
  instruction the compaction may act on (a folder cascades over the stored
  parent chain); a `visit-removed` or `history-cleared` carries no visit
  identity, so it is a mark that hides rows and leaves them in place.
- A title fact is keyed on the page guid and only fills a blank locator, so it
  never invents a visit.
- A bookmark carries its parent guid, index and node type; the folder path is a
  view of that chain, which is why a move costs no row churn.
- A bookmark is stored as context, never as a visited mark: the row enriches a
  page a visit already made present (its blank locator title), but bookmark-only
  URLs answer `/visited` with `null`. That is the producer's own distinction
  between "saved" and "seen" (d204).
- Promnesia timestamps are IXDTF in the numeric-offset form, in the host's
  timezone (`2024-04-05T21:34:38+02:00`). The stock extension parses the field
  with `Date.parse` and slices six characters off the end, so the bracketed
  `[Zone]` annotation would break it; the offset form keeps both of the
  extension's fields correct (d205).

The daemon answers the pinned hister surface of d205 from the same store
(`/search`, `/api/config`, `/api/profile`, `/api/rules` GET+POST, `/api/add`,
`/api/add_pdf`, `/api/document` GET and HEAD, `/api/delete`, `/api/history`,
`/api/label`). Shapes worth knowing before changing them:

- `/search` serves a naive BM25 over a cold-shaped index: a term dictionary
  (`term_stats`) and posting lists (`posting`) sorted by term, with no
  positions. A cold query reads one contiguous term range per term, which is
  the ClickHouse-shaped inverted index the Parquet rewrite can keep as row
  groups. Terms, prefixes, quoted phrases, `url:`, `domain:`, `title:`,
  `label:`, `language:`, `match_all`, `sort:`, date bounds, pagination and
  the priority boost are supported; there is no stemmer, no semantic search and
  no live-search latency promise. The hister extension does not call it, but a
  web client can (d205, Search).
- `/api/delete` takes the same query dialect, not a URL: the extension's
  `url:"…"` and `domain:…` actions delete every matching document and leave the
  visit rows alone (a capture is not a visit), clearing only the click history
  the upstream server also removes.
- `/api/profile` is upstream's single-user shape: `200` with no body, so the
  extension's `user_id` stays `0` and it never invents an account.
- `/api/add_pdf` extracts text with the declared `pypdf` dependency, stores it
  as the document body and answers `201`; an unextractable PDF answers `500`,
  the same failure upstream reports, because a document the index cannot see is
  not a successful capture.
- `/api/versions` and `/api/facets` answer `501`: upstream serves both, but
  the extension calls neither, so the version-purge rule stays open rather than
  being guessed at.
- `/api/add` never erases a stored body: a re-add that carries only the URL
  (the extension's label and permission paths do) keeps the stored text, HTML
  and language, and the postings are rebuilt from the stored row, not the
  request.

Retention is split the way the clients are: the archive keeps every visit row
(a page mark or a global clear hides a row, never deletes it), the browser keeps
half of Gecko's expiry rule (50 000 pages, 45 days) and the producer prunes it
through the public history API, so history falls into the
archive instead of expiring unwatched. The producer's GitHub repository-root
bookmark rule and the 5 s-to-7 d scrub cadence live in
[d204](../docs/d204-firefox-slurp-extension-requirements.md). A captured
document is the one explicit erase: `/api/delete` removes the document and its
postings, because the hister delete action is a user instruction, not a
retention rule.

### Verification status

The daemon's shell suite (`tests/browse-daemon.sh`) drives a live daemon over
the Promnesia face, the hister face, the slurper and the CORS/auth edges; the
extension's Node suite runs its four streams against the fake WebExtension; and
`tests/slurp-contract.mjs` posts through the extension's own `wire.mjs` to the
daemon and reads the result back from both faces. The call set was compared
against upstream `karlicoss/promnesia` `server.py`/`api.ts` and the current
hister extension. The suite also asserts a wide bind without a key, an oversized body, a bookmark move, a history clear, a failed spool append, a quarantined malformed line with its context, the shared sender lock, an append-only visit under a late title and a bookmark title, a PDF parser crash in its worker and an RFC 9457 problem body. That repository now redirects to `asciimoo/nogon`; its
extension still calls the same nine endpoints, so the capture surface stays
pinned even though the server has grown many endpoints the extension does not
call.

No real Firefox session has run: the extension tests use
`firefox-extension/tests/fake-webext.mjs`, so Flatpak and ESR installs remain
unverified, and the daemon's own tests use shaped HTTP payloads rather than a
browser. The IXDTF timestamp shape is asserted, not parsed by a stock extension
in CI.

### What the browsing endpoint does not do yet

- **A web UI.** Neither stock extension needs one to work: Promnesia's sidebar
  and hister's capture/rules/label/history calls are HTTP, and the hister popup's
  logo is a plain link to the server root. That root answers `404` here. The UI
  and its preview/facet surface remain out of scope (d205's L3 decision); a thin
  local UI or a disposable hister sidecar is a separate client choice.
- **Cold generations.** SQLite holds every visit and every posting, not a hot
  window over a Parquet archive (d173). Nothing has been demoted, so no query is
  missing data yet — and nothing has been measured about the demotion window
  either. The posting layout is the cold one; the Parquet writer is not built.
- **Search quality and the full query language.** The index has no positions,
  no stemming and no Bleve-compatible parser; a phrase is a candidate filter,
  `/api/facets` and `/api/versions` are `501`, and there is no WebSocket
  stream. The implemented dialect is the one the delete action and a simple web
  client use, not hister's full query language.
- **Erasure, retention, offsite copy, scrubbing.** d205's pending list, unchanged
  by this daemon: a tombstone marks, and no SMR generation exists to scrub.
- **Sensitive-content rejection (`422`).** Extraction is the producer's job in
  d205's scope, so the daemon honours a producer that marks a row `sensitive` and
  never inspects content itself.
- **Document versions.** The storage contract asks for diffs, the extension reads
  none, and `/api/versions` answers `501` until the retention rule that would
  purge them exists.

## What gets synced

`main.history` in `md:atuin` carries the source's columns — the base eight plus
`deleted_at`, `author`, `intent`, `shell`, `author_kind` as the installed atuin
build provides them. Timestamps become real `TIMESTAMP`s (the source stores
epoch nanoseconds; `duration` becomes seconds), `exit`/`author_kind` become
`BIGINT`. Rows upsert by `id`; a source column the warehouse lacks is added by
`ALTER TABLE` before the insert, so an atuin upgrade widens the target instead
of failing the run.

## The rest of the atuin data dir

Worth assessing before claiming "complete sync" — the files that sit beside
`history.db` in the atuin data directory:

| file                     | contents                                                                  | warehouse verdict                                                                    |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `history.db`             | command history — the queryable payload                                   | synced (this tool)                                                                   |
| `kv.db`                  | plain-text sync key/value metadata (`namespace`, `key`, `value`)          | cheap to add as text; low analytic value — atuin bookkeeping, not history            |
| `meta.db`                | plain-text server/URL bookkeeping                                         | same — tiny, optional                                                                |
| `records.db` (+`store`)  | sync records; `data`/`cek` are paseto-encrypted blobs, metadata plaintext | metadata-only value; bulk is unqueryable without atuin's keys — skip by default      |
| `threads.db`             | AI threads table (newer builds)                                           | revisit when the local build ships it                                                |
| `octavo.db`              | AI embedding blobs                                                        | blob bytes — same reasoning as `records`                                             |
| `key`, `output-capture/` | identity key material, captured output attachments                        | never synced: key material must not travel to the warehouse; captures are file blobs |

Verdict: `history.db` is the file with queryable columns and the reason for
the warehouse. `kv`/`meta` are a five-minute addition if provenance matters;
`records`/`threads`/`octavo` earn nothing analytic until decryption happens
somewhere, and `key`/`output-capture` stay out by design.

## Verified findings

- MotherDuck's extension accepts duckdb **v1.4–v1.5** (docs give
  1.4.1–1.5.6); a v2.x client is refused at load. The script checks
  `duckdb --version` first and points at `./dev-tools.sh duckdb`, because the
  extension's own error names no fix.
- `ATTACH '<path>' (TYPE sqlite, READ_ONLY)` reads a **live** atuin
  `history.db` without blocking its WAL — a full sync runs against a working
  shell.
- The `history` table grew columns across atuin releases (`deleted_at` 2023,
  `author`/`intent` 2026, `shell` 2026, `author_kind` 2026), so the target
  schema is derived at runtime from `duckdb_columns()`, never hardcoded.
- Two MotherDuck identities that both resolve `md:<name>` hold **different**
  databases: a vault token and an MCP login must be one account (or the
  databases must be named apart), or each side reads its own empty copy while
  both report success.
- MCP `query({database})` reads a database created moments earlier only after
  `list_databases` refreshes the session's list; without it the query falls
  back to the default database and reports a missing table.
- An MCP query after account or database surgery can hit a stale catalog —
  the immediate retry succeeds; treat a `schema does not exist` on a
  just-written table as that staleness, not as data loss.
- MotherDuck bills managed storage, failsafe included, and an
  `ON CONFLICT DO UPDATE` sync of unchanged rows grows that failsafe: the
  session table's `failsafe_bytes` can exceed its live bytes by an order of
  magnitude (d203). The sync and the spool sender use first-write-wins
  (`ON CONFLICT DO NOTHING`), so an unchanged row is not rewritten.
- End-to-end: fixture runs cover create, re-run idempotence, an atuin-style
  `ALTER`-add-column drift, and prune; the resolution order has its own
  `tests/resolve-source.sh` (no token, no network).

## Assumptions

- The source is a single host's local `history.db`; atuin's remote sync
  (`records`) is out of scope.
- `id` is the warehouse primary key — atuin's own history id.
- The warehouse `main.history` outlives any one host, which is why deletion
  mirroring is opt-in: a partial or stale source must not silently erase
  history that exists nowhere else.

## Gotchas

- The coding-agent container bind-mounts the repo and the reference store
  only — the host's `~/.local/share/atuin` is invisible there. Run the sync
  on the host, or pass a path the container can see; `--print-source` shows
  what each environment resolves.
- `--prune` against a partial source erases everything the source does not
  cover; state "this source is authoritative" before using it.
- Token delivery is the one vault round-trip (`./environment.sh`); the script
  reads plain env and never loads secrets itself (d046).
