---
id: d178
type: architecture-design
status: active
title: "d178 — the datalakehouse workload: trickle-bursty writes and one hot read"
parent: architecture
references: [d172, d173, d175, d176, d177, datalakehouse, d179]
tags:
  [
    "workload",
    "datalakehouse",
    "atuin",
    "hister",
    "promnesia",
    "write-path",
    "visited",
    "latency",
    "scale-to-zero",
  ]
---

# d178 — the datalakehouse workload

This record fixes the workload the datalakehouse is sized for: trickle-bursty
multi-producer writes, mostly cold reads, and exactly one hot real-time query. It
covers the write shape, the read shape and the compute split that follows, and it
does not choose storage. The reader is whoever sizes the hot path and decides
what stays resident. What it decides: the write path absorbs bursts, the hot path
is the visited check alone, and everything else may be cold or asynchronous.

## Status

Characterisation in force for the design records that follow; nothing is built.

## Writers

Four producer families, all bursty:

- **atuin**, from shell hooks and the agent: one small entry per command, in
  bursts during a working session.
- **The hister and promnesia extensions**: one push per page or visit, in bursts
  during a browsing session.
- **The user's batch imports**: occasional and heavy — old history, bookmarks,
  vaults, archives.
- **Coding-agent sessions** ([d179](d179-coding-agent-session-leg.md)): per-run
  harness state pulled from the host, with no hot read.

The shape that follows is many small idempotent transactions plus rare large
ones. The SQLite WAL staging of [d172](d172-push-based-browsing-index.md) absorbs
the small ones; a batch import runs as a separate lane so it cannot starve the
hot read below.

## The one hot read

The **visited check** — "have I seen this URL before" — is the single real-time
query. It is what `/visited` serves and what the extension places on every link
of a page. Its properties decide the hot path:

- **Latent.** It sits on the page-load path, so it has the one latency budget in
  the system.
- **Batched.** A page sends every one of its links in one request.
- **Mostly negative.** Most links are unvisited, so the common answer is a fast
  no.
- **Complete.** It answers for every URL ever seen, including URLs whose full
  visit rows are cold.

That makes the **presence index** the one first-class, complete, compact,
resident structure. It is the same structure
[d173](d173-browsing-history-storage-tiers.md) keeps hot for every `norm_url`, and
it is why the hot zone is dominated by presence rather than by recent content.

## The cold reads

The context sidebar, per-visit search, search-around, analytics and full-text
search all run on demand. They may take minutes on the first touch of a cold SMR
generation and seconds once cached, so they are asynchronous. A cold query that
needs the archive is deferred while the archive or the network is unavailable.
None of them blocks the visited check.

## The compute split

The workload implies two components, not one:

- A **small always-on hot component** that answers the presence lookup.
- A **scale-to-zero cold component** for search, context and analytics.

The scale-to-zero property of [d177](d177-cold-full-text-search.md) applies to the
cold side only. The presence check is the always-on exception, so the idle cost
is the compact presence index, not a resident search engine.

## Sizing

The presence table's encoding is delegated to the store, not hand-rolled. DuckDB
compresses each column segment with the cheapest of its codecs — constant, RLE,
dictionary, PFOR-delta, bit-packing, FSST, ZSTD, Roaring, and a dedicated
dictionary-plus-FSST type for strings — and keeps URL-oriented benchmarks
(`dict_fsst/indexed_url_fetch`), so an exact `norm_url` column stays compact
without a bespoke codec.

The hot lookup is a DuckDB point query. An ART index
(`CREATE INDEX ... USING ART`) is checkpoint-persisted, so `norm_url` stays
exact and a positive answer needs no confirmation against the cold store. Two
levers remain when memory becomes the constraint, and both are DuckDB-level
rather than codec-level:

- Index a compact surrogate — a rowid or a 64/128-bit hash column — instead of
  the varchar, and keep the compressed `norm_url` as a payload. The hash is
  then an index key, not a storage format.
- Keep a small Bloom filter over the surrogate as the mostly-negative fast path.
  It is optional, because a miss in an ART is already cheap.

The presence table is rebuildable from staging and the cold store, so the hot
component can reload it rather than treat it as the source of truth.

## Consequences

- The visited check sets the system's only latency budget, and every other path
  is free to be slow.
- Compaction updates the presence index atomically and never blocks a lookup.
- A batch import is scheduled against the cold lane, and the hot lane keeps
  serving.
- The hot component's availability is what browsing depends on; the cold
  component may be down or asleep without a visible effect beyond a slower
  sidebar or search.
