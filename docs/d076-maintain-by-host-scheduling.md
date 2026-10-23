---
id: d076
type: decision
status: implemented
title: "d076 — maintain schedules by host and paces per host"
parent: architecture
depends-on: [d044, d060]
references: [d044, d060]
tags: ["git", "references", "mirrors", "scheduling", "pacing", "rate-limits"]
---

# d076 — maintain schedules by host and paces per host

**Status: implemented.**

## Problem

`maintain-mirrors.mjs`'s defaults were aggressive in two ways that only bit a
real farm:

1. **Jobs were a flat count over all mirrors.** The default `--jobs 2` pool
   could put both workers on two mirrors of the SAME host — two concurrent
   requests to one forge. That is exactly the shape the software-forge tenant
   rate-limits (d044), and nothing in the scheduler knew what a host was.
2. **Pacing was all-or-nothing, and public forges got nothing.** An unset
   `--min-interval` meant 60 s for a software-forge mirror and **0 s** for a
   public one — a `github.com` sweep fired back-to-back fetches at one host,
   with only the flat job count as brake.

## Decision

**Schedule by host; pace per host.**

- Mirrors are grouped by the host of their `remote.origin.url` before any
  job starts (an upstream-URL probe phase — the work farm's path layout
  carries no host segment, so the URL is the only honest source of "host"). A
  group is never split across workers: one worker owns one host at a time, so
  *a host never has two jobs in flight*, for any `--jobs N`. Mirrors with no
  upstream (or a URL carrying no host) share one `(local)` bucket rather
  than each becoming its own unbounded parallel lane.
- `--jobs N` now caps how many HOSTS work at once; the default is every
  discovered host. Different hosts still run in parallel — that is the
  parallelism a farm actually has, because hosts are the rate-limit unit.
- Min-interval gates are keyed per host: an explicit `--min-interval S`
  (and `0`) still applies to every fetch, unset gives every host **1 s** of
  idle between its fetches, and a software-forge host gets **30 s** — halved
  from the original 60 s now that the scheduler itself rules out same-host
  overlap, so the gap only has to bound the request *rate* (that tenant
  rate-limits even a fully serial sweep — d044). A single global gate would
  now serialize different hosts against each other, which pacing never needed
  to do.

## Consequences

- Two same-host requests can no longer overlap, structurally: neither the
  scheduler (groups are atomic) nor the gate (per-host serialization)
  permits it. d044's "serialize the software-forge sweep" contract holds for
  every `--jobs`, including the new host-parallel default.
- The public-farm sweep gets slightly gentler (1 s per host between fetches)
  and considerably more host-parallel (one worker per host instead of a flat
  2). Same-host repack contention is gone too — optimize lives in the same
  per-host queue as the fetch it follows.
- The origin URL is read once, in a bounded probe phase (`ORIGIN_PROBE_JOBS`)
  before scheduling, instead of inside each job: same total reads, earlier.
- Historical records that described the old defaults keep the values of the
  day (d060's retirement table still says 60 s forge / 0 s public); the live
  descriptions are the `@fileoverview` in maintain-mirrors.mjs,
  `git/non-bare-issues.md`, and this record.

## Verification

`tests/git-byhost-scheduling.test.mjs` builds a throwaway farm (two fake
hosts plus one upstream-less mirror), puts a fake `ssh` on `PATH` that
timestamps its own invocations, and asserts from those timestamps: no
same-host overlap ever, at least the interval between one host's consecutive
fetches, cross-host overlap present (the parallelism survives), and that
`--jobs 1` / `--min-interval 0` still mean what they say.
