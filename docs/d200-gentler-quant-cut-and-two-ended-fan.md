---
id: d200
type: module-design
status: active
title: "d200 — a gentler quant cut and a two-ended projector fan"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d170, d195, d199, refresh-llm-local-inference-manifest]
tags: ["gguf", "generator", "mmproj", "quant-display", "catalog"]
---

# d200 — a gentler quant cut and a two-ended projector fan

This record carries two corrections to rules that d170 and d195 introduced: the
small-model quant cut was too aggressive for a hand-curated catalog, and the
projector fan kept a mode that only makes sense where VRAM is contested. Both
read the same line — `SMALL_MODEL_VRAM_SHARE` = 25% of the fleet card (d199).

## Status

Superseded in part by [d220](d220-one-mode-per-model.md): the two-ended fan
is gone (one mode per model), so only this record's gentler quant cut stands.

## Problem

**The cut ran past what a caller needs.** The rule was `min(4, rows − 2)`: it
could remove four of a repo's rows and leave it with two, which on a small model
is the whole ladder a caller picks a footprint from. `LiquidAI/LFM2.5-2.6B` lost
`Q4_0`, `QAD-Q4_0`, `Q4_K_M` and `Q5_K_M` out of seven; `ai9stars_G9v3-3B` and
`Spark-X2.6-1.7B` lost a row out of three, i.e. a third of their whole offering
on a model whose every quant is servable.

**`0text` earned nothing below the small-model line.** The mode exists to shed
the projector when VRAM is tight (`--no-mmproj --ubatch-size 512`). Under 25%
weights the projector — 0.18 GB for gemma-4-12B's encoder-free projection layers,
0.86–1.19 GB for the encoder-bearing families — fits beside the weights with room
for the KV cache, so the mode asked a caller to give up images for a saving that
was never needed.

## Decision

- **`CHEAP_QUANT_DROP_MAX = 3`, `CHEAP_QUANT_KEEP_MIN = 3`**: drop
  `min(3, rows − 3)` of the smallest-file rows. A repo with seven rows keeps
  four, one with eight keeps five, one with three keeps all three. The floor and
  the cap now coincide, so a repo can never be cut to the state the old rule
  allowed.
- **The fan is gated from both ends** (`mmprojModesFor`): above
  `MMPROJ_OFFLOAD_MAX_VRAM_SHARE` (75%) drop `2mmproj` (d195); below
  `SMALL_MODEL_VRAM_SHARE` (25%) drop `0text`; between them all three modes, and
  unknown parameters still keep all three (d170's "unsized keeps").

## Consequences

The layer holds 356 models: `plain` 32, `0text` 125, `1vision` 130, `2mmproj` 69. Four quant rows returned (`LFM2.5-2.6B:Q5_K_M`, `G9v3-3B:Q6_K`,
`LFM3-1.7B:NVFP4`, `Spark-X2.6-1.7B:Q4_K_M`) and only `LFM2.5-2.6B` and
`LFM3-1.7B` are still cut at all, three rows each.

Five `0text` ids disappear — the whole fan of the three sub-25% vision repos
(`LFM2.5-VL-3B` ×2, `gemma-4-E2B-it-qat` ×2, `gemma-4-E2B-it-qat-mobile` ×1).
A caller that wants text only from those now uses the `1vision` id and pays for
a projector it does not need; that is the intended trade — the alternative was a
catalog row that only looked like an optimisation.

A model pinned at `1vision` mid-range keeps its `0text` sibling, so the
"cheapest text-only" id survives everywhere VRAM is actually contested.

## Alternatives rejected

- **Keep `0text` for every vision repo.** It is the only mode that needs no
  projector file in the snapshot, which has operational value on a host that
  cached the weights but not the projector — but generation now validates the
  projector against the committed manifest and `download_models.py` provisions
  it, so that value only exists in a broken-cache state the bake already warns
  about.
- **Cut by precision rank instead of file size.** The manifest's sizes are the
  sizes served, so the smallest files are the cheapest quants by construction;
  a separate rank table would be a second home for the quant ladder.
- **Hiding `0text` under a parameter count.** d199's units apply: the whole
  point is a memory line, so the line is a VRAM share.
