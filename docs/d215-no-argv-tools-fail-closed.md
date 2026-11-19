---
id: d215
type: architecture-design
status: active
title: "d215 — a tool that takes no arguments exits when given one"
parent: architecture
depends-on: [d058, d212]
references: [d213, d214]
tags: ["tooling", "cli", "fail-safety"]
---

# d215 — a tool that takes no arguments exits when given one

## Problem

Measured, not hypothesised: `40-download-models.py --help` provisioned the whole
catalog for real — 115 GiB written into a nearly full cache root over 42 minutes —
because the tool had no argument parser and no argv check. A tool whose contract is
"no arguments" silently treats every argument as unused, so `--help`, a flag copied
from an older runbook, or a shell typo (`--plan x`) runs the tool's full effect.
Nothing in the process distinguished "explain yourself" from "do it now", and the
only limit was free space.

The same silence hides a second failure: a runbook command that stopped being valid
still appears to work, because its argument is discarded instead of rejected.

## Decision

**A tool that accepts no arguments exits 64 with a one-line usage when argv is
non-empty.** A tool that needs a selector parses arguments explicitly; the absence
of accepted arguments must fail closed rather than open.

Three parts follow from it:

- The check is per runtime and per tool (a few lines each), not one shared helper:
  Python and Node each have exactly one call site per tool, and a helper reachable
  from one caller is the indirection the repo's priorities reject.
- A read-only preview is a **separate tool** (`60-audit-snapshots.py`), never a
  `--dry-run` flag on the destructive one — the same rule that keeps each tool to
  one job (d212, d213).
- The guard is stated in the tool's own usage line, so the failure teaches the
  contract instead of only refusing.

## Consequences

- `--help` costs nothing and cannot mutate state; a stale invocation from an older
  runbook fails loudly instead of re-provisioning.
- A tool that later grows an argument parser deletes the guard rather than extending
  it: the guard exists to make "no arguments accepted" true, not to filter.
- Libraries are out of scope (`lib/log.py`, `lib/model-entries.mjs`): they are
  imported, never invoked, and argv is not theirs.

## Alternatives rejected

**Print usage and continue.** The effect is identical to today's: the tool runs.

**Treat unknown argv as empty.** That is the status quo that burned the disk.

**A shared `parse_no_args` helper.** One caller per runtime; it moves the rule away
from the tool whose contract it states, and the explicit guard is shorter.
