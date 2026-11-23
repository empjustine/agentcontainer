---
id: datalakehouse-elt
type: submodule-design
status: draft
title: "datalakehouse-elt — every source lands as an immutable batch in a stage zone"
parent: datalakehouse
references: [d173, d177, d204, d205]
tags: ["elt", "stage-zone", "parquet", "duckdb", "sqlite"]
---

# datalakehouse-elt

The landing zone the unit's sources write to, the ledger that stages them, and
the cold columnar store they are transformed into. Bookmark, visit, clipping and
article-metadata dumps all take this one path; each source keeps its own folder,
key and schema version, and no source gets its own storage mechanism.

## Status

Draft. The contract, the three scripts and the measured run on the arxiv
metadata set are landed; no producer is wired to it, and the browsing streams
still reach the daemon's own spool (d204, d205). The zone is therefore the
target shape for the sources, not yet the path they take.

## Why a zone and not a table

Ingest is the requirement that decides this design: a producer landing a dump
must do no reads, no rewrites, no index maintenance and no compaction, because
the expensive part of a personal warehouse is not the query, it is a task that
has to be correct while it holds a write lock. So a dump arrives as one
immutable batch, and every transform reads the zone and writes somewhere else.
The zone is then the only authoritative copy, staging and cold are derived state
that can be deleted and rebuilt, and a transform bug costs a re-run rather than
data.

## Layout

    zone/<source>/<kind>/dump=<full|delta>/dt=<YYYY-MM-DD>/<batch_id>/
        data.ndjson.zst     one row per record: {kind, key, row_hash, payload}
        manifest.json       counts, hashes, lineage, schema version

    staging/staging.db      sqlite: batch ledger + raw staged rows, append-only
    cold/<kind>/*.parquet   zstd parquet: deduped, promoted, rebuildable

## Write path

- One batch is one file plus one manifest, published by an atomic directory
  rename: nothing is ever written into a published batch.
- The batch id is the SHA-256 of the uncompressed payload, so the directory name
  is the identity and a re-sent batch answers "batch_present" without a ledger
  lookup. A producer retry is idempotent by construction, not by bookkeeping.
- The manifest travels inside the renamed directory, so a visible batch is
  always complete and its row count and payload hash are checkable before a
  transform trusts it. A truncated batch fails the check instead of becoming
  rows.
- The payload is NDJSON compressed with zstd, not parquet: a landing zone that
  enforces a schema turns every producer drift into a rewrite of history, and
  the schema belongs to the transform that reads it.
- A batch holds thousands of rows. A producer that flushes per row creates
  objects no filesystem or object store wants, so the flush threshold is a size
  or a time, and the threshold belongs to the producer's own batching contract.

## Full and delta

A full dump is a batch with "dump=full"; a delta is a batch with "dump=delta"
whose manifest names the full batch it continues. A full dump never replaces the
log that precedes it: it is another batch, and expiry by whole batch after the
transform watermark is the only removal. A restore is a transform over a batch
subset, not a special ingest path.

## Dedupe rules

Dedupe is the transform's job, in this order:

- natural key per kind, newest ledger sequence wins, so a delta overrides the
  full it extends. Ordering is the ledger's own sequence and never wall-clock:
  two batches landed in the same second must resolve identically on every run;
- "row_hash" makes an unchanged row skippable without comparing payloads;
- a content blob (a captured page's text) is keyed by the hash of that text, so
  the same page captured twice costs one blob and two references.

Derived judgements never enter the zone. "This bookmark resolves to ZIM book B
at entry path P" is a transform output recomputed when the corpus file's mtime
changes; storing it in the zone would make a corpus refresh a rewrite.

## Measured

The one landed dataset is 269 Hugging Face paper records, which is the article
metadata a bookmark corpus accumulates:

| step                                                     | bytes                  |
| -------------------------------------------------------- | ---------------------- |
| source JSON files                                        | 1 601 231              |
| zone batch, 269 rows                                     | 260 631 (6.1x smaller) |
| cold entries.parquet, zstd                               | 327 806                |
| cold links.parquet, 1 327 model/dataset/space/repo edges | 23 328                 |
| staging sqlite, raw payload text kept                    | 1.4 MB                 |

Staging is larger than the zone because it keeps the raw payload text for
replay. That is the price of a re-runnable transform, and it is why staging is
derived rather than primary.

## Verification

Run on this tree: the same 269 files landed twice answered "batch_present" with
no new directory; a delta batch carrying two revised rows overrode exactly those
two in the transform (269 deduped papers, unchanged link count) and the tier
split then read 2 hot, 267 cold; deleting staging and cold and re-running the
transform rebuilt both to the same counts from the zone alone. Every zone row
hash was compared against its source file before the source directory was
pruned.

Not measured: the batch floor for the browsing streams (a five-second producer
budget flushes small batches, and zstd on a 5 KiB batch is roughly 2x, not 6x),
and the flush owner — the extension's queue or the daemon's spool — which is a
producer decision under d204 and d205.

## Scripts

    uv run land.py <files-or-dirs> --source hf-papers --kind arxiv.paper --dump full
    uv run transform.py          # zone -> staging/staging.db -> cold/*.parquet
    uv run query.py attention    # one duckdb query over hot sqlite + cold parquet

## Not this unit

Article availability and the clipping upgrade are not zone concerns. Resolving a
bookmark to an offline corpus is a probe against that corpus (a ZIM carries its
own path directory and its own full-text index, so there is nothing to build
here), and replacing a metadata-only clipping with real article text is a
producer-side fetch. Both land their results as ordinary rows through this zone.
