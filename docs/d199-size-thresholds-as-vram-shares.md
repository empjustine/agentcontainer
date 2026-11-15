---
id: d199
type: module-design
status: active
title: "d199 — size thresholds are shares of the fleet card, not parameter counts"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d170, d195, d197, refresh-llm-local-inference-manifest]
tags: ["gguf", "generator", "vram", "quant-display", "thresholds"]
---

# d199 — size thresholds are shares of the fleet card

This record carries the one change of units behind three existing decisions: the
quant-display rules (d170) and the projector-offload ceiling (d195) now read as a
fraction of the serving GPU's memory instead of a parameter count. It states the
number, where the estimate comes from, and what is deliberately NOT probed.

## Problem

Every size rule in `generate.mjs` was written as "N billion parameters", which
is a proxy that only means something on one particular card. "Above 4B never
displays BF16" is really "a full-precision copy would eat most of the GPU", and
"above 12B loses the offloaded projector" is really "the weights leave no room
for it". Written in parameters, neither statement survives a card change, and
neither tells a reader how much memory is in play.

## Decision

One constant and two helpers carry the units:

- `FLEET_VRAM_GIB = 16` — the fleet's serving card, a 16 GiB-class board
  (15.98 GiB measured from `/sys/class/drm/card1/device/mem_info_vram_total` on
  tlalocayotl).
- `weightsVramShare(paramsB) = paramsB / FLEET_VRAM_GIB` — total parameters
  times the fleet's serving bytes per parameter, the Q4–Q8 ladder averaging
  ~1 GiB per billion. This is the share the SERVED weights claim.
- `fullPrecisionVramShare(paramsB) = 2 × paramsB / FLEET_VRAM_GIB` — the same
  weights at 2 bytes per parameter, i.e. what a BF16/F16 GGUF occupies.

The three thresholds follow, each stated where the share is read:

| rule                                                                          | was               | is                                                                      |
| ----------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| hide BF16/F16                                                                 | repo > 4B params  | full-precision copy > `FULL_PRECISION_MAX_VRAM_SHARE` = 50% of the card |
| drop up to four cheapest quants, never below two rows (d200: three and three) | repo < 4B params  | served weights < `SMALL_MODEL_VRAM_SHARE` = 25% of the card             |
| keep `2mmproj`                                                                | repo ≤ 12B params | served weights ≤ `MMPROJ_OFFLOAD_MAX_VRAM_SHARE` = 75% of the card      |

Read as the round numbers a reader needs: ~4B ≈ 25%, ~8B ≈ 50%, ~12B ≈ 75% of a
16 GiB board. The boundaries are unchanged — the shares were derived from the
counts, so the regenerated `config.d` is byte-identical to the layer the counts
produced.

"Cheapest" is manifest file size, ascending, and the count dropped is
`min(4, rows − 2)`: a repo with 7 or 8 rows keeps 3 or 4, one with 3 keeps 2,
and a repo built from a single quant keeps it — the floor is "never strip below
two", not "keep exactly two". A file the manifest does not list sorts last and is
never dropped.

> **Revised (d200).** The cut is `min(3, rows − 3)` and the 25% line now also
> removes the `0text` mode; the share constant is `SMALL_MODEL_VRAM_SHARE`,
> which both rules read.

**Total parameters, not active.** A 35B-A3B activates 3B per token but must
LOAD 35B of weights, and loading is what competes with the KV cache — the same
reasoning d170 recorded for the manifest-based count.

**Not probed at generation time.** The card is a constant, not a sysfs read,
because `config.d` is a committed artifact and its contents must not change with
the card of whichever host regenerates it (d050). A different fleet card moves
`FLEET_VRAM_GIB` and the three shares together, in one edit.

## Consequences

The rules now scale by editing one number, and a reader learns how much of the
card each rule is talking about. Nothing about the emitted layer changed: the
regeneration after this reframing is byte-identical, which is the proof that the
units moved and the boundaries did not.

The estimate inherits the usual caveats, now stated instead of implied: 1 GiB
per billion is an average over a Q4–Q8 ladder (a Q2 row is smaller, a BF16 row
larger — the full-precision rule reads its own 2-byte figure), and a card with
more VRAM than 16 GiB serves the same catalog, just with more headroom than the
rules assume.

## Alternatives rejected

- **Probe the live card at generation time.** It would make the committed layer
  host-dependent, the exact drift the artifact rule exists to prevent; the probe
  belongs to a host-viability gate (where `INFERENCE_MIN_RAM_GIB` already is),
  not to catalog policy.
- **Byte ceilings without a share.** "Above 8 GiB of weights" states a number
  without saying of what budget; the share names the budget.
- **Per-quant shares.** Rules keyed on each row's own footprint would flip inside
  one repo (the Q2 row passing where its BF16 row fails); d170 chose repo-level
  counts deliberately, and repo-level shares keep that shape.
