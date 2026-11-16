---
id: d202
type: module-design
status: active
title: "d202 — full-precision rows: F32 counts, the row is measured, and the last row stays"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d170, d195, d199, d200, refresh-llm-local-inference-manifest]
tags: ["gguf", "generator", "vram", "quant-display", "f32", "moe"]
---

# d202 — full-precision rows: F32 counts, the row is measured, and the last row stays

This record repairs three things about the quant-display rule d170 introduced and
d199 converted to shares: which tags count as full precision, what a row is
measured with, and what happens when hiding a row would hide a repo. It also
states what the parameter estimate means for a mixture-of-experts model, because
the answer is "not what the VRAM argument says".

## Problem

**The "full precision" fact had two spellings, and F32 was in neither.**
`totalParamsB` walked `["BF16", "F16"]` over the manifest and `pruneQuantDisplay`
tested `/(bf16|f16)$/` against the table's `:quant` label. A repo whose only
full-precision upload is F32 therefore sized as unknown and skipped both rules,
and a repo shipping BF16 beside F32 hid the BF16 row while keeping the F32 row at
twice its bytes — the rule removed the smaller variant and kept the larger.

**A parameter count in 2-byte units is the wrong instrument for an F32 row.**
`fullPrecisionVramShare(paramsB) = 2 × paramsB / FLEET_VRAM_GIB` states the
BF16/F16 footprint. An F32 row occupies four bytes per parameter, so adding the
tag to both lists would have judged it at half its size.

**The estimate trusted names it could not verify.** The bare-upload fallback
took the largest file with no quant tag, which an `imatrix` blob or a projector
whose basename the `mmproj-` prefix misses also satisfies: a 27B repo sized as
0B and lost a quant row. The tagged branch had the same hole from the other side
— a file that merely ENDS in `bf16`, such as `<model>-mmproj-bf16.gguf`, was
read as the weights.

**The rule had no floor.** The small-model cut refuses to fall below
`CHEAP_QUANT_KEEP_MIN` rows; the full-precision rule hid every matching row. A
repo that publishes nothing else lost all of them, which is not a pruned catalog
row but a silently deleted repo.

## Decision

- **One table owns the tag set.** `FULL_PRECISION_BYTES_PER_PARAM =
  { f32: 4, bf16: 2, f16: 2 }` feeds `fullPrecisionTag` (shard suffix stripped,
  `bf16` before `f16` because "…BF16" ends with "f16"), `totalParamsB` and the
  name test the bare-upload fallback excludes with. A new spelling is one line.
- **The row is measured on its own bytes.** The rule is
  `bytesVramShare(rowBytes) > FULL_PRECISION_MAX_VRAM_SHARE`, and
  `fullPrecisionVramShare` is gone with it: a BF16/F16 row keeps its verdict, an
  F32 row is judged at 4 bytes per parameter, and the ceiling names exactly the
  number it compares. A row the manifest cannot size stays — unsized keeps,
  never guesses (d170).
- **A row is full precision if its FILE says so, else if its label does.**
  `entryFullPrecisionTag` reads `model` first and the `:quant` label second,
  because `XHToken` uploads full precision untagged (`Spark-X2.6-4B.gguf`, which
  `fetch_hf_manifests.py` reports as label-only) and the label is the only place
  that fact survives. The file wins a disagreement: it is what gets served.
- **The largest main GGUF is the full-precision candidate.** 2 bytes per
  parameter is the lightest full precision there is, so a repo's full-precision
  upload is its biggest main GGUF and anything smaller is a quant, a side build
  or an auxiliary. `totalParamsB` reads that one rule instead of trusting names:
  a `dflash`/`dspark`/MTP side build carries a full-precision tag but is never
  the biggest file, an untagged `imatrix` blob or a `<model>-mmproj-bf16`
  projector is never the biggest file, and the negated quant vocabulary does not
  have to be complete because a 1-bit build is never the biggest file either.
  The name test survives as the tie-breaker between a tagged and an untagged
  candidate of the same size.
- **The last row stays.** Where the hide set is the whole group, the smallest
  full-precision row survives and an info line names it (d208) — the same floor
  `CHEAP_QUANT_KEEP_MIN` states for the quant cut. A rule prunes a catalog, it
  never deletes a repo.
- **Total parameters stay the estimate (d199), and it means bytes held.** It is
  how large a full-precision copy is, not a demand that every row fit in VRAM:
  an MoE such as `Qwen3.6-35B-A3B` keeps its Q8 rows because it streams weights
  from RAM behind a ~3B active slice, so a share of the card that reads "full"
  describes its footprint, not its servability. Hence no per-row "fits the card"
  rule — the same reason d199 rejected per-quant shares.

## Consequences

On the committed tables the regenerated layer is byte-identical: the same seven
rows are hidden (six BF16 — gemma-4 E2B/E4B/12B/26B-A4B, Qwen3.8-27B,
LFM2.5-24B-A2B — and `Spark-X2.6-4B:F16`), five are kept, and the layer holds
356 ids. Verdicts move only where an F32 row or a full-precision-only repo
exists, and no table carries either today.

A repo that ships several full-precision tags now has each judged on its own
footprint rather than the group judged by whichever file the estimate happened to
read. No repo carries a sub-ceiling sibling today, so that difference too is
latent.

An F32 upload that carries no tag in its name reads as 2 bytes per parameter
when it is the repo's largest file, so the estimate doubles the parameter count
of such a repo — an over-estimate, which cuts quants and hides full-precision
rows earlier than the truth would. A name ending in the tag is read correctly;
only a header read (which `gguf_context_length.py` already performs for context
windows) removes the guess.

## Verification

`llm-local-inference/tests/prune-quant-display.test.mjs` pins both halves (and
d206's speculation wiring, which shares the same spawn harness). It spawns a real
generation over a temp copy of the unit with a fixture table, so every assertion
is an emitted model id — the thing a caller sees:

- **known-known**, shapes the committed manifests already carry: an MTP drafter
  under `MTP/`, a root `dflash-` side build, a `dspark/` side build, an
  `mmproj-` projector, a split BF16 group, an untagged Spark upload over and
  under the ceiling, a repo with no full precision at all (byteshape), and the
  two live cheap-quant cuts.
- **unknown**, traps found in review and absent from the tables: an untagged
  `imatrix` auxiliary (and the same repo through the mmproj fan, where unsized
  keeps all three modes while a repo mis-sized as 0B loses `0text`), a projector
  named `<model>-mmproj-bf16.gguf`, the `Q1_0` tag no exclusion list names, F32
  alone and beside BF16, a repo publishing nothing but full precision, and a
  one-row repo.
- **the committed catalog**: exactly five full-precision rows survive, and no
  repo in the table disappears from the layer.

Generation determinism — the same bytes from the same inputs, d170's open item —
stays open: these assertions are on the id set, which is host-independent, and
not on the baked snapshot paths, which are not.

## Alternatives rejected

- **Add F32 to both existing tag lists.** Two homes again — the failure this
  record exists to repair — and the row would still be measured at 2 bytes per
  parameter.
- **Read bytes-per-parameter from the row's tag and multiply a parameter
  count.** The manifest already carries the row's size, so the tag only decides
  _whether_ a row is full precision; multiplying would add a computation that can
  only disagree with the number it was derived from.
- **Hide every full-precision row and let the repo disappear.** An operator
  listed the repo; an id set that empties because a rule applied is a catalog
  deletion nobody reviewed, and the config would have no way to say so. One
  surviving row plus a logged decision keeps it visible.
- **Drop rows that cannot fit the card.** Rejected on MoE grounds above: an
  offloaded MoE serves on a card its total-parameter share calls full, so
  "cannot fit" is not "cannot run", and d199 already rejected per-quant memory
  rules for the same reason.
