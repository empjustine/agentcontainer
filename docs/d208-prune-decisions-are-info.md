---
id: d208
type: module-design
status: active
title: "d208 — prune decisions log at INFO; the WARN band is for states an operator must act on"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d170, d197, d202, d206, d207]
tags: ["gguf", "generator", "logging", "observability"]
---

# d208 — prune decisions log at INFO; the WARN band is for states an operator must act on

This record moves four log lines one severity down. Nothing about the emitted
layer changes; what changes is whether the log can be read.

## Problem

`generate.mjs` logs the quant-display decisions with `logWarn`: 7 hidden rows,
6 dropped cheap quants, 10 "cannot be sized" skips and the floor's kept row on a
single healthy run. `lib/log.mjs` documents the reading contract the other way
round — "whoever reads the stream prunes it — `jq 'select(.severityNumber >= 13)'`"
— so on a clean host that filter returns 23 lines that are all expected, and the
one record that matters (a cache miss naming `./download_models.py`, a missing
`gguf-facts` entry) sits inside them.

Measured on the fleet host after the drafters were provisioned: `exit 0`, the
layer byte-identical, the cache warnings all gone — and 23 WARN records still in
the stream. A band that is never empty is wallpaper, which is the same reasoning
the lint gate applies to a formatter whose check never passes.

## Decision

- **Prune decisions are INFO.** `full-precision variant hidden`, `cheap quant
  dropped`, `cheap-quant pruning skipped — no full-precision file sizes`, and
  `repo publishes nothing but full precision — keeping its smallest row` move to
  `logInfo`. They are the audit trail of the rules, and d170 keeps the flat table
  as the full record beside them; the log line says which row the rule removed.
- **WARN is reserved for an operator's action.** It keeps: a cache miss naming
  `./download_models.py` (d197), a missing `lib/gguf-facts.json` entry naming
  `gguf_context_length.py --facts` (d197), a pinned ctx clamped to the header, a
  `mmproj` override that is not the repo's BF16 pick, and two image-token
  budgets in one repo. ERROR stays for the capability gate and the hub guard
  (`exit 94`/`95`, d207).

## Consequences

A healthy generation prints 28 INFO records and **zero** WARN records, so
`select(.severityNumber >= 13)` is empty on a correct host and points at the
offending repo on a broken one. The audit trail survives: every decision is still
in the stream, one severity down, and the counts match the layer (7 hidden, 6
dropped, 10 unsized repos).

d202's wording for the floor ("a warning names it") follows the code: an info
line names it.

## Alternatives rejected

- **Silence the decisions.** They are the only per-row statement of why an id is
  absent from the layer; the table says what exists, not what the generator did
  with it.
- **Keep WARN and add a field (`decided: true`).** Readers filter on severity,
  the one axis the log lib defines; an invented field nobody filters on is worse
  than the wallpaper.
- **A `--quiet` flag.** A second switch over a stream that already has a level
  axis; the same information, one more thing to document and test.
