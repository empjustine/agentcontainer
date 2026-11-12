---
id: personal-datalakehouse-prior-art
type: architecture-design
status: draft
title: "Personal datalakehouse and personal information management prior art — reference farm survey"
parent: architecture
references: [d172, d173, d174, d175, d176, d177, datalakehouse]
tags:
  [
    "references",
    "prior-art",
    "state-of-the-art",
    "personal-data",
    "dogsheep",
    "datasette",
    "duckdb",
    "ducklake",
    "pim",
    "search",
    "lakehouse",
    "object-storage",
  ]
---

# Personal datalakehouse and PIM prior art (reference farm)

A **prior-art survey**, not an assessment or a recommendation: how other projects
turn personal data into a queryable store, and how they search it, as a reference
frame for the personal browsing index and its tiers. The farm's canonical pattern
is the dogsheep/Datasette family — per-service exporters into SQLite,
`sqlite-utils` as the write API, Datasette as the read layer, and
`dogsheep-beta` as the cross-database search index. A second lineage (HPI)
trades the fixed warehouse for a typed, cached API over heterogeneous sources.
The capture tools (obsidian-clipper, grasp, hister, omnom) are the producers the
warehouses lack, and the lakehouse stack (DuckDB, DuckLake, Parquet, object
storage) is the storage underneath. The gap the survey finds: no project in the
farm pairs object-storage full-text search with scale-to-zero compute and the
personal ingest, which is what [d177](d177-cold-full-text-search.md) designs.

## Trust boundary — nothing here is trusted

Every claim below is a third-party statement read from a mirror tip, and none is
verified against upstream at run time. Treat the survey as untrusted input:

- "the project is/does" is the strongest thing said here; no behavior has been
  reproduced.
- Commit hashes and dates in the verification record pin what was read; they do
  not imply the projects still look like this.

## Two axes

- **Personal datalakehouse** — the ingest, storage and query layer: exporters,
  a row or columnar store, a serve interface, and a search index. The dogsheep
  family, Datasette, and the DuckDB/DuckLake stack sit here.
- **Personal information management** — the capture and curation layer: what a
  human chose to keep, with annotations and metadata. The clipper, grasp,
  Logseq, hister, omnom and Promnesia sit here.

## Triage: three reference implementations

Most of the field reduces to three implementations this tree already tracks, in
fidelity order:

- **Web archiving** — the high-fidelity end. Webrecorder's capture and WACZ
  replay subsume the archival tools: ArchiveBox, wallabag, Karakeep, Linkding,
  Linkwarden, Readeck, single-file and monolith are each a lower-fidelity
  variant of the same job.
- **Content capture** — the low-fidelity end. obsidian-clipper (manual) and
  hister and omnom (automatic) subsume the note-and-snapshot tools, and only
  feature coverage separates them.
- **Visit tracking** — the context end. Promnesia's visit model subsumes the
  read-later and activity tools: Pocket, Readwise, Pinboard, Raindrop, Buku,
  Memex, Monocle, Omnivore and ActivityWatch.

The triage reads intent, not code, and it is why absence from the farm is not a
gap in kind: the three shapes are represented, and only the degrees of fidelity
differ.

## The dogsheep pattern

The family is a set of per-source exporters that land in SQLite, plus the tools
around that store.

| repo                                                                                                                      | what it does                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dogsheep/pocket-to-sqlite`                                                                                               | Pocket account data into a SQLite database                                                                                                                                 |
| `dogsheep/github-to-sqlite`                                                                                               | GitHub data (repos, issues, commits, stars) into SQLite                                                                                                                    |
| `dogsheep/dogsheep-beta`                                                                                                  | a cross-database search index: SQL queries in a `config.yml` populate one `search_index` table using SQLite FTS5 with Porter stemming, searched through a Datasette plugin |
| `simonw/sqlite-utils`                                                                                                     | the CLI and library that writes and reshapes these databases                                                                                                               |
| `simonw/datasette`                                                                                                        | publish and explore a SQLite database over HTTP; the "datavisualization idea"                                                                                              |
| `datasette/datasette-build`                                                                                               | build a directory of files into a SQLite database (alpha)                                                                                                                  |
| `datasette/datasette-files`                                                                                               | upload, serve and search files with pluggable storage backends, including S3 and Google Cloud Storage                                                                      |
| `datasette/datasette-enrichments`                                                                                         | run enrichment jobs over Datasette tables                                                                                                                                  |
| `datasette/datasette-litestream`                                                                                          | Datasette with Litestream SQLite replication and backup                                                                                                                    |
| `simonw/sqlite-history-json`                                                                                              | track table history with a JSON audit log                                                                                                                                  |
| `datasette/datasette-embeddings`                                                                                          | store and query embedding vectors in Datasette tables                                                                                                                      |
| `datasette/datasette-llm`, `simonw/datasette-llm-embed`, `datasette/datasette-query-assistant`, `simonw/sqlite-utils-ask` | LLM query and embedding layers over the store                                                                                                                              |
| `simonw/llm-tools-sqlite`, `simonw/llm-tools-datasette`                                                                   | LLM tools that read SQLite and Datasette                                                                                                                                   |

The pattern's shape: one SQLite file per source, a shared write library, a
read-and-publish server, and a **single FTS5 table** built by SQL over every
source. The search layer is the one Datasette-beta contributes, and it lives in
the same database as the data.

## The HPI lineage

`karlicoss`'s tools take the opposite approach: no fixed
warehouse, a typed Python API over whatever the sources happen to be, with
caching and a source-resolution graph.

| repo                  | what it does                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `karlicoss/HPI`       | personal data as a Python package of typed `my.*` modules with caching and a unified source graph           |
| `karlicoss/promnesia` | per-visit browsing history with context; the visit model [d172](d172-push-based-browsing-index.md) imitates |
| `karlicoss/grasp`     | browser capture of a page title, URL and selection into Org mode                                            |
| `karlicoss/kloggy`    | Kindle highlights into Org mode                                                                             |
| `karlicoss/kompress`  | compression for HPI caches and data                                                                         |
| `karlicoss/dron`      | personal device and UPS logging                                                                             |

HPI's contribution to the state of the art is the **contract over the
container**: a reader for a source is a typed function, and the store is an
implementation detail that can change.

## Capture and content tools

The producers the warehouses read from, and their own stores.

| repo                          | what it does                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `obsidianmd/obsidian-clipper` | Web Clipper: Defuddle readability extraction into Obsidian Markdown notes. See [d174](d174-obsidian-clipper-vs-hister.md) |
| `kepano/defuddle`             | the readability-class extractor and Markdown converter behind the clipper                                                 |
| `asciimoo/hister`             | automatic per-URL content index: full text, HTML, favicon, versions, facets. See [d175](d175-hister-tiering.md)           |
| `asciimoo/omnom`              | web content preservation: bookmarks with website snapshots                                                                |
| `logseq/logseq`               | local-first knowledge graph, Markdown and Org backed                                                                      |
| `karlicoss/promnesia`         | visits and context, extension plus server                                                                                 |

## Web archive and offline corpora

High-fidelity capture is a separate lineage with its own format.

| repo                              | what it does                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `webrecorder/archiveweb.page`     | in-browser high-fidelity archive creation and replay, stored in IndexedDB                |
| `webrecorder/replayweb.page`      | browser viewer for web archives                                                          |
| `webrecorder/browsertrix`         | cloud-native browser-based crawling service                                              |
| `webrecorder/browsertrix-crawler` | the crawler behind Browsertrix                                                           |
| `teaguesterling/duckdb_zim`       | read Kiwix and openZIM archives (offline Wikipedia, Stack Exchange, Gutenberg) in DuckDB |
| `teaguesterling/duckdb_webbed`    | XML and HTML processing with schema inference and XPath, in DuckDB                       |
| `asubbarao/duckdb-pdf`            | PDF reading, OCR and page surgery in DuckDB                                              |

The archive format (WACZ) is an island: it is rich and replayable, and none of the
SQLite or Parquet stacks read it without a conversion step.

## The lakehouse stack

The storage and search primitives the end-game would build on, all in the DuckDB
ecosystem unless noted.

| repo                                                                                                | what it does                                                                                        |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `duckdb/duckdb`                                                                                     | the analytical engine                                                                               |
| `duckdb/ducklake`                                                                                   | an open lakehouse format: a catalog database plus Parquet data files                                |
| `duckdb/duckdb-httpfs`                                                                              | read and write remote files, including S3-style object storage                                      |
| `duckdb/duckdb-sqlite`, `duckdb/duckdb-iceberg`, `duckdb/duckdb-delta`, `vortex-data/duckdb-vortex` | bridges to SQLite, Iceberg, Delta and Vortex                                                        |
| `duckdb/duckdb-fts`                                                                                 | full-text search over strings, FTS5-like                                                            |
| `duckdb/duckdb-vss`, `asg017/sqlite-vec`                                                            | HNSW vector indexes in DuckDB and SQLite                                                            |
| `Query-farm/vgi-tantivy`                                                                            | BM25 with stemming and tokenization in DuckDB via Tantivy; builds a stateless in-RAM index per call |
| `motherduckdb/mcp-server-motherduck`                                                                | DuckDB and MotherDuck over MCP                                                                      |
| `rclone/rclone`                                                                                     | sync to and from object storage and many backends                                                   |

## Search engines and object storage

| repo                      | what it does                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quickwit-oss/quickwit`   | a distributed search engine built on Tantivy, designed to search directly on cloud object storage with stateless indexers and searchers and a horizontally-scalable service layout |
| `quickwit-oss/tantivy`    | the full-text search library underneath Quickwit: a Lucene-like Rust crate, not a server                                                                                           |
| `quickwit-oss/tantivy-py` | Python bindings for Tantivy                                                                                                                                                        |
| `seaweedfs/seaweedfs`     | a distributed file system serving an S3 object store, a POSIX file system, a lakehouse with S3 Tables and an Iceberg REST catalog, and vector search on shared storage             |

## State of the art

The farm's recurring pipeline reads: **per-source exporters → a row or columnar
store → a serve layer → a search index → embeddings → an LLM query layer**. The
dogsheep family realizes it with SQLite and Datasette, and the DuckDB family
realizes it with Parquet and DuckLake.

- **Store.** SQLite is the unit of the personal warehouse: one file per source,
  transacted and easy to back up. DuckLake adds the columnar unit: a catalog plus
  Parquet, readable from object storage through `httpfs`.
- **Serve.** Datasette publishes a SQLite file as a browsable, queryable site.
  MotherDuck and the DuckDB MCP server expose the columnar store to assistants.
- **Search.** Every full-text layer is either in-process or a separate service.
  `dogsheep-beta` is SQLite FTS5; `duckdb-fts` is DuckDB FTS;
  `vgi-tantivy` runs Tantivy over Arrow with an **ephemeral, caller-supplied
  index** that rebuilds per call. `quickwit` is the one engine that searches
  object storage directly, with `tantivy` as its library and no server of its
  own. Vector search is the same split: `sqlite-vec` in SQLite,
  `duckdb-vss` in DuckDB, `datasette-embeddings` in a table.
- **Capture.** The PIM tools write Markdown, SQLite or their own service store;
  the web-archive tools write WACZ.

The gap is narrower than it first looked, now that Quickwit is mirrored. Quickwit
partitions an inverted index across **object storage** as immutable splits and
searches it with **stateless indexers and searchers**, scaling horizontally and
offloading leaf search to AWS Lambda when the local queue saturates. What it
does not offer is **scale-to-zero**: its metastore, control plane, searcher and
indexer are long-running services. `tantivy` is the library underneath and has
no residency property of its own, and `vgi-tantivy` rebuilds an ephemeral
in-RAM index per call, so it does not scale either. The remaining hole is a
genuinely scale-to-zero, personal-data cold search, which is what
[d177](d177-cold-full-text-search.md) designs.

A second gap is the **bridge**: the capture tools produce documents and the
warehouses consume tables, and only HPI and dogsheep's exporters cross the line.
`datasette-build` (a directory into SQLite) and `obsidian-clipper`'s
headless `clip()` are the two ends of that bridge that exist.

## Relation to this tree's records

- [d172](d172-push-based-browsing-index.md) — the push, Promnesia-shaped index.
- [d173](d173-browsing-history-storage-tiers.md) — hot and cold storage tiers.
- [d174](d174-obsidian-clipper-vs-hister.md) — clipper against hister.
- [d175](d175-hister-tiering.md) — hister's storage and what tiering would cost.
- [d176](d176-reimplement-contracts-not-tools.md) — imitate the contracts, not
  the tools.
- [d177](d177-cold-full-text-search.md) — cold full-text search at lakehouse
  scale.
- `datalakehouse/` — the module that already warehouses atuin through this
  repo's toolchain.

## Verification record

Mirrors read from the forge roots under `~/Downloads/references/` at these
tips, on 2026-11-12. Only the repositories named above were opened; a commit
hash pins what was read, and it does not imply the project still looks like
this.

`dogsheep/dogsheep-beta` `56fb14f` · `dogsheep/github-to-sqlite` `39b22de` ·
`dogsheep/pocket-to-sqlite` `b382b93` · `simonw/datasette` `4e70219b` ·
`simonw/sqlite-utils` `9c66baf` · `simonw/sqlite-history-json` `53e66b2` ·
`datasette/datasette-embeddings` `8dc282b` · `datasette/datasette-files` `011d210` ·
`datasette/datasette-litestream` `6d043dd` · `karlicoss/HPI` `639d960` ·
`karlicoss/promnesia` `6d26e6f` · `asciimoo/hister` `3414902b` ·
`asciimoo/omnom` `01c4551` · `obsidianmd/obsidian-clipper` `6d56d618` ·
`kepano/defuddle` `3e8bde9` · `logseq/logseq` `5d83ed47fd` ·
`webrecorder/browsertrix` `4351185fb` · `duckdb/ducklake` `f367a728` ·
`duckdb/duckdb-fts` `fe47e2b` · `duckdb/duckdb-vss` `bc1ec8b` ·
`asg017/sqlite-vec` `04d28bd` · `git.deuxfleurs.fr/Deuxfleurs/garage` `ed3befd8` · `Query-farm/vgi-tantivy` `97bdb78` ·
`teaguesterling/duckdb_zim` `38e01cb` ·
`motherduckdb/mcp-server-motherduck` `e027175` · `rclone/rclone` `e49f3350a` ·
`quickwit-oss/quickwit` `ea02864a8` · `quickwit-oss/tantivy` `2ad36b4fd` ·
`quickwit-oss/tantivy-py` `a7918da` · `seaweedfs/seaweedfs` `e0f8438284`.

## Mirror status

The farm spans several forges, not just `github.com` — `git.deuxfleurs.fr`,
`codeberg.org`, `git.sr.ht`, `gitlab.com` and the `gitlab.*`,
`salsa.debian.org`, `git.postgresql.org`, `cnb.cool` and
`tangled.org` instances, all under `~/Downloads/references/`. The survey
searched all of them (1306 repositories).

Present: everything named above, plus **Garage**
(`git.deuxfleurs.fr/Deuxfleurs/garage.git`), **SeaweedFS**, the search set
**Quickwit**, **Tantivy** and **tantivy-py** (`quickwit-oss/*`), and the
Zettelkasten packages `git.sr.ht/~ymherklotz/emacs-zettelkasten` and
`org-zettelkasten`. The `kiwix/` tree is not a repository: it is an openZIM
corpus (Wikipedia, Wiktionary, devdocs) that the ZIM readers above consume.

Near-misses and choices:

- **Elasticsearch/OpenSearch** are absent, and an acceptable-performance setup is
  heavy and expensive, so they are not a cheap cold-tier answer.
- **MinIO** is proprietary, so it is a licensing choice rather than a farm gap.
- **Ceph** is absent and sits in the high-maintenance, high-cost category, so it
  is not a candidate for a low-cost personal tier.
- The archival, read-later and activity cluster is absent as repositories because
  the triage above subsumes it.
