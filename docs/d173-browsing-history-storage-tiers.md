---
id: d173
type: architecture-design
status: draft
title: "d173 — browsing-history storage tiers: a minimal hot index and a cold MotherDuck/Parquet lakehouse"
parent: architecture
depends-on: [d172]
references: [d167, d046, datalakehouse, d177, personal-datalakehouse-prior-art, d178]
tags:
  [
    "datalakehouse",
    "motherduck",
    "parquet",
    "object-storage",
    "datensparsamkeit",
    "data-minimisation",
    "duckdb",
    "retention",
  ]
---

# d173 — browsing-history storage tiers

This record proposes splitting the [d172](d172-push-based-browsing-index.md)
index into a minimal hot zone that day-to-day queries read and a cold lakehouse
that holds everything else. It covers the storage split, the demotion policy and
what to measure; the ingest path and the served query shape stay in d172. The
reader is whoever measures which columns the Promnesia endpoints read, and
whoever operates the MotherDuck or object-storage path. The proposal keeps the
hot zone small, demotes the rest to compressed columnar files, and refuses to let
just-in-case data widen the hot set — data minimisation (`Datensparsamkeit`) as
the storage rule.

## Status

Draft — a study, not in force. The policy below is a set of proposals and open
questions, and d172 works without it.

## Problem

The index grows without bound, and most rows are written once and read never.
The hot zone pays for them at every compaction, every backup and every full scan.

The endpoints read few columns per answer, so a full-fidelity hot store is wider
than the queries require. A minimal projection of a visit answers the sidebar,
the mark-visited check and the around-a-timestamp search.

Minimisation is the sharper reason. A row that no day-to-day query needs can live
cold, where it is not resident, not backed up on the hot volume, and not reached
by a casual scan.

## Proposal

- **Hot zone.** Visits inside a configurable window, the one-row-per-URL
  presence index, bookmarks, and every `norm_url`'s best locator.
- **Cold zone.** Full visit rows and out-of-window history, exported as Parquet
  partitioned by month or synced to MotherDuck, compressed and queried rarely.
  The media are SMR disks over USB for the local archive, MotherDuck for a
  queryable cloud copy, and OCI object storage for the offsite archive. Only the
  SSD-resident staging and cache are assumed always online; the archive may be
  absent.
- **Demotion.** A scheduled job moves rows older than the window to the cold
  zone, then prunes them from the hot zone.
- **The presence index stays hot for every URL.** `/visited` answers "have I
  seen this link" for old links too, so the hot zone keeps at least one row per
  `norm_url` even when the full context rows are cold.
  [d178](d178-datalakehouse-workload.md) fixes that lookup as the system's one
  hot real-time read.

## Consequences

- The hot zone stays small, fast and cheap to back up.
- A cold read needs a second query path — DuckDB `read_parquet`, or a
  MotherDuck `ATTACH` — which the endpoints must compose. A query that misses
  the hot zone answers from the cold copy or not at all.
- Object-storage lifecycle, encryption and deletion become operational concerns,
  and the cold copy can become authoritative by accident if deletion does not
  mirror.
- The demotion window becomes a correctness knob, not a tuning knob: a window
  that is too small turns a visited link into an unvisited one for the stock
  extension.

The cold-search mechanism that serves the cold zone is
[d177](d177-cold-full-text-search.md), and the wider landscape is
[personal-datalakehouse-prior-art](personal-datalakehouse-prior-art.md).

## Relation to the datalakehouse module

The `datalakehouse/` module already warehouses atuin's `history.db` into
MotherDuck, and d167 records the harness-session sources that will follow it into
the same warehouse. Browsing history is a candidate second source: it shares the
compressed-columnar target, the duckdb pin and the vault delivery of the token
(d046), and it would extend that module rather than add a third storage path.

## Alternatives rejected

- **All-hot.** The simplest store, and the one that grows without bound; it
  defeats the minimisation goal and keeps every just-in-case row backed up.
- **All-cold, MotherDuck-only.** Every sidebar query pays a network round trip,
  the hot path depends on the network, and offline use stops.
- **SQLite-only.** It keeps the write path comfortable and leaves the read path
  a full scan, which is d172's problem statement.
- **Hister as the cold store.** It is content-centric with no visit timeline, so
  it cannot answer the visit queries the cold zone is asked.

## Study agenda

- Which columns do the five endpoints read, and which are required for the
  day-to-day answer? Measure against a real history before fixing the split.
- What is the smallest hot set that keeps `/visited` correct for old links? A
  wrong null marks a visited link unvisited, so the presence index must cover
  every URL even when the visit bodies are cold.
- MotherDuck or Parquet on object storage? MotherDuck needs the network, a token
  through `./environment.sh` (d046) and the pinned DuckDB extension version
  the `datalakehouse/` module already tracks; Parquet stays offline and reads
  through `read_parquet`, but the endpoint federates two sources.
- Where does canonicalization run? At ingest, so a cold row is already
  canonical, or at query, which costs a normalize pass on every cold read.
- What does minimisation forbid entirely? Page content is a separate decision
  from URL and title, and the hot zone must not become a shadow browser-history
  store.
- How does the cold copy track deletion? Mirror prunes into the warehouse, or the
  cold zone becomes an authoritative copy that nothing removes.
- Which partition and compression shape? Month partitions and zstd are the
  starting point; the sort order that gives zone maps on `norm_url` decides the
  rest.
