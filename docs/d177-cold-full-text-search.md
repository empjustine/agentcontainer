---
id: d177
type: architecture-design
status: draft
title: "d177 — cold full-text search: object-storage postings with scale-to-zero"
parent: architecture
depends-on: [d175]
references: [d173, d176, personal-datalakehouse-prior-art, d178]
tags:
  [
    "search",
    "full-text",
    "cold-storage",
    "object-storage",
    "parquet",
    "duckdb",
    "tantivy",
    "bm25",
    "scale-to-zero",
    "cost",
  ]
---

# d177 — cold full-text search

This record designs full-text search over cold object storage, cost-first and
able to scale to zero. It covers the index layout, the query path and the cost
levers, and it does not pick a product. The reader is whoever builds the cold
tier of [d175](d175-hister-tiering.md). What is proposed: an index that answers a
query with a bounded number of object reads, materialized either as
object-storage index splits or as a columnar postings table.

## Status

Draft — a design, not in force. No engine has been chosen, and nothing is built.

## The asymmetry

An inverted index is random access; cheap object storage punishes random access
and rewards few large sequential reads. The design target is therefore an index
that answers a query in O(query terms) plus O(top-k) object reads, with no
resident index and no corpus scan.

## Three families

- **Object-storage index splits.** A split is a self-contained inverted index
  with min-max metadata; a small manifest prunes splits, and a stateless searcher
  fetches the needed ones. Two flavors: **hister-native cold shards**, which
  reuse hister's multi-index search (`index_LANG.db`, `searchIndexes`), snapshot a
  closed shard to object storage and restore it on demand — coarse, whole-shard
  bandwidth — and a **split-based engine** built for lazy fetch (Quickwit and
  Tantivy-shaped, or Elasticsearch searchable snapshots). Quickwit is the
  reference for the second flavor: splits live in object storage and stateless
  indexers and searchers fetch them, scaling horizontally with an optional AWS
  Lambda offload. It is **not** scale-to-zero, because its metastore, control
  plane, indexer and searcher are long-running; Tantivy is its library and has
  no residency property of its own.
- **A columnar inverted index in Parquet.** The index as tables:
  `postings/prefix=XX/*.parquet` holds `(term, doc_id, tf, positions)` sorted by
  term and partitioned by term-prefix bucket, zstd-compressed with delta-encoded
  ids; `docs/**/*.parquet` holds
  `(doc_id, url, title, ts, lang, domain, snippet, content_ref)` partitioned by time;
  a tiny hot `termstats` table holds global `df` and `avgdl`. A query reads only
  the prefix buckets its terms fall into, merges them with WAND or skip lists,
  scores BM25 against the hot stats, then fetches the top-k rows. Full content
  stays content-addressed and is read when a result is opened, not during search.
  On a high-latency store the term-prefix buckets are few and large, and the
  postings are located by offset inside them; the [Cold media](#cold-media)
  section constrains how many objects a query may open.
- **The hybrid.** A hot window in Bleve or DuckDB FTS, cold data in one of the
  above, and a router that merges. Cold answers are explicit or asynchronous.

For this tree's priorities, the Parquet family is the native fit because it
extends the DuckDB and DuckLake path of [d173](d173-browsing-history-storage-tiers.md)
and [d176](d176-reimplement-contracts-not-tools.md) and needs no second engine.

## Cold media

The cold tier's physics constrain the layout more than the codec does.

- **Local archive: SMR disks over USB.** Seek and random-write latency is
  seconds; sequential read bandwidth is reasonable. The store is append-only,
  written in large sequential files and read back in long ranges, so object
  _count_ and _open_ latency dominate the cost model rather than bytes. A local
  SSD or NVMe cache holds the manifest and the active files; the SMR store is
  the durable archive behind it.
- **MotherDuck.** A queryable cloud copy, so a cold search can run there with
  scale-to-zero compute and no local disk.
- **OCI object storage.** S3-compatible buckets for the offsite archive, read
  through `httpfs`.

Four consequences for the index:

- Prefer **few large split files with an offset-indexed term dictionary** — the
  Tantivy and Lucene shape — over one object per term prefix. A query then does
  a handful of sequential range reads instead of hundreds of object opens.
- Keep the **manifest and the term statistics on SSD**; never probe the SMR
  store to answer a routing question.
- Write in **generations**. A compaction writes a new set of large files
  sequentially and records it in the manifest; deletes are tombstones resolved
  by the next generation. In-place rewrite is the one thing SMR punishes most.
- The first query over a generation pays the SMR seek and the copy into the
  cache; later queries are served from the cache.

## Cost and availability

The media differ in cost shape and in whether they are present at all, and both
facts reach the design.

**Local archive, SMR over USB.** Capacity is the cheapest and there is no
per-operation charge: the cost is the disk, the electricity and the controller.
The restraints are latency, write amplification and availability. Random writes
wear and stall the shingled bands, so the archive is written once, sequentially,
in large generations. The volume is a single spindle over USB: it can be
unplugged, spun down, re-enumerated or fail, and it may be absent for a session.
It is the durability and offline copy, not the query surface.

**MotherDuck.** A managed, queryable cloud copy with no local disk and
effective scale-to-zero compute, paid per query and per stored byte, reachable
only with the network and a credential from the vault chain (`./environment.sh`,
d046). It is the natural cold query surface for infrequent searches.

**OCI object storage.** S3-compatible buckets, paid per stored byte and per
request with egress charges, read through `httpfs`. It is the offsite copy that
makes the local spindle expendable.

Downstream effects:

- **Placement.** The staging of [d172](d172-push-based-browsing-index.md), the
  presence table and its index ([d178](d178-datalakehouse-workload.md)), the cold
  manifest, the term statistics and the query cache all live on SSD or NVMe. SMR
  holds immutable generations only, and nothing on a hot path waits on it.
- **One write path.** A compaction stages on SSD and streams each generation
  once, to the SMR archive or the cloud or both. No copy is produced by reading
  the SMR store, and none by reading the cloud.
- **Cloud is the default cold query surface.** A cold query runs against
  MotherDuck or OCI, which costs per query but pays no seek and needs no resident
  cache; the SMR route serves offline use and background rebuilds, where a
  sequential read is amortised over a whole generation.
- **Degraded mode.** The archive can be offline and the network can be down.
  The visited check still answers from the SSD-resident presence index, and
  cached cold data still serves; a cold query that needs the archive is deferred
  rather than failed.
- **Cache policy.** The SSD cache holds the manifest, the term statistics, the
  active generations and the recently queried ones, evicted by recency. A
  full-history batch search prefetches whole generations, because a per-term
  fetch would pay the SMR seek once per term.
- **Durability.** The SMR spindle is a single point of failure and bit rot is
  real, so the OCI copy is the offsite backup and the archive is scrubbed
  against it rather than against itself.

## Scale-to-zero mechanics

Scale-to-zero is the cold side's property. The visited check of
[d178](d178-datalakehouse-workload.md) is the hot read and the always-on
exception, served by a small resident component.

- **Storage:** object storage, which costs near nothing when idle.
- **Compute:** a stateless query worker started on demand — a serverless
  function, knative, a KEDA-scaled deployment on a queue, or `systemd` socket
  activation on a single host.
- **Manifests and `termstats`:** tiny, cached, or in a small always-on store.
- **Expensive queries:** an asynchronous queue with spot or preemptible workers,
  writing results back.

## Cost levers

1. Compress and dedup: zstd Parquet, delta and varint postings, content-addressed
   blobs shared by hash.
2. Prune before the postings: time, domain and language partitions, then
   term-prefix buckets. The object count per query is the bill.
3. Keep `termstats` hot so ranking costs no cold traffic.
4. Return snippets from the docs table, never the full HTML during search.
5. Treat cold search as a background or explicit operation.

## Limits

- **Latency** is seconds to minutes, so cold search is not for interactive
  typing.
- **Deletes and updates** in immutable Parquet need tombstones and periodic
  compaction, which is the deletion question [d173](d173-browsing-history-storage-tiers.md)
  leaves open.
- **Ranking** is approximate when partitions are pruned, and global `df` must be
  maintained.
- **Rebuild** — tokenizing and writing postings — is a batch job, not free.

## Prior art

- `Query-farm/vgi-tantivy` — BM25, stemming and tokenization in DuckDB via
  Tantivy, with an ephemeral in-RAM index per call.
- `duckdb/duckdb-fts` and `dogsheep/dogsheep-beta` — resident full-text search
  in DuckDB and SQLite FTS5.
- `duckdb/ducklake` and `duckdb/duckdb-httpfs` — the Parquet lakehouse and
  object-storage reads.
- `duckdb/duckdb-vss` and `asg017/sqlite-vec` — the vector analogue of the
  same cold-residency question.

The survey is [personal-datalakehouse-prior-art](personal-datalakehouse-prior-art.md).

## Where this lands

This is the search half of the architecture change d175 names; the store half is
d173 and d176.
