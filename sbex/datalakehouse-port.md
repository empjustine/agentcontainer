---
id: sbex-datalakehouse-port
type: submodule-design
status: draft
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

This note is the contract for turning the example from an order toy into a service with a real workload. It inventories the four wire protocols the datalakehouse daemons speak, the Spring shape each one needs, the listener topology, and the slice order with its acceptance criterion. It is a plan and an inventory, not a port: no endpoint below exists in Java. The reader is the engineer landing the change, and arrives knowing the example's patterns and the four-engine matrix.

## Status

Draft. The inventory is extracted from `browse-daemon.py`, `agent-warehouse-daemon.mjs`, the unit's README and its HTTP-level test suites. The port is done when those suites pass against the Java service, with the one Python-specific canonicaliser assertion replaced by the golden fixture the Conformance section describes. The groundwork is no longer only a wire inventory: the current daemons already enforce the append-only and security rules the port must not regress (see What the groundwork already guarantees). The port is a rewrite of the mechanism, not a licence to reopen the gaps.

## What the port keeps and what it replaces

The example's patterns are the asset; the order domain is the placeholder. Keep the transaction boundary, the dedupe ledger, the bounded pools, the vendor dialect and the streaming read, and give them a workload whose invariants are already written down. The order example stays until a slice lands, and its retirement is its own record, under the log's mechanical-accuracy rule.

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

`POST /ingest/slurp` takes one stream-shaped envelope: `schema`, `producer`, `stream`, `stream_seq`, `checkpoint`, and a `records` array in which every record carries its own `src` and `kind`. Six kinds: `visit`, `title`, `bookmark`, `bookmark-removed`, `visit-removed`, `history-cleared`.

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
- **One application, two connectors.** `TomcatServletWebServerFactory#addAdditionalTomcatConnectors` binds both ports in one process, and a filter keyed on the local port enforces the surface rule. One image, one log stream, and the disjointness becomes a test rather than a structure.
- **One port behind a router.** The cheapest, and the one that makes the surface rule someone else's problem.

The recommendation is the first for the port's teaching value and the second if a single container is a requirement. The example's deployment notes own the footprint consequence either way.

## Storage

SQLite for the hot store, because the daemon's schema and semantics are SQLite's: `journal_mode=WAL`, `busy_timeout=10000`, `INSERT OR IGNORE`, and one writer. Tables: `visit`, `bookmark`, `page_title`, `tombstone`, `presence`, `document`, `rule`, `click`, `stream`, `term_stats`, `posting`, `doc_length`, `meta`. The session leg has its own store and transport: `seen.sqlite` is the durable dedupe ledger (vacuumed and WAL-checkpointed at start), the NDJSON spool is the append tail, `<spool>.dead.ndjson` is the append-only dead-letter queue, and `<spool>.lock` serialises every sender. Store timestamps in UTC; the read faces compare them as text.

This is the first workload that earns the SQLite leg of the engine matrix: the writer application pins its pool to one, the read faces get their own pool, and the WAL settings are the ones Litestream's caveats already require. The cold side — Parquet generations, ClickHouse-shaped postings, the MotherDuck fold — stays out of the port's first scope and keeps its pending items in the unit's records.

## Slices

| Slice | Routes                                                                                              | Acceptance                                                                          |
| ----- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| S1    | `POST /ingest/slurp`, schema, dedupe, canonicaliser                                                 | the slurp assertions of `tests/browse-daemon.sh`, plus the canonicaliser pairs      |
| S2    | `/status`, `/visited`, `/visits`, `/search`, `/search_around`                                       | the Promnesia half of the same suite, byte-for-byte field names and timestamp shape |
| S3    | `/api/config`, `/api/profile`, `/api/document` GET+HEAD, `/api/rules`, `/api/label`, `/api/history` | the hister read half, including CORS and `OPTIONS`                                  |
| S4    | `/search` dialect, `/api/add`, `/api/add_pdf`, `/api/delete`                                        | the search and delete assertions; `501` for facets and versions                     |
| S5    | `POST /ingest/session` + spool + fold                                                               | the agent daemon's own contract, unchanged                                          |
| S6    | retention, erasure, sensitive marking                                                               | the unit's pending erasure requirements                                             |

## Conformance

The conformance suite already exists and is HTTP-level, which is the reason the port is tractable. `datalakehouse/tests/browse-daemon.sh` drives both faces over a throwaway store, and `tests/slurp-contract.mjs` posts through the Firefox extension's own record builders and reads the result back from both faces. Neither needs a rewrite. Only the canonicaliser assertion inside the shell suite is Python-specific, and it becomes a golden fixture generated from the vendored `cannon` and replayed against the Java port. The suite now also covers a bookmark move, a history clear, an oversized body, a wide bind without a key, a failed append, a quarantined malformed line with its context, the shared sender lock, an append-only visit under a late title and a bookmark title, a PDF parser crash in its worker, an RFC 9457 problem body and the token staying out of `duckdb` argv; the Java service inherits those as the acceptance floor.

The unit's Node suite for the extension stays as the producer fixture, including its fake WebExtension, so the port is tested against the real client code rather than a hand-written shape.

## Deferred and dropped

- **Cold generations** (Parquet demotion, ClickHouse-shaped postings) and the **MotherDuck fold** beyond the spool, which need the archive leg the engine note plans; [sbex-cold-persistence](cold-persistence.md) owns that tier's constraints and open decisions.
- **Erasure and retention**: tombstones mark, and the SMR generation that would scrub them is a pending decision of the unit.
- **`/api/facets` and `/api/versions`**: `501` is the honest answer until a retention rule exists.
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

- **Canonicaliser drift.** The Java port must fold the shapes the vendored Python folds, or `/visited` answers `null` for a page the extension already captured. A differential fixture over generated URLs is the guard, and it belongs in the build.
- **SQLite writers.** Two faces plus an ingest route in one JVM is one writer process; a second process on the same file is where `SQLITE_BUSY` begins. The pool sizes and `busy_timeout` carry that risk, not the code.
- **Query-dialect fidelity.** The naive dialect is the contract; reaching for a full-text engine would answer queries the stock extension never sends while drifting from the ones it does.
- **PDF extraction.** `pypdf` and PDFBox disagree on text. The status code, the stored body and the index rebuild are the contract; the extracted string is not. Run PDFBox in the same out-of-process boundary: the PDF is the one input whose parser sees arbitrary bytes.
- **Timestamp shape.** IXDTF with a numeric offset is trivial in Java and easy to get wrong with `toString()`; the extension's six-character slice is the test.
- **The spool is a second store.** A Java port that adds a second writer, or reads the live path while the daemon appends, reopens the rotation race the current sender closes. The port should consume the same NDJSON spool, not invent a parallel one.
- **Unauthenticated reads.** The browse daemon's reads stay open because the stock Promnesia client cannot carry a key. A non-loopback bind is the operator's explicit choice, not a safe default; the port must keep the refusal.

## References

- Protocol contracts: [d204](../docs/d204-firefox-slurp-extension-requirements.md), [d205](../docs/d205-hister-shaped-backend-requirements.md), [d181](../docs/d181-session-ingest-route.md), [d184](../docs/d184-postmortem-session-sweep.md)
- The daemons: `datalakehouse/browse-daemon.py`, `datalakehouse/agent-warehouse-daemon.mjs`, `datalakehouse/cannon.py`, `datalakehouse/tests/`
- Sibling notes: [sbex-persistence-engines](persistence-engines.md), [sbex-optimisation-findings](optimisation-findings.md), [sbex-sqlite-replication](sqlite-replication.md), [sbex-servlet-vs-reactive](servlet-vs-reactive.md)
