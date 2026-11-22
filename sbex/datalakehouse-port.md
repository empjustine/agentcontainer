---
id: sbex-datalakehouse-port
type: submodule-design
status: active
title: "Porting the datalakehouse daemons into sbex: four wire protocols, one Spring stack"
parent: sbex
references:
  [
    sbex-persistence-engines,
    sbex-optimisation-findings,
    sbex-sqlite-replication,
    sbex-cold-persistence,
    sbex-servlet-vs-reactive,
    d181,
    d184,
    d204,
    d205,
  ]
tags: ["port", "protocols", "promnesia", "hister", "slurp", "agent", "sqlite", "streaming"]
---

# Porting the datalakehouse daemons into sbex

This note is the contract for the service the example carries beside the order toy: the datalakehouse daemons' four wire protocols in Spring, over one SQLite store and one spool. It inventories the protocols, the Spring shape each one has, the listener topology, and the slice order with its acceptance criterion. The four browse-facing slices and the session route are landed in `sbex-lakehouse/`; this note is the map of that port and of what it deliberately does not do. The reader is the engineer changing it, and arrives knowing the example's patterns and the four-engine matrix.

## Status

Active. The inventory was extracted from `browse-daemon.py`, `agent-warehouse-daemon.mjs`, the unit's README and its HTTP-level test suites, and the browse-facing slices plus the session route are implemented in `sbex-lakehouse/`. The unit's own suite passes against the Java service (see Conformance), with the Python canonicaliser assertion replaced by `CanonicalUrlTest`'s golden pairs and the process-specific wide-bind check reported as the external start-up contract. The groundwork already enforced the append-only and security rules the port must not regress (see What the groundwork already guarantees); the port is a rewrite of the mechanism, not a licence to reopen the gaps. Retention, erasure and admission control stay pending (see Deferred and dropped), and the cold tier stays unimplemented in both the daemon and the port.

## What the port keeps and what it replaces

The example's patterns are the asset; the order domain is the placeholder. The port keeps the transaction boundary, the dedupe ledger, the bounded pools, the vendor dialect and the streaming read, and gives them a workload whose invariants are already written down. The order example and the lakehouse service coexist: the order modules still demonstrate the vendor matrix and the messaging path, and retiring them is its own record, under the log's mechanical-accuracy rule.

| Pattern in the order toy            | What the lakehouse makes of it                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `@Transactional` unit of work       | one ingest batch, one transaction, one ack                                       |
| `processed_events` dedupe ledger    | `(src, kind, key)` row identity, plus tombstones that hide without erasing       |
| streaming report over `ResultSet`   | NDJSON ingest and export, and the `/visited` batch check                         |
| vendor dialect behind one interface | SQLite `ON CONFLICT`/`INSERT OR IGNORE` against PostgreSQL's upsert shape        |
| bounded pool, one writer            | SQLite's single writer, read pool for the two faces                              |
| after-commit publish                | index rebuild after a capture lands (the one place a broker earns its keep here) |

## The four protocols

Each surface answers only its own paths, and a wrong-surface path is a 404 rather than a working-looking 200 — the daemon's own rule, and the reason the listener topology matters.

### The custom slurp ingest

`POST /ingest/slurp` takes one stream-shaped envelope: `schema`, `producer`, `stream`, `stream_seq`, `checkpoint`, and a `records` array in which every record carries its own `src` and `kind`. Six kinds describe live events: `visit`, `title`, `bookmark`, `bookmark-removed`, `visit-removed`, `history-cleared`. Three more carry a stored row as it was, which is what makes an import lossless rather than a replay through the capture path: `document`, `rule`, `click`.

| Rule                               | Behaviour                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| transaction                        | one batch is one transaction with one ack                                                       |
| dedupe identity                    | `(src, kind, key)`; a replayed batch answers `accepted: 0`                                      |
| sequence                           | `stream_seq` is recorded for observability, never trusted to skip records                       |
| unknown schema                     | `409`, which the producer treats as a permanent reject                                          |
| canonicalisation                   | the server canonicalises every URL; the producer sends raw ones                                 |
| `visit-removed`, `history-cleared` | a page-granular _mark_: visits hide, the presence row stays, "seen" is still yes                |
| `bookmark-removed`                 | an exact node identity, so the compaction may act on it, cascading over the stored parent chain |
| `title`                            | fills a blank locator, never invents a visit                                                    |
| `bookmark`                         | context, never a visited mark: a bookmark-only URL answers `/visited` with `null`               |

### The Promnesia face

The stock extension's protocol, pinned from upstream `server.py`: `/status`, `/visited` (a POSTed list of URLs answered by an array of visit-or-`null`), `/visits?url=`, `/search` and `/search_around`.

| Detail                    | Value the port must match                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| timestamp                 | IXDTF with a numeric offset in the host zone (`2024-04-05T21:34:38+02:00`); the bracketed `[Zone]` form breaks the stock parser |
| `/search`                 | a `url` parameter means Promnesia's visit search; anything else falls through to the hister dialect on the same path            |
| `/search` cap and order   | 500 rows, newest first                                                                                                          |
| `/search_around`          | window from three hours before to two minutes after the given timestamp                                                         |
| `/search_around` envelope | the literal `http://dummy.org` URL, because upstream's extension ignores the envelope fields                                    |
| `/visited`                | a presence row wins; a captured document answers when no visit exists yet                                                       |
| `/status`                 | answers even when the store is broken, with the error in `stats`                                                                |

### The hister face

The endpoints the stock extension calls, plus the two it does not.

| Route                          | Shape the port must match                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /search`, `GET /search`  | the query dialect: terms, prefixes, quoted phrases, `url:`, `domain:`, `title:`, `label:`, `language:`, `match_all`, `sort:`, date bounds, pagination, priority boost |
| `/api/config`                  | version, server name, indexing rules                                                                                                                                  |
| `/api/profile`                 | `200` with no body, so the extension keeps `user_id` at 0                                                                                                             |
| `/api/rules`                   | GET and form-POST                                                                                                                                                     |
| `/api/document`                | GET and HEAD, one object shape shared with search results                                                                                                             |
| `/api/add`                     | rebuilds postings from the stored row, never erases a stored body on a URL-only re-add                                                                                |
| `/api/add_pdf`                 | `201` with extracted text stored as the body; `500` when extraction fails (upstream's shape)                                                                          |
| `/api/delete`                  | takes the query dialect, not a URL; deletes documents and clears click history, leaves visits alone                                                                   |
| `/api/label`, `/api/history`   | label rows and the click log                                                                                                                                          |
| `/api/versions`, `/api/facets` | `501`: upstream serves both, the extension calls neither                                                                                                              |

Cross-cutting: CORS is echoed for `moz-extension://`, `chrome-extension://` and `safari-web-extension://` origins with the extension's header list, and `OPTIONS` answers `204`. A static token, or a bearer, gates the write paths only, because the Promnesia extension has no field to carry one and the bind is loopback.

### The agent ingest

`POST /ingest/session` and nothing else on that route. The body is one JSON row or an array of rows, keyed on the transcript's own session id and entry id, inserted conditionally so a re-posted row is skipped durably, and spooled for the warehouse sync to read. The daemon answers `405` on any other method and `404` on a `POST` to another path. The body carries `AGENT_INGEST_MAX_BODY` (default 8 MiB) and `AGENT_INGEST_MAX_ROWS` (default 10000) ceilings. A row without an identity is keyed by the SHA-256 of its canonical JSON, never by the spool line, because the sender renames the live tail to `.rm.<pid>` and a direct fold renumbers the same line on every run.

## What each protocol needs from the Java stack

| Need               | Where it lands                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| batch ingest       | `@Transactional` service method; the ack counts are the return value                                                                                                            |
| NDJSON streaming   | the sender reads NDJSON in row- and byte-bounded batches; the agent route reads one JSON row or array, capped by body and row count; the read faces stream rows out, not a list |
| idempotency        | `INSERT OR IGNORE` with the update count as the signal, and a tombstone table for the marks                                                                                     |
| canonicalisation   | a port of the vendored `cannon` (MIT): domain folding, tracking-parameter stripping, trailing slash, archive.org                                                                |
| search             | a term dictionary and posting lists with naive BM25, and a small recursive-descent parser for the dialect                                                                       |
| PDF text           | PDFBox for `/api/add_pdf`, in an out-of-process worker with rlimits and a timeout; extraction differences from `pypdf` are accepted, the status and stored shape are not        |
| CORS and the token | one filter, one rule set, applied by surface                                                                                                                                    |
| observability      | one structured line per request with status and duration, the daemon's shape                                                                                                    |

## Listener topology

Three shapes work, and the choice is a teaching decision rather than a technical one.

- **Two applications over one shared module.** A `sbex-lakehouse` core module (schema, ingest, search, canonicaliser) with a hister application on 4433 and a Promnesia application on 13131. This mirrors the example's existing "one core, two stacks" story, keeps each surface's routes provably disjoint, and gives the ports the clients already default to. It also doubles the JVM footprint for a local tool.
- **One application, every connector.** `TomcatServletWebServerFactory#addAdditionalConnectors` binds the extra ports in one process, and a filter keyed on the local port enforces the surface rule. One image, one log stream, and the disjointness becomes a test rather than a structure.
- **One port behind a router.** The cheapest, and the one that makes the surface rule someone else's problem.

The landed shape is the second: one application, three connectors (`ListenerConfig`), and `SurfaceFilter` answering a wrong-surface path with a 404. The first shape's teaching value — a route and the row it answers from in one file — is kept inside the one process by the surface attribute the filter sets, and the footprint cost of a second JVM (a second writer on the same SQLite file, a second heap) is not paid for a local tool. The third shape stays the cheapest deployment an operator can build around the service; it is not what the module does itself.

The three connectors are: the hister listener (primary, the port `server.tomcat.*` bounds), the Promnesia listener, and the write-only session route. Each additional connector carries its own protocol handler, so the request-thread ceiling is set on it explicitly rather than inherited.

## Storage

SQLite for the hot store, because the daemon's schema and semantics are SQLite's: `journal_mode=WAL`, `busy_timeout=10000`, `INSERT OR IGNORE`, and one writer. The shared tables are the daemon's: `visit`, `bookmark`, `page_title`, `tombstone`, `presence`, `document`, `rule`, `click`, `stream`, `meta`. The session leg has its own store and transport: `seen.sqlite` is the durable dedupe ledger (vacuumed and WAL-checkpointed at start), the NDJSON spool is the append tail, `<spool>.dead.ndjson` is the append-only dead-letter queue, and `<spool>.lock` serialises every sender. Store timestamps in UTC; the read faces compare them as text.

This is the first workload that earns the SQLite leg of the engine matrix: the writer pool is one connection (`StoreConfig`), the read faces get their own pool, and the WAL settings are the ones Litestream's caveats already require. Two pools rather than one states what the daemon's single write lock made implicit: a request that holds the only connection to write and then reads the same store would deadlock the pool.

The store's schema is the daemon's (`lakehouse-schema.sql`), so an existing `browse.sqlite` opens without a migration, and the index is the service's own, rebuildable state (`lakehouse-index.sql`, tables `lakehouse_doc`, `lakehouse_posting`, `lakehouse_term`, `lakehouse_stats`, mark `meta['lakehouse.index_schema']`). Timestamps are stored in UTC as ISO text so the read faces can compare them, and the wire conversion back to the host offset happens in `Moments.promnesia`.

The session leg keeps its own transport: `spool.ndjson` is the append tail, `seen.sqlite` the durable dedupe ledger, and the shared `<spool>.lock` belongs to the shell sender. The Java route appends by path, records a key only after the append, replays the tails into the ledger at startup, and folds through the same sender at `AGENT_WAREHOUSE_SPOOL_MAX_BYTES`. The cold side — Parquet generations, ClickHouse-shaped postings, the MotherDuck fold — stays out of the port's scope and keeps its pending items in the unit's records.

## The cold boundary

A cold generation is an `added` window written as Parquet, so the question the hot store must answer today is whether a demotion can be a copy plus a prune, or whether it would need a redesign. The index is shaped for the copy: `lakehouse_posting` is `(term, doc, field, tf)` sorted by term, one row group per contiguous term range; `lakehouse_doc` is the document dimension, one row per document with `added` as the window axis; `lakehouse_term` is the sorted dictionary; `lakehouse_stats` is the two corpus numbers BM25 divides by; and no positions are stored, which is why a phrase is a candidate filter rather than an index lookup.

A posting names an integer document id, never a URL. That is what makes a compressed cold row group cheap — the URL lives once, in the dimension — and it is also what lets a generation keep referring to a document whose id is never reused (`AUTOINCREMENT`). The store the compaction reads is therefore the same three shapes the cold side keeps, and the rebuild path proves the derivation: dropping the index mark rebuilds every row from `document` alone.

The prune already exists on the query side. A date-bounded query pushes `added` into the candidate scan, so the "latest history" form answers from the hot window and never touches a demoted one; an unbounded query spans both and would merge hot and cold candidates by score. Ranking, the field filters and the priority boost read the dimension columns only; a body is fetched for the returned page, and for a phrase's candidates alone, which is the one per-candidate IO the no-position layout leaves.

Three things stay with the demotion job, and none of them is in the hot store's way. [sbex-cold-persistence](cold-persistence.md) owns the Parquet writer, the manifest and the object-storage path. Per-generation statistics are a choice between recording the same two numbers beside each generation or scoring every half with the global ones; global ones keep scores comparable across a merged query, and are what this service uses until a measurement says otherwise. Impact-ordered postings (block-max or WAND) are what a cold query over a common term needs to stop early, because ranking here collects every candidate before it pages; the current shape is the flat posting list such an ordering is built from, not the ordering itself.

## Existing stores, imports and the format guarantee

Both daemons treat the reference implementation's files as the contract in both directions, so a host can switch implementations or switch back without a migration:

- **The store's own tables are the reference's.** `lakehouse-schema.sql` is the daemon's schema, so an existing `browse.sqlite` opens as it is, and every row either implementation writes is a row the other reads. The index is not shared: each implementation owns its own tables (`lakehouse_*` here, `posting`/`doc_length`/`term_stats` there) and its own mark in `meta`, so pointing either at a store the other wrote rebuilds derived state only and leaves the other's index alone.
- **The session leg's files are the reference's.** `seen.sqlite` carries the same table and pragmas, the spool is the same NDJSON tail, and `JsJson` prints numbers and escapes exactly as the Node daemon's `JSON.stringify` does — the spool line and the row identity are byte-identical, so a row posted before the switch and re-posted after it is the same row, and a tail written by one daemon is deduped by the other.
- **The only sanctioned divergence is demotion.** A row moved to a colder generation leaves the hot store, so the reference daemon answers without it; that is the exception, and the demotion contract keeps its markers in additive tables the reference ignores.

An **import** is lossless on both channels. Imported by database, nothing is transformed: the rows are the reference's. Imported through the API, the three import kinds carry a stored row as it was — `document` takes `url` (and an optional `norm_url`, so a source whose canonicalisation differs is imported without collisions), `owner`/`user_id`, `title`, `text`, `html`, `favicon`, `language`, `label`, `type`, `metadata`, and the capture history the capture path would otherwise rewrite (`added`, `updated`, `add_count`); `rule` takes a pattern list or the `aliases` object the reference store has no column for (stored as one additive row it ignores); `click` takes a click with its original timestamp. A document import is first-write-wins and a replay answers duplicates, so re-running an import never rewrites `added` or bumps `add_count`, and a click replay does not double the history. The index is rebuilt from the imported rows, and `added` becomes the search window and the demotion axis, not the import time.

What an import still does not carry is what the reference schema does not model: document versions (`/api/versions` answers `501` in both), and the read faces' single-user view — a row imported under another `owner` is stored losslessly and is not served by the `owner = 0` faces. The reference daemon rejects the three import kinds as unknown on the wire, so an importer targets this service; the rows it writes are plain reference rows, which is what keeps the file usable by the old daemon afterwards.

## Slices

| Slice | Routes                                                                                              | Acceptance                                                                          | Landed |
| ----- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| S1    | `POST /ingest/slurp`, schema, dedupe, canonicaliser                                                 | the slurp assertions of `tests/browse-daemon.sh`, plus the canonicaliser pairs      | yes    |
| S2    | `/status`, `/visited`, `/visits`, `/search`, `/search_around`                                       | the Promnesia half of the same suite, byte-for-byte field names and timestamp shape | yes    |
| S3    | `/api/config`, `/api/profile`, `/api/document` GET+HEAD, `/api/rules`, `/api/label`, `/api/history` | the hister read half, including CORS and `OPTIONS`                                  | yes    |
| S4    | `/search` dialect, `/api/add`, `/api/add_pdf`, `/api/delete`                                        | the search and delete assertions; `501` for facets and versions                     | yes    |
| S5    | `POST /ingest/session` + spool + fold                                                               | the agent daemon's own contract, unchanged                                          | yes    |
| S6    | retention, erasure, sensitive marking                                                               | the unit's pending erasure requirements                                             | no     |

## Conformance

The conformance suite is HTTP-level, which is the reason the port is tractable. `datalakehouse/tests/browse-daemon.sh` drives both faces over a throwaway store, and `tests/slurp-contract.mjs` posts through the Firefox extension's own record builders and reads the result back from both faces. Neither was rewritten. Two assertions are implementation-specific: the canonicaliser pair asserts the vendored Python module, and the wide-bind check starts the Python process. `BROWSE_TEST_EXTERNAL=1` makes the suite launch nothing and take `BROWSE_DB`, `BROWSE_HISTER_ADDR`, `BROWSE_PROMNESIA_ADDR` and the key from the caller; those two checks then report the external start-up contract, and every HTTP-level assertion runs unchanged. The Java fixtures cover the two: `CanonicalUrlTest` carries the golden pairs and `LakehouseApiTest` boots the real service on three ephemeral ports.

The agent leg's byte parity is checked against the Node daemon directly: the same body posted to both must produce the same spool line and the same `seen.sqlite` key, including a float, a value past 2^53 and a control character (`JsJsonTest` pins the formatting; the comparison is an operator check with `cmp` on the two spools). The run against the Java service, from the repository root, on the suite's ports and key:

```sh
repo=$PWD
./node-run.sh sbex/build.mjs -B -ntp -pl sbex-lakehouse -am -DskipTests package
tmp=$(mktemp -d); app=$(mktemp -d)
(cd "$app" && "$JAVA_HOME/bin/jar" xf "$repo/sbex/sbex-lakehouse/target/sbex-lakehouse-1.0.0-SNAPSHOT.jar")
BROWSE_DB="$tmp/browse.sqlite" BROWSE_TOKEN=secret TZ=UTC-2 \
  BROWSE_HISTER_ADDR=127.0.0.1:25433 BROWSE_PROMNESIA_ADDR=127.0.0.1:25434 \
  AGENT_INGEST_ADDR=127.0.0.1:25435 \
  java -cp "$app/BOOT-INF/classes:$app/BOOT-INF/lib/*" \
  com.example.sbex.lakehouse.LakehouseApplication &
BROWSE_TEST_EXTERNAL=1 BROWSE_DB="$tmp/browse.sqlite" \
  BROWSE_HISTER_ADDR=127.0.0.1:25433 BROWSE_PROMNESIA_ADDR=127.0.0.1:25434 \
  sh datalakehouse/tests/browse-daemon.sh
```

The unpacked layout is not incidental. `/api/add_pdf` starts a second JVM whose classpath is the running one, and a repackaged Boot jar has no plain classpath to hand it; the service logs the warning at startup and answers `500` on that one route. `LAKEHOUSE_PDF_CLASSPATH` supplies the classpath explicitly when the layout is a fat jar.

The unit's Node suite for the extension stays the producer fixture, including its fake WebExtension, so the port is tested against the real client code rather than a hand-written shape: the conformance run above reaches it through `slurp-contract.mjs`.

## Deferred and dropped

- **Cold generations** (the Parquet writer and demotion job) and the **MotherDuck fold** beyond the spool; the hot side's half of that contract is stated in The cold boundary, and [sbex-cold-persistence](cold-persistence.md) owns the tier's constraints and open decisions.
- **Erasure and retention**: tombstones mark, and the SMR generation that would scrub them is a pending decision of the unit.
- **`/api/facets` and `/api/versions`**: the routes answer `501` until a retention rule exists, which is the honest answer rather than a guessed model.
- **A reader for another hister server's storage**: the import wire exists and preserves a stored row, but reading that server's own files (a Bolt/Bleve store) is a separate job with its own dependency question.
- **Admission control**: no route rate-limits a compromised emitter. The plan's gap is unchanged by the port, and the body, row, URL, form and PDF ceilings are the bounds that do exist.
- **The web UI and the hister root page**: neither stock extension needs them.
- **The Firefox extension**: it is the producer and the fixture, so it does not move.

## What the groundwork already guarantees

The current daemons were audited against the example's persistence, observability and resource-isolation rules. The port must preserve these, not only the JSON shapes.

| Guarantee                    | Groundwork mechanism                                                                                                                                                                                       | What the port must not do                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| append-only archive          | every session insert is `ON CONFLICT DO NOTHING` on a natural key; first write wins                                                                                                                        | replace it with an update, or re-key a row on its file path    |
| no lost append               | the dedupe key is recorded only after the spool append; a failed append answers 500 and is retried                                                                                                         | record the key first, or treat the in-memory ledger as durable |
| stable identity              | a row without an id is hashed from canonical JSON, so rotation and a direct re-fold reproduce the key                                                                                                      | fall back to the spool line or `.rm.<pid>`                     |
| one live tail                | the sender only consumes frozen `.rm.*` tails; the recreated live path is left to the next fold                                                                                                            | read and `rm` the live path in one pass                        |
| one sender at a time         | every sender takes the same `<spool>.lock` (`flock`, or a pid-checked directory fallback); a second exits `75` and the daemon treats it as busy                                                            | rely on the daemon's in-process flag alone                     |
| a poison line is preserved   | a malformed or unidentifiable line goes to `<spool>.dead.ndjson` with its last session header and surrounding context; the tail is then consumable                                                         | skip the line silently, or block the whole tail forever        |
| visits are immutable         | the `visit` row is never updated; a late title or bookmark title fills `page_title`/`presence` and the read faces join it                                                                                  | `UPDATE visit SET locator_title …` for a later title           |
| media work is out of process | PDF extraction runs in a separate interpreter with CPU/address-space/file rlimits and a timeout; `BROWSE_PDF_RUNNER` can prefix a namespace/container wrapper; a parser crash is a 500, not a daemon crash | parse an arbitrary PDF inside the appender process             |
| errors are RFC 9457          | invalid values answer `application/problem+json` with a stable `type`, `title` and `status`                                                                                                                | answer `{"error": "…"}` with a framework or SQL string         |
| token off argv               | the token is exported as `motherduck_token`; no `SET` literal and no connection-string parameter                                                                                                           | put the token in `duckdb` argv or SQL                          |
| bounded allocations          | body, row, PDF, visited-URL, form-field and batch byte/row ceilings                                                                                                                                        | accept an unbounded body, form or PDF                          |
| fail closed on a wide bind   | the session route refuses a non-loopback bind without `AGENT_INGEST_TOKEN`; the browse daemon refuses a non-loopback bind without `BROWSE_TOKEN`                                                           | bind `0.0.0.0` with writes open                                |
| private store                | spool, ledger, lock and SQLite store are created `0600` in a `0700` directory                                                                                                                              | leave browsing history or transcripts world-readable           |
| one log line per request     | status, duration and accepted/duplicate counts on stdout; store errors stay in the log                                                                                                                     | return a `SQLException` message to the client                  |
| UTC storage                  | timestamps are normalised to UTC and compared as instants                                                                                                                                                  | store a numeric offset and compare the strings                 |
| a clear is a timestamp       | `history-cleared` hides visits up to its `deleted_at`, while the presence mark stays                                                                                                                       | drop the rows, or ignore the mark                              |
| a move is an event           | a bookmark upsert updates parent, position and title; `date_added` stays immutable                                                                                                                         | `INSERT OR IGNORE` a bookmark and keep the first walk forever  |

The shared sender lock, the dead-letter queue, the immutable `visit` row and the out-of-process PDF worker are landed. The remaining gap is admission control: no route rate-limits a compromised emitter (d181 says the route _can_ rate-limit; it does not yet). The port should also decide whether `seen.sqlite` keys are pruned by age; vacuuming keeps the file compact, not the key set bounded.

## Risks

- **Canonicaliser drift.** The Java port must fold the shapes the vendored Python folds, or `/visited` answers `null` for a page the extension already captured. `CanonicalUrlTest` is the guard, and the conformance run compares the result against the extension's own record builders; both belong in the build.
- **SQLite writers.** The two faces plus the ingest route in one JVM are one writer process by construction (one writer connection); a second process on the same file is where `SQLITE_BUSY` begins. The pool sizes and `busy_timeout` carry that risk, not the code.
- **Query-dialect fidelity.** The naive dialect is the contract; reaching for a full-text engine would answer queries the stock extension never sends while drifting from the ones it does.
- **PDF extraction.** `pypdf` and PDFBox disagree on text. The status code, the stored body and the index rebuild are the contract; the extracted string is not. The child JVM is the boundary, and its classpath requirement is the one deployment detail the layout has to honour.
- **Timestamp shape.** IXDTF with a numeric offset is trivial in Java and easy to get wrong with `toString()`; the extension's six-character slice is the test, and `Moments` is the only writer of that shape.
- **The spool is a second store.** A second writer, or a read of the live path while the daemon appends, reopens the rotation race the current sender closes. The port consumes the same NDJSON spool and appends by path, and the fold is the same shell sender under the same lock.
- **Unauthenticated reads.** The browse daemon's reads stay open because the stock Promnesia client cannot carry a key. A non-loopback bind is the operator's explicit choice, not a safe default; the refusal is a startup failure in `ListenerConfig`.

## References

- Protocol contracts: [d204](../docs/d204-firefox-slurp-extension-requirements.md), [d205](../docs/d205-hister-shaped-backend-requirements.md), [d181](../docs/d181-session-ingest-route.md), [d184](../docs/d184-postmortem-session-sweep.md)
- The daemons: `datalakehouse/browse-daemon.py`, `datalakehouse/agent-warehouse-daemon.mjs`, `datalakehouse/cannon.py`, `datalakehouse/tests/`
- The port: `sbex/sbex-lakehouse/src/main/java/com/example/sbex/lakehouse/` (`SurfaceFilter`, `SlurpIngest`, `PromnesiaService`, `HisterService`, `SearchIndex`, `CanonicalUrl`, `SessionSpool`) and its `LakehouseApiTest`
- Sibling notes: [sbex-persistence-engines](persistence-engines.md), [sbex-optimisation-findings](optimisation-findings.md), [sbex-sqlite-replication](sqlite-replication.md), [sbex-servlet-vs-reactive](servlet-vs-reactive.md)
