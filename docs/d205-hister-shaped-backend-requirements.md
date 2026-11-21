---
id: d205
type: architecture-design
status: draft
title: "d205 — the hister-shaped backend: L2 API on L1 behavior, the hister extension as a client, and local SMR as the authoritative cold copy"
parent: architecture
depends-on: [d173, d175, d176, d177, d178]
references: [d172, d174, d203, d204, datalakehouse, personal-datalakehouse-prior-art]
tags:
  [
    "hister",
    "promnesia",
    "search",
    "storage",
    "parquet",
    "duckdb",
    "bm25",
    "requirements",
    "cold-storage",
  ]
---

# d205 — the hister-shaped backend

This record turns "pretend it is hister, with cheaper storage and slower search" into a requirements register. It fixes the compatibility surface, the two browsers' clients, the two fact tables, the local-SMR authority rule, and the cold-search shape. It covers the backend only; the history and bookmark producer is d204 and the hister-side content producer is the stock hister extension. The reader is whoever specifies or builds the replacement. The settled part is the API surface and the storage authority; the pending part is deletion, retention, and the offsite copy.

## Status

Draft — a requirements register. The compatibility and authority decisions below are recorded. The hot endpoint is built at [`datalakehouse/browse-daemon.py`](../datalakehouse/browse-daemon.py) over SQLite, its call set is pinned against the current upstream extension (see [Verified against upstream](#verified-against-upstream)), and the cold tier remains unchosen. The hot store now carries a cold-shaped postings index: a term dictionary and posting lists sorted by term (see [The search contract](#the-search-contract)), so the Parquet rewrite is a row-group copy rather than a redesign.

## The target

The target has four parts:

- **L2 API, L1 behavior.** The backend exposes the hister HTTP API and the Promnesia HTTP API, so the stock hister browser extension and the stock Promnesia extension work. The behavior inside the hot availability bounds is L1: the same facts and query semantics, not hister's live-search quality. "Good search" and "immediate results" are not promised; a cold query may take seconds or minutes, and the user accepts the hit to keep hister at a lower cost.
- **Two browser clients.** The Promnesia extension is the sidebar and visited-mark client. The hister extension is the content-capture and search client; it also reads the indexing rules, including the skip/denylist, from the backend. The hister web UI is out of scope.
- **No semantic search in v1.** The hister API accepts the semantic parameters and reports semantic search disabled. If a cold vector index lands later, it must be cold-storage friendly and scale to zero like the text index.
- **Local SMR is the authoritative cold copy.** It holds the Parquet generations. It loses authority only when a scrub proves corruption; then the affected generation is quarantined and the offsite copy, if one exists, is the recovery source. Offsite backup is a pending issue, so a corrupt SMR generation with no other copy makes the affected range unavailable rather than silently authoritative.

## Compatibility

| level                | promise                                                                     | decision                                    |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| L1 data and behavior | the same facts and query semantics; import/export through the hister format | in force inside the hot availability bounds |
| L2 API               | the hister HTTP endpoints and JSON shapes, plus the Promnesia endpoints     | in force for the browser clients            |
| L3 UI                | hister's web UI runs unchanged                                              | out of scope                                |

The L2 promise is limited to the endpoints the browser clients call. The web app's preview, rule-preview, and facet UI are not compatibility targets. The exact JSON models for document, version, label, and history responses remain research; an L2 promise cannot ship with guessed fields.

## The clients and their API surfaces

### The Promnesia extension

The Promnesia face is the hard sidebar consumer. Its semantics are narrow:

- `/visited` takes a URL list and returns one entry per input in order, either a visit or `null`; the match is exact after canonicalization.
- `/visits` matches the normalized URL exactly, plus child URLs that carry context.
- `/search` searches query text in the normalized URL, original URL, context, and locator title.
- `/search_around` answers the three hours before through two minutes after a Unix timestamp.
- `/status` reports version, database path, and stats, and keeps answering when a subsystem fails.

`/visited` is the one hot real-time read of d178. The presence table must answer for every URL ever seen, including URLs whose full visit rows are cold.

### The hister extension

The hister extension is a producer and a client. It stays a client of the browser
vendor: the stock extension is the compatibility target, and a replacement is
justified only by a behaviour gap. If one is built, it is its own extension
beside the history and bookmark producer, not a mode of it — the content
permission it needs (every site, a content script) is exactly what d204 keeps out
of that producer, and one manifest with both would put page-content access inside
the extension that also deletes browser history. Its call set, read from the
hister extension and route code, includes:

| method and path            | purpose                                                        | backend requirement                                                                                                         |
| -------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /search`              | the extension search popup, and the web app search             | serve the JSON search; no live-search latency promise                                                                       |
| `GET /api/config`          | verify the server URL and read configuration                   | return valid JSON; the exact fields are research                                                                            |
| `GET /api/profile`         | read the owner id                                              | `200` with no body in single-user mode, as upstream does; a synthetic `user_id` makes the extension believe it has accounts |
| `GET /api/rules`           | fetch the allow, skip, priority, versioning, and aliases rules | serve the control-plane rules with a fast, small read                                                                       |
| `POST /api/rules`          | save an updated skip/allow list                                | accept form fields `allow`, `skip`, `priority`, `versioning`                                                                |
| `POST /api/add`            | submit a captured page                                         | validate, rule-check, store text and HTML, return `201`; `406` for a skip rule and `422` for sensitive content              |
| `POST /api/add_pdf`        | submit a PDF page                                              | accept a base64 PDF, extract its text and store it; `201` on success, `500` when no text is extractable                     |
| `HEAD /api/document?url=…` | check whether a URL is already indexed                         | answer from the presence index; `200` means indexed                                                                         |
| `POST /api/delete`         | delete a document after a skip-rule action                     | take `{query, dry_run}` in the same dialect as `/search` and answer `{matched}` or `{deleted}`; a capture is not a visit    |
| `POST /api/history`        | record a search-result click when history is enabled           | accept the history row; optional                                                                                            |
| `POST /api/label`          | apply or clear a label on a URL                                | accept `{url, label}`; empty label clears                                                                                   |

`/api/versions` and `/api/facets` are server endpoints, but the hister extension's core capture flow does not establish a call to them; the web app owns the preview and facet UI. They remain optional until the extension is tested against the backend.

The rules endpoint is a second control-plane read on the capture path. The extension caches it for about 60 seconds and falls back to the previous or empty lists on failure. It is small and always available; it does not change d178's statement that the visited check is the one hot data read.

### The custom slurper

The history and bookmark producer of d204 uses a custom slurper verb, not the session route of d181. It carries visits, bookmarks, and tombstones. The daemon's dedupe key is `(src, kind, key)`; a re-sent batch is absorbed.

## Ports and the shape of the process

Each client keeps the port it already defaults to: the hister API answers on
`127.0.0.1:4433` (hister's own default) and the Promnesia protocol on
`127.0.0.1:13131` (Promnesia's), so a stock extension is pointed at a stock
port with no editing. The producer's ingest edge shares the hister listener:
it writes the same store, so one process keeps one writer and one schema, and
the batch envelope is the boundary that would let it move to its own stack
without a client change. Neither listener answers the other's paths.

Settled by that split and by the producer's decisions: **erasure** follows the
producer's visibility — an observed removal is applied to the read faces (a
bookmark row may be compacted away, a page mark keeps the visit rows behind it,
because the visit that was deleted cannot be named); **retention** in the
archive is indefinite, while only what a read immediately needs stays hot, so
the cold tiers of d173 and d177 hold the rest, starting with page text and HTML;
**static keys and semantic search are out of scope** for now.

## The data model

The model is fixed at the fact level and open at the field level:

| table             | facts                                                                                                                 | open questions                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| visit             | `norm_url`, `orig_url`, `dt`, `locator_title`, `locator_href`, `src`, `context`, `duration`, visit key                | is `duration` available from Firefox, and what is `src` for a bookmark versus a page?   |
| document          | `norm_url`, owner, `title`, `text`, HTML ref, favicon ref, language, `added`, `updated`, `add_count`, label, metadata | is text stored once per URL or per version?                                             |
| document version  | document id, created time, HTML diff, text diff                                                                       | does the hister extension read `/api/versions`?                                         |
| bookmark/context  | bookmark id, folder path, title, URL, position, added                                                                 | is folder order a fact or a view?                                                       |
| presence          | `norm_url` to best locator or seen flag                                                                               | is the value a rowid, a hash, or the locator?                                           |
| postings          | term, document id, term frequency, positions                                                                          | positions required for phrase search?                                                   |
| term stats        | term, global document frequency, average length                                                                       | per language or global?                                                                 |
| rules             | allow, skip, priority, versioning, aliases                                                                            | what pattern grammar does the hister extension compile?                                 |
| labels and facets | document id, label, facet values                                                                                      | which facets are configured, and who configures them?                                   |
| query history     | query, click, pin, timestamp                                                                                          | is hister's history view in scope?                                                      |
| tombstone         | kind, key, deleted time, source                                                                                       | settled by d204's visibility rule: a bookmark tombstone erases, a visit tombstone marks |

The visit and document tables are d176's; the rest is the storage shape d177 requires. A single user means `owner` is a constant column rather than a key, but the column stays so the hister contract's per-owner scoping is representable.

## The search contract

The contract states what "search" means before a store is chosen:

- **Ranking** — BM25 with field boosts for title, text, and URL. Hister's Bleve mapping indexes title and text as text and URL, domain, label, and language as keywords. The hot implementation is a term dictionary plus posting lists sorted by term (no positions), the ClickHouse-shaped index that a Parquet rewrite keeps as row groups.
- **Analysis** — the producer supplies text and a language tag; the backend's analyzer is an implementation detail. Content form, extraction, and the language set are producer-side concerns, not backend requirements.
- **Query forms** — terms, quoted phrases, prefixes, field filters, date filters and `match_all` are implemented; facets and the WebSocket stream are not. The phrase is a candidate filter over the stored text, not a positional lookup, because the cold layout carries no positions.
- **Results** — document id, URL, title, snippet, score, added/updated, add count, label, language, favicon, and a content reference. A snippet comes from the docs table, never from the full HTML during search.
- **Facets** — domain, language, label, and a date histogram, with per-facet sizes. Facets are optional until the hister extension is tested.
- **Pagination** — `page_key` or an offset. The cold index needs a cursor that maps to a partition and an offset, not a deep row offset.
- **Freshness** — no SLO. A new visit is searchable after the next compaction or generation; the user accepts the delay.
- **Latency** — no SLO. A cold query may take seconds or minutes; a first touch of an SMR generation is deferred rather than failed. The user accepts the quality and responsiveness hit to keep the store cheap.
- **Semantic search** — hister offers it, so the API accepts the parameters. V1 reports `semantic_enabled=false`; when it is enabled, the vector index must live in the cold tier and scale to zero, not as a resident vector store. The cold vector index is a conditional requirement, not a v1 build.
- **Empty and failure behavior** — a missing cold archive defers the query; a missing hot presence row must not mark a visited URL unvisited.

## The storage contract

- **Hot zone** — SQLite staging for ingest, a DuckDB or SQLite presence table, recent documents, term statistics, the cold manifest, the rules table, and the query cache. All of it on SSD or NVMe.
- **Cold zone** — zstd Parquet for full visit rows and out-of-window history; postings and docs partitioned by term prefix, month, domain, or language; content-addressed HTML and favicon blobs. The local SMR disk holds the authoritative generations.
- **Authority** — the local SMR copy is authoritative. A generation is trusted until a scrub finds a checksum, row-count, or manifest mismatch. A proven-corrupt generation is quarantined, its range is marked unavailable, and the offsite copy is the only recovery source. Offsite backup is a pending issue, so a corrupt generation with no offsite copy is a real data loss, not a silent fallback.
- **Partitioning** — the partition key is the pruning key. The sort order is `norm_url` or term, so zone maps and row-group statistics can skip a partition before the postings are read.
- **Blobs** — HTML and favicon are content-addressed and shared by hash. A document row carries a reference, not the bytes. Text is in the docs or postings table, not duplicated in a blob.
- **Versions** — hister implements version history, so the backend implements `/api/versions` and stores diffs. The ELT prune/compaction purges versions older than the retention window, and may purge all but the current version if the hister extension is shown not to call `/api/versions`. The exact rule is pending with retention.
- **Deletes and updates** — immutable Parquet needs tombstones and a compaction generation. What a tombstone may erase follows d204's visibility rule: a bookmark tombstone names an exact node and may be compacted away, a visit tombstone names only a page and stays a mark. The compaction cadence is still open. A later title or bookmark title fills `page_title`/`presence` and the read faces join it; it never updates the `visit` row, so the visit table stays append-only for the cold generation.
- **Durability** — the SMR spindle is a single point of failure. Offsite backup is pending; the scrub is the mechanism that decides whether the authoritative copy is still trustworthy.
- **Cost** — the session measurement of d203 shows zstd Parquet at roughly five to eight times smaller than the same rows in MotherDuck's native table. The browsing corpus size is a producer-side property; d175's roughly 100 KB per page is the only prior estimate.
- **Scale** — the backend does not set a corpus-size or language target; those are the producer's concerns. It scales by adding Parquet generations and by keeping the hot window fixed.

## The ingest contract

The backend has two producers:

- **d204** sends visits, bookmarks, and tombstones through the custom slurper.
- **The hister extension** sends page documents through `/api/add` and PDFs through `/api/add_pdf`; it reads rules from `/api/rules` and labels from `/api/label`.

The server pins:

- **Canonicalization** — the daemon normalizes every URL with the vendored `cannon`; the producers send raw URLs. The same normalized URL is the document key.
- **Dedupe** — visits by their own key, documents by normalized URL and owner, versions by the version rule, tombstones by their key.
- **Extraction** — the hister extension is the content producer. It extracts text and HTML and posts both; the backend does not own extraction, content form, or language detection.
- **Rules** — allow and skip patterns, priority, versioning, and aliases are served to the extension and applied server-side. The extension caches them for about 60 seconds. The pattern grammar must match what the extension compiles.
- **Labels** — a label is a document attribute; an empty label clears it.
- **Backfill and live merge** — one path for both, with the same identity and the same version rule.
- **Privacy** — history, bookmarks, and page content are sensitive. Datensparsamkeit applies: capture what a query needs, not every byte a page offered.

## The operating contract

- **Single user** — no tenancy, no per-user isolation beyond the owner column. `/api/profile` answers 200 with no body, upstream's single-user shape; the extension reads that as user 0 and never enables account-only paths.
- **Auth** — static keys are possible and disabled by default; loopback is the default trust boundary. The extension carries the key in background storage.
- **One container and one volume** — the daemon holds staging and the gold zone; the SMR archive is mounted.
- **Scale-to-zero** — the cold query worker starts on demand; the presence table and the rules table stay resident. A serverless function, a KEDA-scaled worker, or socket activation are the candidates.
- **Offline and degraded** — the visited check answers from the presence table while the archive or the network is absent; a cold query is deferred, not failed.
- **Observability** — ingest counts, duplicate counts, query timings, object reads per query, storage by tier, scrub results, and a visible cold-index generation.
- **Licensing** — clean-room reimplementation; no hister AGPL code across the network boundary; Promnesia's MIT `cannon` is the only vendored piece.
- **Dependencies** — DuckDB, Parquet, a tokenizer/stemmer, a readability library only if the backend extracts (it does not in this scope), and an embedding runtime only if semantic search lands. Every one is a vetted dependency under the repo's rule.

## Verified against upstream

The call set, the JSON shapes and the wire details below are read from the
current upstream sources rather than assumed: `karlicoss/promnesia`
`src/promnesia/server.py` and `src/promnesia/cannon.py` for the Promnesia face,
and the hister extension under `webui/ext/src/` plus
`server/api.go`/`server/endpoints.go`. The hister repository now redirects to
`asciimoo/nogon`; its extension still calls the same capture/rules/document
set, so the pinned surface is unchanged, while the server has grown endpoints
the extension does not call. What that settles:

- **The extension's own call set** is `GET /api/profile`, `GET /api/config`,
  `GET`/`POST /api/rules`, `HEAD /api/document`, `POST /api/add`,
  `POST /api/add_pdf`, `POST /api/delete`, `POST /api/label` and
  `POST /api/history`. It does **not** call `/api/versions`, `/api/facets` or
  `/search`; the web UI does, and the web UI is out of scope. The version-purge
  path is therefore unblocked, and facets stay optional.
- **`/api/config`** needs a 200 and valid JSON; the popup discards the body.
  **`/api/profile`** is read for `user_id`; upstream's single-user mode answers
  200 with no body, and the extension treats the absent field as user 0.
- **`/api/rules`** GET returns `{allow, skip, priority, versioning, aliases}`;
  POST is **form-encoded** and each field is a space-separated list of regular
  expressions. The grammar is Go's RE2, which the Python `re` used here accepts
  as a superset.
- **`/api/document`** is a GET; a HEAD probe is that same route, so both must
  answer 200 or 404. **`/api/delete`** takes `{query, dry_run}` and answers
  `{deleted}` or `{matched}` — it is a query, not a URL.
- **Auth** is the `X-Access-Token` header. **CORS** answers the extension's
  origins (`moz-extension://`, `safari-web-extension://`, one Chrome id) on the
  extension's paths, echoing `Access-Control-Request-Headers`; Chrome and
  Firefox exempt an extension background fetch, Safari preflights.
- **Promnesia's face** is its `server.py` envelope: both GET and POST on every
  path, the `{original_url, normalised_url, visits}` shape, `/visited`
  returning one entry per input in order with `null` for an unseen URL,
  `/visits` adding child URLs whose context is set, and `/search_around`
  answering the placeholder `http://dummy.org` URL. The timestamp is IXDTF in
  numeric-offset form in the host's timezone rather than upstream's legacy
  `'%d %b %Y %H:%M:%S %z'`; the extension's `Date.parse` and its six-character
  slice accept the offset form and then see the correct local wall clock.
- **`/search` is shared** by the two protocols: the daemon answers Promnesia's
  visit search when the request carries `url`, and the hister query dialect for
  a `text`/`q`/`match_all` request, on either listener.

## Pending issues

The following are explicitly pending, not settled:

- **Erasure execution** — the granularity is settled by d204's visibility rule (bookmark tombstones erase, visit tombstones mark); what remains is whether a restore of an older generation can resurrect an erased bookmark, and whether the offsite copy must honour the tombstones when it is written.
- **Retention** — how long history, bookmarks, page text, HTML, and versions stay in the hot and cold zones.
- **Offsite backup** — whether a second copy exists, where it lives, and how it is restored; without it, a corrupt SMR generation is unrecoverable.
- **Corruption recovery** — the exact scrub cadence, the checksum source, and the operator action when a generation fails.
- **Semantic/vector search** — a cold, scale-to-zero vector index if the hister extension needs it.
- **Version purge** — the version-retention rule and whether `/api/versions` is in the hister extension's required surface; the ELT prune purges old versions under that rule.

## User input required

The compatibility surface is decided by the two browser clients; the remaining decisions are:

1. Which hister extension features are required beyond capture and rules — PDF capture, labels, history, versions, facets, or semantic search? The API surface follows the extension's calls.
2. Is a second local copy of the SMR archive acceptable, or is the offsite copy the only redundancy?
3. Is a corrupt SMR generation with no offsite copy acceptable data loss, or must the design keep a second copy before the archive is trusted?
4. Does a tombstone delete a visit or document, or only mark it?
5. What retention windows apply to history, bookmarks, text, HTML, and versions?
6. Is static-key authentication enabled for the daemon? d204 owns the producer side of that decision.

## Research needed

- Pin the JSON model of `/api/add`'s response and of `/api/history`'s request body; the call set and the other shapes are settled in [Verified against upstream](#verified-against-upstream).
- Read hister's Bleve mapping and query construction for tokenizer, stemming, boosts, facets, and ranking.
- Verify the Promnesia `/visits` child-URL behavior and `/search_around` window against the pinned version.
- Test DuckDB FTS and `vgi-tantivy` for BM25 quality and per-query cost against the Parquet-postings design.
- Measure the object count and bytes per query for the term-prefix partition at the real term distribution.
- Measure SMR read latency, scrub cost, and the generation layout.
- Measure tombstone and compaction cost for the expected delete rate.
- If semantic search lands, measure the embedding model's storage and query cost.

## Alternatives rejected

- **L3 hister UI compatibility.** The web UI is out of scope; the browser extension is the client.
- **Wire-compatible hister as the only target.** The API is a compatibility surface, but hister's single-tier storage and live-search assumptions are not.
- **Fork hister and tier it in place.** d175 answers it: the four stores, the shared blobs, the SQL-only versions, and the absent query federation make in-place tiering an architecture change.
- **All-hot Bleve or SQLite FTS.** It is the storage cost d173 exists to remove.
- **All-cold with no presence table.** The visited check is the one hot data read; a cold check marks visited links unvisited.
- **Semantic search first.** It adds an embedding model, a vector store, and a second index before the BM25 path is measured.
- **Offsite storage as the authoritative copy.** The local SMR copy is authoritative; the offsite copy is a backup and a recovery source, not the primary.
- **A second engine beside DuckDB.** d177's Parquet postings and d173's lakehouse keep one query engine; a second engine is a second dependency, a second consistency problem, and a second failure mode.

## Where this lands

The history and bookmark producer is d204. The hot/cold split is d173, the cold-search mechanism is d177, and the workload is d178. The unit that would own the daemon and the store is [`datalakehouse/`](../datalakehouse/README.md), which already carries the atuin and session legs; the browsing backend extends that unit rather than opening a third storage path.
