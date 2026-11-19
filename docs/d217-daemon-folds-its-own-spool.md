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
`$AGENT_WAREHOUSE_SPOOL_MAX_BYTES` (default 32 MiB) and the process holds a
MotherDuck token.

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
  append and once at startup (a tail left by an earlier run is folded before it
  grows further). `AGENT_WAREHOUSE_SPOOL_MAX_BYTES` sets the ceiling; `0`
  disables the self-send explicitly.
- **Credential: `motherduck_token` (then `MOTHERDUCK_TOKEN`), read from the
  environment only.** Absent, the daemon stays what it was — a spool writer —
  and says so once at startup. The credential never becomes a file.
- **One sender at a time.** `<spool>.lock` is created with `wx` (exclusive
  create) around the child; a second trigger returns immediately. A stale lock
  from a killed daemon is removed by hand, which is louder than guessing at
  liveness.
- **Accounting survives rotation.** The sender freezes the tail by renaming it,
  and the daemon appends by path, so the next append recreates the spool. Bytes
  appended while the child runs are therefore still pending and are counted
  after the fold — not reset to zero.
- **Failure is not fatal and not a fork bomb.** On a non-zero exit the sender
  keeps the spool; the daemon backs off for `AGENT_WAREHOUSE_SPOOL_SEND_RETRY`
  (default 60 s) before trying again. Ingest keeps accepting rows throughout.
- **`AGENT_WAREHOUSE_SENDER`** overrides the script path; it exists so the
  test can stub the sender.

## Consequences

- **The spool is bounded by the threshold plus one in-flight fold**, not by
  whether anyone ran the sender. A long idle daemon folds at startup and then
  only on traffic.
- **The daemon needs bash and the sender beside it at its own folder path** (the
  copy unit, d113). When it fires it also needs the pinned duckdb and jq — a
  host without them logs a failed fold and retries, and ingestion is unaffected.
- **An operator-run sender can race the daemon's** (the lock is the daemon's
  own). Both rotate by rename and insert idempotently, so the cost of an
  overlap is wasted work and a possibly empty fold, never a duplicate row.
- **MotherDuck sees trickle writes instead of one batch.** The insert is
  `ON CONFLICT DO NOTHING`, so unchanged rows never re-version (d203); a fold
  that finds only seen rows writes nothing.
- **d180/d181's split is unchanged**: the host-side receiver is the archive's
  only writer, and the sandbox still only POSTs.

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
