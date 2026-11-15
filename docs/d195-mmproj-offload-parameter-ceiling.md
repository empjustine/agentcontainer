---
id: d195
type: module-design
status: active
title: "d195 — the GPU-projector mode ceiling, re-landed on parameters"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d055, d029, d170, refresh-llm-local-inference-manifest]
tags: ["gguf", "mmproj", "multimodal", "vram", "generator"]
---

# d195 — the GPU-projector mode ceiling, re-landed on parameters

This record carries the rule that decides _how many_ serving modes a
multimodal entry emits, and why the ceiling d170 retired comes back on a
different input. It is not an account of the mode macros themselves
(`llama-swap-core.json` and the refresh runbook own those strings) and it is
not a judgement about which quants exist.

## Problem

Every entry carrying an `mmproj` fans out to `0text`, `1vision` and
`2mmproj` (d029 F6). d055 gated the third mode on total footprint ≤ 14 GB,
because above that the weights already fill the GPU and co-resident projector
weights force eviction, so `2mmproj` runs slower than `1vision` — the mode's
own premise inverts where it is offered. d170 removed the gate together with
`size-gb`, leaving an unconditional 3× cross-join: the 27B, 31B, 35B-A3B and
26B-A4B entries all advertise a GPU-offloaded projector again.

## Decision

Suppress `2mmproj` above `MMPROJ_OFFLOAD_MAX_PARAMS_B = 12` total
parameters; `0text` and `1vision` are unaffected. (The ceiling is expressed as a
share of the fleet card — `MMPROJ_OFFLOAD_MAX_VRAM_SHARE` = 0.75, same boundary
— since d199.) Above the ceiling is not the only gate: below 25% the fan sheds
`0text` instead, because there the projector fits beside the weights and the
no-projector mode buys nothing (d200). Total parameters come from
`totalParamsB` (d170's manifest rule: BF16, else F16, main GGUF bytes ÷ 2),
falling back to the size the publisher declares in the repo slug
(`Qwen3.8-27B`, `gemma-4-E2B`) via `declaredParamsB`.

The fallback is load-bearing, not a convenience: 10 of the 18 `mmproj` repos
ship no full-precision file, so `totalParamsB` is null for exactly the
26B-A4B, 27B, 31B and 35B-A3B qat, byteshape and JetBrains repos the ceiling
exists to catch. Under d170's "unsized keeps, never guesses" stance those
entries would keep the one mode the ceiling suppresses. The slug token agrees with
the manifest count on every repo where both exist (27B slug / 27.3 B manifest,
35B / 34.7, 26B / 25.3, 12B / 11.95, 3B / 2.7), and the degenerate
active-parameter segments (`A3B`, `A4B`) never come first in the slug. An
entry whose parameters neither source can state still keeps all three modes.

Parameters rather than bytes: d170 retired `size-gb` and the class a model
belongs to does not move when its quant does — a 27B at IQ1_S is 6 GB and
still cannot host its projector beside the weights.

## Consequences

Result at landing: every `mmproj` entry above the ceiling loses `2mmproj` —
all of `unsloth/Qwen3.8-27B`, `unsloth/Qwen3.6-27B`,
`unsloth/Qwen3.6-35B-A3B`, `byteshape/Qwen3.8-27B`,
`byteshape/Qwen3.6-35B-A3B`, `JetBrains/Qwen3.8-3.6-27B-blend`,
`gemma-4-26B-A4B` and its qat repo, `gemma-4-31B-it-qat` — while the
3B/4B/12B families keep all three. 47 raw entries sit above the ceiling; two of
them are full-precision rows `pruneQuantDisplay` already removes, so the
committed `10-local` layer drops from 276 to 231 model entries.

The threshold stays a product call (d029 C1), not a measured boundary: 12B is
where a quant begins competing with the projector for a consumer GPU's VRAM,
and it is the largest class this fleet serves with the projector resident.
A repo whose slug carries no size token would silently keep the mode; the
runbook's entry rules are where that surfaces.

## Files touched

- `llm-local-inference/generate.mjs` — `MMPROJ_OFFLOAD_MAX_PARAMS_B`,
  `declaredParamsB()`, `mmprojModesFor(paramsB)`.
- `llm-local-inference/refresh-llm-local-inference-manifest.md` — the
  `mmproj` key row and the mode-fan note.
- `llm-local-inference/config.d/10-local-llm-inference.yaml` — regenerated.

## Verification

`LOCAL_INFERENCE=1 ./node-run.sh llm-local-inference/generate.mjs` on a host
with the HF cache: per-repo mode counts show `0text`=`1vision` everywhere,
`2mmproj` = `1vision` for the ≤ 12B repos and absent above it — 231 ids, 45
fewer than before, no repo whose `2mmproj` count exceeds its `1vision` count.
The absolute counts here are the post-landing state; d197 later fills the
projector for every entry of a vision repo, which is why the layer now carries
more models than the 231 counted above.
