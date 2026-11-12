---
id: d175
type: architecture-design
status: active
title: "d175 — hister tiering: a bolt-on cold archive or an architecture change"
parent: architecture
references: [d172, d173, d174, datalakehouse, d177, personal-datalakehouse-prior-art]
tags: ["hister", "storage", "tiering", "cold-storage", "bleve", "duckdb", "parquet", "retention"]
---

# d175 — hister tiering

This record settles whether hister can run with cold storage or data tiers, and
what a bolt-on archive would cost. It covers hister's storage layout, the
settings that resemble tiering, and the shape a real cold tier requires. The
reader is whoever keeps hister's index under a storage budget, and whoever
decides between a scripted archive and a new pipeline. The finding is that hister
is a single-tier store: in-place tiering needs an architecture change, while a
scheduled export plus delete is a real but non-transparent degraded mode.

## Status

Reference analysis; no implementation action. Hister was read at `3414902b`, and
its storage layout comes from `docs/data-lifecycle.md`.

## Where hister stores data

| location                        | contents                                                       |
| ------------------------------- | -------------------------------------------------------------- |
| `index.db`, `index_LANG.db`     | Bleve searchable fields and full-text indexes                  |
| `data/html/`                    | content-addressed, compressed HTML previews                    |
| `data/favicon/`                 | content-addressed, compressed favicons                         |
| `db.sqlite3` or PostgreSQL      | users, sessions, history, crawl jobs, version diffs, job state |
| `vectors.sqlite3` or PostgreSQL | semantic chunks and vectors                                    |

Four stores, all hot, all served by one process under `app.directory`. Hister
applies no expiry, no maximum document count and no disk quota; the operator
manages storage. One page costs about 100 KB on average.

## What resembles tiering but is not

- `app.disable_previews: true` drops the HTML preview tier and keeps the text
  searchable; `hister reindex` removes the stored HTML. This is the closest
  built-in degraded mode, and it is a config flag.
- Skip rules and versioning rules decide what is stored, not where.
- `hister delete 'updated:>90d'` and `hister cleanup` remove data; they never
  demote it to a colder store.

## Why in-place tiering needs a change

- **No query federation.** `/search` is Bleve, `/api/document` is Bleve plus a
  content-addressed file, `/api/versions` is SQL, and semantic search is a
  third store. No layer can route a query to a second engine and merge the
  result, which is the hot-and-cold union problem of
  [d173](d173-browsing-history-storage-tiers.md).
- **Document identity is spread across four stores** under per-user ownership,
  rules and language sharding. A cold tier must move or rebuild all of them and
  preserve the identity.
- **Blobs are content-addressed and shared by hash**, so eviction needs reference
  counting plus a rehydration path.
- **Version diffs and crawl jobs live only in SQL** and are outside the natural
  snapshot unit, so a cold tier that drops them loses what `/api/versions` still
  serves.

## The bolt-on degraded mode

`hister export` writes JSON lines that include HTML and text, filterable by
query and by `--start-date`, and the output re-imports through
`hister import file`. A scheduled archive is therefore possible without touching
hister: export the cold range, load it into DuckDB or Parquet, then delete the
range. The cold half then sits **outside hister's API** — its search and document
endpoints do not answer from it, and the union query is not transparent.

A second lever is the read-only model mode (`mode=ro&nolock=1`), which serves a
frozen copy of the database. That is a cold replica, not a tier.

## The promnesia contrast

Promnesia needed a new backend because its reads were slow SQLite scans, so a new
pipeline was required regardless. Hister's reads are an inverted index and are not
the bottleneck; hister's tiering motive is storage cost and retention. That
reorders the effort: the config flags and the bolt-on archive come first, and
in-place tiers or a new pipeline come last, as
[d172](d172-push-based-browsing-index.md) and d173 already describe for the
browsing-history side.

## Where this points

Hister's search is its reason to exist, so a cold tier is only worth building
when full-text search still works over the cold data. That needs an index that
reads a bounded number of objects per query rather than a resident inverted
index, and cheap compute that scales to zero. The candidates — object-storage
index splits, or a columnar postings table in Parquet queried by DuckDB — are the
design follow-up this record points at; the design is
[d177](d177-cold-full-text-search.md). The wider landscape is
[personal-datalakehouse-prior-art](personal-datalakehouse-prior-art.md).
