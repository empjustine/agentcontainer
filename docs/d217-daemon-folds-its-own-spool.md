---
id: d217
type: module-design
status: active
title: "d217 — the ingest daemon folds its own spool: the sender runs at a byte threshold when the token is present"
parent: datalakehouse
depends-on: [d181]
references: [d180, d181, d184, d203, d216]
tags: [datalakehouse, sessions, ingest, spool, motherduck, duckdb]
---

# d217 — the daemon folds its own spool

**Status: landed.** `agent-warehouse-daemon.mjs` runs
`agent-warehouse-spool-send.sh` itself once the spool tail crosses
`$AGENT_WAREHOUSE_SPOOL_MAX_BYTES` (default 32 MiB), and for whatever tail an
earlier run left when the process starts, whenever the process holds a MotherDuck
token.

## Problem

The daemon appended every accepted row to the spool and stopped there. What
moved the spool into MotherDuck was an operator running the sender — so the
spool's size ceiling was human attention. A daemon started through
`./environment.sh` already holds the one credential that leg needs, and a host
that never remembers the sender accumulates a tail that only grows; nothing in
the design says why the process that owns the tail cannot fold it.

## Decision

- **The daemon runs the SAME sender, not a second uploader.** It spawns
  `bash agent-warehouse-spool-send.sh --spool <spool>` with its own
  environment. That script owns the streaming, the rotation, the batching and
  the first-write-wins insert (d203); implementing any of it in node would be a
  second upload contract that can drift from the operator's (d176's rule).
- **Trigger: bytes pending since the last successful fold**, checked after an
  append that crosses `AGENT_WAREHOUSE_SPOOL_MAX_BYTES`, once at startup (which
  folds whatever tail an earlier run left, over the ceiling or not, because a
  restart is the one moment nobody is appending), and when the failure backoff
  expires. `0` sets the self-send off explicitly.
- **The pending count is measured, not tracked.** It starts as the sum of the
  live spool and every `spool.rm.*` the sender still globs, advances by the
  bytes of each fresh append (no stat per POST), and is re-measured at the start
  and the end of every fold. A running subtraction drifts in both directions: an
  operator's `--direct` sync rotates bytes this process never counted, and rows
  that land before the sender's rename are frozen into the file the fold
  consumes. The drift costs a no-op fold either way (d203), but only a
  measurement lets the startup fold see a leftover tail at all.
- **Credential: `motherduck_token` (then `MOTHERDUCK_TOKEN`), read from the
  environment only.** Absent, the daemon stays what it was — a spool writer —
  and says so once at startup. The credential never becomes a file.
- **One sender at a time, across every caller.** The sender itself takes
  `<spool>.lock` (`flock`, or a pid-checked directory fallback), so the daemon's
  self-send, an operator's run and the sync's `--direct` leg cannot overlap. A
  second sender exits `75` (temporary failure); the daemon treats that as busy,
  keeps the spool and retries. `flock` releases on process death; the fallback
  checks the recorded pid and reclaims a dead owner. The in-process `sending`
  flag remains only to stop the daemon from spawning its own second child.
- **Accounting survives rotation.** The sender freezes the tail by renaming it,
  and the daemon appends by path, so the next append recreates the spool. Rows
  appended while the child runs are in that new file and the post-fold
  measurement counts them. A fold that removed no bytes is not re-triggered: the
  guard keeps a sender that exits 0 without consuming the tail from calling
  itself forever.
- **Failure is not fatal and not a fork bomb.** On a non-zero exit the sender
  keeps the spool; the daemon backs off for `AGENT_WAREHOUSE_SPOOL_SEND_RETRY`
  (default 60 s) and retries from an unref'd timer, so an idle daemon folds the
  kept tail instead of waiting for the next POST, and the timer cannot hold the
  process open. Ingest keeps accepting rows throughout.
- **A non-numeric numeric variable is reported and replaced by its default.**
  `Number("32MB")` is `NaN`, and every ceiling and delay test compares false
  against `NaN`: an unparseable ceiling folds on every accepted row and an
  unparseable delay never waits. One `envNumber` helper owns the check and the
  warning, because `NaN` reaching the guards is the failure mode.
- **`AGENT_WAREHOUSE_SENDER`** overrides the script path; it exists so the
  test can stub the sender.

## Consequences

- **The spool is bounded by the ceiling plus one request body plus the appends
  that land during a fold**, not by whether anyone ran the sender. The threshold
  is checked after an append, so a single POST overshoots it by up to
  `AGENT_INGEST_MAX_BODY` (8 MiB default), and the fold is no lock on ingest.
  A long idle daemon folds at startup and on the retry timer, not only on
  traffic.
- **The daemon needs bash and the sender beside it at its own folder path** (the
  copy unit, d113). When it fires it also needs the pinned duckdb and jq — a
  host without them logs a failed fold and retries, and ingestion is unaffected.
- **An operator-run sender used to race the daemon's** (the old lock was the
  daemon's own). The sender now owns the shared lock, so the overlap is a
  non-zero exit (75) rather than two rotations. Both paths still insert
  idempotently if a lock is bypassed.
- **MotherDuck sees trickle writes instead of one batch.** The insert is
  `ON CONFLICT DO NOTHING`, so unchanged rows never re-version (d203); a fold
  that finds only seen rows writes nothing.
- **d180/d181's split is unchanged**: the host-side receiver is the archive's
  only writer, and the sandbox still only POSTs.

## Corrections from review

A review of this design against the code found four points it left open; each
rule below is enforced in `agent-warehouse-daemon.mjs` and covered by
`tests/spool-self-send.sh`.

- **A non-numeric ceiling or delay bypasses its own guards.** `NaN <= 0` and
  `bytes < NaN` are both false, so a typo inverted the two behaviours the
  design depends on. Every numeric variable (the two self-send ones and
  `AGENT_INGEST_MAX_BODY`) passes through one `envNumber`.
- **A backoff with no timer waits for traffic.** The retry belongs to the tail,
  not to the next request, so a failed fold ends in an unref'd `setTimeout`.
- **The count must cover the files the sender globs.** Reading only the live
  path skips a `spool.rm.<pid>` a killed fold left, so the leftover never
  triggers a fold, and subtracting a running total overcounts once an
  operator's rotation removes bytes this process never counted. Measuring
  `spool` plus `spool.rm.*` at startup and around each fold keeps the count
  on the set the sender consumes.
- **A zero-progress success must not re-trigger, and a held lock must speak.**
  The success path re-triggers only when the fold removed bytes, warning when it
  did not; a busy sender logs the lock path and backs off.

## Alternatives rejected

- **Upload from node with the duckdb client.** Reimplements the sender's
  streaming/rotation contract in a second language for no new capability.
- **A cron or systemd timer running the sender.** Still external, still a
  schedule to maintain, and it cannot see how full the tail is.
- **Fold only on SIGTERM.** A long-running daemon never reaches the signal, and
  the spool is exactly what must not wait for run end.
- **Truncate the spool after a successful upload instead of rotating.** Loses a
  concurrent append (the reason the sender renames).

## References

- `datalakehouse/agent-warehouse-daemon.mjs` — the self-send and its state.
- `datalakehouse/agent-warehouse-spool-send.sh` — the sender it runs.
- docs/d181 — the route contract this does not change.
- docs/d203 — first-write-wins, which makes frequent folds cheap.
- docs/d184 — the sweep that still reads the spool as a third source.
