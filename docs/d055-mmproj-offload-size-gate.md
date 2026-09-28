---
id: d055
type: design
status: implemented
title: "d055 — suppress the GPU-projector (`2mmproj`) mode above 14 GB"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d029, d053, refresh-local-llm-manifest]
tags: ["gguf", "mmproj", "multimodal", "vram", "generator"]
---

# d055 — suppress the GPU-projector (`2mmproj`) mode above 14 GB

**Status: implemented.** `llm-local-inference/generate.mjs` no longer emits the
`2mmproj` serving variant for a multimodal entry whose total footprint exceeds
14 GB. `0text` and `1vision` are unaffected.

## Problem

Every mmproj-bearing entry expands to three llama-swap models (d029 F6):
`0text` (projector absent), `1vision` (projector on CPU), and `2mmproj`
(projector offloaded to the GPU). The third variant only pays off when the
projector's weights fit *alongside* the model. Above roughly 14 GB total the
model already saturates the GPU, so co-resident projector weights force weight
eviction / CPU offload and `2mmproj` ends up **slower** than `1vision`: the
mode's premise (a GPU-resident projector) inverts exactly where it is offered,
and nothing in the id tells the caller which side of the line a quant is on.

## Decision

Gate on the entry's total `size-gb` — model + mmproj + draft, the same number
`model-sizes.mjs` orders by (d053) — and emit the `2mmproj` variant only at or
below `MMPROJ_OFFLOAD_MAX_SIZE_GB = 14`. Larger entries keep `0text` +
`1vision`; the projector still loads, just on the CPU. An entry whose `size-gb`
is not yet computed (hand-added, pre-`model-sizes`) keeps all three modes
rather than silently dropping one.

The threshold is a product call (d029 C1), not a measured boundary: 14 GB is
where a quant starts competing with the projector for a consumer GPU's VRAM.
Result at time of writing: 36 of 62 mmproj entries lose the `2mmproj` variant
(e.g. the JetBrains blend keeps it only at `IQ3_S` 13.5 GB, not `Q4_K_M`
17.7 GB).

## Files touched

- `llm-local-inference/generate.mjs` — `MMPROJ_OFFLOAD_MAX_SIZE_GB` +
  `mmprojModesFor()`; `MMPROJ_MODES` stays the full set.
- `docs/d055-mmproj-offload-size-gate.md` — this record.

## Verification

- Dry-run generation (`DRY_RUN=1`): every `size-gb > 14` mmproj entry emits
  exactly `0text` + `1vision`, every `size-gb ≤ 14` entry emits all three —
  36 suppressed, 0 threshold mismatches.
