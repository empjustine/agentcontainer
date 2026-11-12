---
id: d180
type: module-design
status: draft
title: "d180 — the session collection leg: a read-only archive, a host-side writer, and the diode property d026 cannot yet supply"
parent: datalakehouse
depends-on: [d179]
references: [d026, d167, coding-harness-persistence, d181]
tags:
  [
    "datalakehouse",
    "coding-agent",
    "sessions",
    "diode",
    "collection",
    "read-only",
    "mount",
    "audit",
  ]
---

# d180 — the session collection leg

This record defines the transport from the harness stage directories into the
warehouse, and the diode property that can be had without the d026 FUSE store.
It covers the store split, the writer, the reader and the residual window, and it
is not the d026 implementation. The reader is whoever writes the collector or the
session reader. What it decides: an append-only archive written only host-side
and mounted read-only where the reader runs, so no sandbox can delete or modify
captured logs.

## Status

Draft; nothing implemented. d026 remains design-only, and its FUSE versioned
store is the eventual closure this record works around.

## The constraint

- d026 is unimplemented, so the reader cannot bind to a versioned FUSE store.
- Containers run with `--userns=keep-id`, the host user's uid, so a second
  host uid holding the archive buys little isolation and costs user management.
- SELinux cannot express append-only, and the archive must be writable by the
  collector, which is host-side.
- The diode property must therefore come from **which paths are writable in the
  sandbox**, not from a filesystem or an attribute.

## Two stores, one writer

- **The live stage** is the per-run host directory `run.mjs` creates and
  read-write mounts (`$HOME/workspace/agentcontainer-<timestamp>/…`). The harness must
  write somewhere, so this path stays tamperable, and it is disposable.
- **The archive** is a host-only, append-only store: one immutable version per
  capture, keyed by source and time, never rewritten.
- **The collector is the archive's only writer.** It runs on the host, outside
  the container, copies the live stage's new bytes into the archive, and never
  runs inside the sandbox — a collector inside is killable by the malware it
  audits (d026's socket-diode flaw).
- **The archive is read-only in the sandbox.** It is bind-mounted `:ro` wherever a
  reader runs, so a sandbox insider can read captured logs and cannot delete or
  modify them.

The property this yields: for anything **captured**, the sandbox has no writable
path, so the diode holds by namespace. For anything **not yet captured**, the
harness can still rewrite or delete its own live stage — the un-persisted window
d026's sweep approach names. That window is the cost of shipping without d026,
and it is stated here rather than hidden.

## The reader

The reader consumes the **archive**, never the live stage. It works in both
environments the tree runs in:

- **Host-level.** It resolves the archive root directly, and can also enumerate
  the per-run stage directories when it is explicitly asked to read live state.
- **Sandbox insider.** The archive is present at a fixed read-only mount path,
  so the reader reads the same data without any host-only path.

Path resolution is a single resolver with a `--print-source`-style report, the
pattern `atuin-warehouse-sync.sh` already proves, and the host-versus-container
spelling follows `coding-harness-persistence`. The reader opens everything
read-only: `O_RDONLY` for files, `?mode=ro&nolock=1` for SQLite, and
`ATTACH … (TYPE sqlite, READ_ONLY)` for the OpenCode database.

The reader writes nothing to the store. Its output goes to the warehouse, so a
compromised reader can pollute the warehouse but cannot damage the archive — the
property that matters survives a hostile reader.

## Wiring

- `run.mjs` mounts the archive `:ro` into every sandbox, beside the read-write
  stage it already creates. That mount is the one placement change.
- The collector is the one new host-side component. It is small: tail the live
  stage, append a version, record it.
- The reader ships with the resolver above and needs no host-only assumption.

## What d026 changes, and what it does not

When d026 lands, its FUSE store replaces the collector's sweep and closes the
un-persisted window, because every write becomes a version at write time rather
than at poll time. The archive, the read-only mount, the dual-environment reader
and the read-only opens all stay as this record defines them; d026 changes who
writes the versions, not the contract the reader sees.

## Alternatives rejected

- **Wait for d026.** The collection leg is needed before the diode exists, and
  the archive and reader contract survives the diode unchanged.
- **Make the live stage append-only by permission or attribute.** keep-id defeats
  uid separation, SELinux has no append-only, and the stage must stay writable
  for the harness.
- **Run the collector inside the sandbox.** It is then under the adversary's
  control, which is worse than no collector because it looks like one.
- **Let the reader read the live stage.** It would see tampered data and hold a
  writable path to it.
