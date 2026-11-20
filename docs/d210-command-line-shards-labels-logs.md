---
id: d210
type: module-design
status: active
title: "d210 — the served command line: explicit shards, a label only where a choice exists, and structured logs"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d029, d197, d206, d207, gguf-model-tooling, llm-local-inference-offload]
tags: ["gguf", "generator", "shards", "hf-repo", "logging"]
---

# d210 — the served command line: explicit shards, a label only where a choice exists, and structured logs

Three edits to the args every entry carries, each removing a place where the
config restated something the server already knew — plus the two flags worth
spelling out because the macro is the fleet's operating contract.

## Status

Superseded in part by [d220](d220-one-mode-per-model.md): the mode segment
left the id, so an id is the manifest key exactly — `repo` or `repo:quant`,
not `[<mmprojMode>-]repo:quant`. The label rule, and the churn this record
accepted for it, stand.

## Problem

**Shards were resolved by naming convention.** An entry's `--model` names the
`00001` shard and llama-server finds the rest by looking for its siblings. The
generator already validates that every shard is in the snapshot, and
`download_models.py` already fetches all of them, so the load-time lookup only
adds a failure mode: a shard that lives under another name, or was moved out of
the directory, loads as a truncated model rather than as a missing file.

**The `:quant` label survived where nothing could select.** `--hf-repo`'s quant is
a SELECTOR ("quant is optional, case-insensitive, default to Q4_K_M, or falls
back to the first file"), but the served rows never use `--hf-repo` — the label in
our table is the model-id suffix and the audit's expectation. A repo whose
catalog holds one quant has no choice to express, so the suffix restates the
only row it has; ten such rows carried one anyway, and `fetch_hf_manifests.py
--offline` would then audit them against the Q4_K_M default they never claimed.

**The log format was a colour switch.** `--log-colors off` predates
`--log-jsonl`, which disables colour itself and emits one JSON object per line.
Timestamps are added again by the relay and its `logTimeFormat` setting, so the
server's own were a second clock on every line.

## Decision

- **Every extra shard is named.** `bakeSnapshotPaths` returns `shardPaths`
  (`allShards(model).slice(1)`, resolved into the same snapshot) and the cmd
  carries `--shard <p2>,<p3>,...` beside `--model <p1>`. The server stitches
  shards "from anywhere, including different drives"; the file set comes from the
  committed manifest and the cache check, so generation is the one place that
  decides it (d029).
- **A label exists only where a choice does.** A repo whose table holds exactly
  one row drops its `:quant`, and the model id loses the suffix with it
  (`unsloth/Qwen3.6-27B-GGUF`, not `…:Q4_K_M`). Rows in a multi-quant repo keep
  theirs: there the label names which file the row serves, which is what a caller
  reading the id needs. `fetch_hf_manifests.py --offline` prints `unlabelled` and
  passes an unlabelled entry instead of guessing the Q4_K_M default — a label
  that does not exist cannot be misspelled.
- **Logs are structured, and the defaults we rely on are spelled out.** The macro
  uses `--log-jsonl` (replacing `--log-colors off`), `--no-log-timestamps`, and
  `--lazy-mode auto` — the last being the documented default ("on, but only for
  tensors larger than 4 GiB", requires mmap, which the macro pins), written down
  because a fleet config that depends on a default should say so and a bump that
  changes it then shows up as a diff.

## Consequences

The layer keeps 356 ids; ten of them lose their `:quant` suffix, so a saved chat
or a pinned id naming one of those rows needs the short form. No emitted cmd is
sharded today (the only sharded rows are the full-precision uploads the display
rules hide), so `--shard` is a correctness rule waiting for its first survivor —
and a fixture pins it.

llama-swap loses nothing to `--log-jsonl`: its readiness probe reads the health
body's `{"progress": …}` and its per-request metrics parse the response
`timings`, not the server's log text. The server's own log lines become
machine-readable for the measurement plan in
[llm-local-inference-offload](offload-and-moe-tuning.md), which is where
`--n-gpu-layers-draft`, `--moe-cache-mib` and `--moe-cache-cpu-share` wait for
numbers.

## Alternatives rejected

- **Keep relying on shard-name auto-discovery.** It works until a shard is named
  differently, and then the failure is a silently truncated model rather than a
  generation error naming the file.
- **Drop every `:quant` label.** Multi-quant repos need it: the id is
  `[<mode>-]<repo>:<quant>` and two rows of one repo would collide without it.
- **Keep `--log-colors off` beside `--log-jsonl`.** The JSONL switch already
  disables colour; two flags for one decision is the drift this tree keeps paying
  for.
- **Pin `--n-gpu-layers-draft all` today.** The arithmetic needs a measurement
  (drafter weights + draft KV at 262144 tokens against the card), not a guess:
  see the measurement plan.
