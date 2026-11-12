---
id: d172
type: architecture-design
status: active
title: "d172 — a push-based browsing index: a custom Firefox extension and a SQLite→DuckDB listener replace the tailscale+promnesia stack"
parent: architecture
depends-on: [d113]
references: [d167, datalakehouse, d173, d176, personal-datalakehouse-prior-art, d178]
tags:
  [
    "promnesia",
    "hister",
    "firefox-extension",
    "browsing-history",
    "duckdb",
    "sqlite",
    "push",
    "personal-search",
  ]
---

# d172 — a push-based browsing index

This record replaces the `tailscale-funnel-promnesia/` stack with a
push-based browsing index: a custom Firefox extension drains history and
bookmarks into a listener, and the listener answers the stock Promnesia
extension from a DuckDB columnar backend. It covers the ingest path and the
served query shape only; the long-term storage split is
[d173](d173-browsing-history-storage-tiers.md). The reader is the implementer of
the listener and the extension, and the auditor who must be able to state why
neither Promnesia nor Hister alone fits. It decides that the browser pushes, a
SQLite staging zone absorbs the writes, a DuckDB gold zone serves the reads, and
the listener speaks Promnesia's wire protocol.

## Status

Decision in force; implementation pending. `tailscale-funnel-promnesia/`
remains the on-disk stack, and no unit, Containerfile or extension implements
the design below.

## Problem

Two existing tools each cover half of the job. Promnesia records per-visit
history with context, Hister indexes page content, and neither does both; running
both means two extensions and two servers.

Promnesia's own server is the wrong shape for the query load its extension
generates. The indexer is pull-based and reads the browser profile across the
container boundary, and the server is a read-only SQLite layer whose `/search`,
`/search_around` and `/visited` handlers scan the table; the `visited`
handler even carries a TODO for an intermediate `norm_url` table.

Reading the profile is the friction the tailscale stack introduced. Firefox is a
Flatpak on this host, so the profile sits under `~/.var/app/…`, a bind mount
needs an SELinux relabel that collides with the Flatpak and with `restorecon`,
and the live `places.sqlite` is open with WAL sidecars.

Hister cannot stand in for the visit timeline. It keeps one document per
normalized URL with `add_count` and `updated`, and its history view is a
facet over those document timestamps rather than a list of visits.

## Decision

- **The browser is the producer.** The extension captures each visit through
  `history.onVisited`, backfills through periodic `history.search` and
  `getVisits` sweeps, and pushes bookmark trees as context. It reads no
  profile file, so it works unchanged with Flatpak Firefox.
- **Writes land in a SQLite staging zone.** The listener opens
  `staging.sqlite` in WAL mode, inserts each batch under `INSERT OR IGNORE`
  keyed on `(src, kind, key)`, and returns accepted and duplicate counts. The
  hot path stays milliseconds under read load.
- **A compaction bridge builds the gold zone.** A background step reads new
  staging rows through DuckDB's SQLite extension, canonicalizes each URL, and
  appends to a DuckDB `visits` table whose columns match Promnesia's. A periodic
  major compaction rewrites the table ordered by `norm_url`.
- **The listener serves Promnesia's wire protocol from DuckDB.** `/visits`,
  `/search`, `/search_around`, `/visited` and `/status` reproduce the
  request shapes, the response fields, the `'%d %b %Y %H:%M:%S %z'` timestamp and
  the `as_json` body of the Promnesia server, so the stock extension and web UI
  need no change.
- **URL canonicalization is vendored, not re-implemented.** The listener imports
  Promnesia's `cannon.cannonify` (MIT), because `/visited` answers only when
  both sides normalize a URL identically.
- **One container and one volume carry the design.** The listener holds
  `staging.sqlite` and `lake.duckdb` in a single `/data` volume and publishes
  on loopback. The tailscale funnel path is retired.

- **Promnesia is a contract, not a dependency.** The listener reimplements the
  visit model and imports only `cannon.cannonify`; the end-game is
  [d176](d176-reimplement-contracts-not-tools.md).

## Consequences

- A new unit lands under the copy-unit rule (d113), with a pruned `cannon.py`
  copy and a DuckDB dependency.
- No profile mount, no SELinux relabel and no tailscale funnel remain in the
  path, so the Flatpak Firefox boundary stops mattering.
- DuckDB is single-writer. Every write goes through the staging zone, and the
  MVP serving path and the compaction step share one connection under a lock.
- Promnesia's other sources (org, markdown, HTML) are out of scope. A pull job
  can still feed the same volume when their context is wanted.
- The stock extension's page-side work is unchanged. This record fixes the
  server-side query cost, not the extension's DOM marking.

## Alternatives rejected

- **Promnesia alone.** It keeps the pull indexer, the profile read and the
  scanning SQLite server — the three costs this record removes.
- **Hister alone.** It answers "what did the page say" and has no visit
  timeline, so it cannot serve the sidebar or mark-visited queries.
- **Promnesia plus Hister as two extensions.** The split works and needs no
  custom code, but it keeps two extensions, two servers and two stores for one
  question. It stays the fallback when a custom unit is unwanted.
- **The `tailscale-funnel-promnesia/` stack.** It couples a browser-history
  task to a network tunnel and a second host.
- **The Promnesia indexer inside the listener container, reading the profile.**
  It reopens the Flatpak/SELinux boundary and the WAL locking race that the push
  path removes.
- **Writes straight to DuckDB.** DuckDB is single-writer and built for bulk
  loads, so per-visit browser writes would contend with reads and block them.

## Where this leads

The long-term storage split — a minimal hot index against a cold lakehouse — is
[d173](d173-browsing-history-storage-tiers.md).
