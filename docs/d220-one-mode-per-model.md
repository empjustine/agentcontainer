---
id: d220
type: module-design
status: active
title: "d220 — one mode per model: text or vision, and no mode segment in the id"
parent: llm-local-inference
depends-on: [llm-local-inference]
references:
  [d195, d200, d199, d210, d197, d170, d055, refresh-llm-local-inference-manifest, hf-cache-upkeep]
tags: ["gguf", "mmproj", "multimodal", "generator", "catalog", "naming"]
---

# d220 — one mode per model: text or vision, and no mode segment in the id

This record retires the projector fan that d195 (a ceiling above 75% of the
card) and d200 (a small-model line below 25%) built, together with the id
segment that existed so a caller could pick among its modes. One rule replaces
both: a repo either ships a projector or it does not, and that is the whole
choice. The quant-display halves of d195/d200 stand untouched.

## Problem

The fan was built to trade VRAM for projector placement on a catalog whose
extremes mattered: `2mmproj` where the weights left an offloaded projector
headroom, `0text` where clawing the projector's memory back was worth the
images. Two of its three modes then lost their justification on their own terms:
d195's ceiling exists because `2mmproj` runs slower exactly where it is
offered, and d200's line drops `0text` exactly where the projector fits
anyway. What remained was a fan whose ends only served a caller who had already
decided they did not want the vision row — at the cost of two or three ids per
row (62 ids for 28 rows), a mode vocabulary every caller had to learn, and a
size rule (the publisher's parameter count, read from the repo slug) that
existed only to place those ends.

## Decision

- **One mode per model, decided by the repo.** No projector in the committed
  manifest → `0text`; a projector → `1vision`. `2mmproj` is deleted rather
  than gated: the headroom case it was for is the case d195 measured as slower.
- **Precision over speed, for every row.** `--ubatch-size 2048` and
  `--no-mmproj-offload` move into the `LLAMA_SERVER` macro, so a text-only row
  carries them too. `0text` reduces to `--no-mmproj`, and `1vision`/`2mmproj`
  leave `llama-swap-core.json` instead of surviving as dead strings a later edit
  could revive.
- **The id is the manifest key.** No mode segment: an id is `repo` or
  `repo:quant`, which is exactly what the cache directory, the curated
  `entries` list and the repo manifest name — one string from a caller's config
  to the bytes (d170, d210). The duplicate-id check stays: two rows that derive
  one id stop the run (d050).

## Consequences

- The layer drops from 62 ids to 28, one per surviving row. A caller pinning
  `0text-…` or `1vision-…` needs the bare key — the same class of churn d210
  accepted for the quant suffix, and cheaper to absorb: the committed
  `coding-agent` catalogs are fetched per run, so nothing in the tree pins an
  id.
- A text-only row passes `--no-mmproj` even though its repo ships no projector.
  The flag now states the mode instead of leaving it to whatever a GGUF embeds,
  and it costs nothing: no projector is loaded either way.
- The 25% line keeps one job — the cheap-quant cut (d200) — and the 75% ceiling
  has none. d199 tabulates both; only the first survives, and the parameter
  count read from the slug is gone with the fan.
- `--ubatch-size` sizes the compute buffer rather than the weights, so retiring
  512 is the same trade as the rest of the record: prompt-processing throughput
  over the memory a smaller batch would return.

## Verification status

The rule is pinned by two tests in `llm-local-inference/tests/`:
`prune-quant-display.test.mjs` proves a projector repo emits `--mmproj` and no
`0text` macro while a text-less-of-projector repo emits the macro and no
`--mmproj`, asserts no id in either layer carries a mode segment, and pins the
macros (`LLAMA_SERVER` carrying the two mandates, `0text` equal to
`--no-mmproj`, the two retired macros absent); the committed layer is 28 ids
from 28 rows.

## Alternatives rejected

- **Keep the segment with every model using it anyway.** A segment that selects
  nothing is d210's "a label exists only where a choice does" one level up: it
  triples the catalog and invites a pin to a mode that no longer means anything.
- **Keep `2mmproj` behind d195's ceiling.** The ceiling was calibrated on rows
  that left the offloaded projector no headroom; the mode's premise is inverted
  precisely where it stayed enabled.
- **Keep `0text`'s 512 ubatch for text-only rows.** That was the same
  VRAM-return trade as dropping the projector, and the precision mandate
  reverses it everywhere it appears.
