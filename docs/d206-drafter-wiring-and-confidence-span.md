---
id: d206
type: module-design
status: active
title: "d206 — drafter wiring: the confidence-gated span, one type per row, precision-first drafters"
parent: llm-local-inference
depends-on: [llm-local-inference]
references: [d170, d195, d197, d202, refresh-llm-local-inference-manifest]
tags: ["gguf", "generator", "speculation", "mtp", "dflash", "dspark", "quant-display"]
---

# d206 — drafter wiring: the confidence-gated span, one type per row, precision-first drafters

This record fixes the speculation half of a served entry: what stops a draft span,
where the spec type lives, which repos carry a drafter, and how the drafter is
quantized. It also records the correction that made the wiring necessary — the
"flags without a sidecar are dead" reading was wrong.

## Problem

**The type had two homes and the tuning one.** `DRAFT_MTP` in
`llama-swap-core.json` carried `--spec-type draft-mtp --spec-draft-n-max 16
--spec-draft-p-min 0.8`, while the generator emitted `--spec-type` for every
entry with a `model-draft`. 20 rows therefore named the type twice. That is
inert only because llama.cpp folds the type list into a bitmask — but a dflash
row could not use the macro at all, since its type must be `draft-dflash` and
llama.cpp refuses a type that disagrees with the drafter's head.

**The strategy was undocumented, and its flags were misread.** The macro's
`--spec-draft-p-min 0.8` is the stop rule: llama.cpp drafts while the drafter's
own next-token probability stays at or above it (`common/speculative.cpp`, MTP
loop: "only collect very high-confidence draft tokens"; DSpark's variant
truncates at its confidence head). `--spec-draft-n-max` is only a ceiling, and
upstream's default of 3 would cap every span at three tokens. Reading the
emitted config then suggested that the 34 rows carrying the macro without a
`model-draft` were dead flags. They are not: with no drafter,
`common_speculative_init_result` builds the MTP context **against the target
model** ("creating MTP draft context against the target model") and the model's
own nextn layers do the drafting.

**Two repos shipped drafters the table never wired.** `unsloth/Qwen3.8-27B-GGUF`
ships `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` and `JetBrains/Qwen3.8-3.6-27B-blend-GGUF`
ships both a dflash Q4_K_M and a bf16 build, so 28 rows drafted with the target's
own heads while a purpose-built drafter sat in the same snapshot.

**The drafter quant guidance inverted its own purpose.** The runbook recommended
`Q8_0` as "negligible acceptance loss". A drafter exists to be accepted: its
precision is the acceptance rate, and nothing else — a drafted token is verified
against the target, so a weaker drafter costs throughput, never output quality.

## Decision

- **One home per fact, one macro per span shape.** The macros carry tuning only:
  `SPEC_MTP = "--spec-draft-n-max 16 --spec-draft-p-min 0.8"` and
  `SPEC_DFLASH = "--spec-draft-n-max 3 --spec-draft-p-min 0.8"`. The spec type is
  a per-entry `spec-type`, emitted by the generator whenever it is set or a
  sidecar exists (default `draft-mtp`). A dflash row names `draft-dflash` in the
  table and references `${SPEC_DFLASH}`; a built-in-speculator row names
  `draft-mtp` and passes no `--model-draft`.
- **The span is confidence-gated, and the ceiling stays out of the way.** 16
  never binds at the ~9-token spans the fleet observes; it exists so a drafter
  that stays confident cannot run unbounded, and lowering it to the observed
  number would truncate exactly the runs the rule wants to allow. Tuning, if any,
  moves `p-min`, which trades span length for acceptance.
- **Drafter precision is chosen before drafter size.** BF16 → F16 → Q8_0 → Q4_0,
  bounded by keeping the target GPU-resident. `gemma-4` sidecars move from
  `Q8_0` to the repo's `BF16` upload (0.17–0.96 GB, so the cost is a rounding
  error); `Qwen3.8-27B` gets its only upload (`Q4_0`, 1.37 GB); the blend gets
  dflash `Q4_K_M` (1.14 GB), because its `bf16` build is 3.86 GB against a 27B
  target on a 16 GiB card and would push target layers to CPU.
- **Self-speculation is a first-class route, not an oversight.** A model with
  built-in nextn heads needs no sidecar, so its row names the type and nothing
  else. This is what the 6 remaining sidecar-less rows do.
- **The dflash family takes the same knob with different mechanics, and a
  smaller block.** Drafts arrive as one block per forward pass
  (`dflash.block_size`, default 16, is the trained maximum; the runtime block is
  `n-max + 1`, clamped to it), so `n-max` IS the block size. A four-token block
  (`--spec-draft-n-max 3`) is the fleet's choice: the confidence head usually
  truncates within the first few tokens, and a longer block costs a full forward
  pass whether or not it fills — the block, not the confidence rule, is what a
  16-token ceiling would have paid for. `p-min` still truncates at the first
  block token below the threshold. DSpark uses `p-min` as its confidence-head
  cutoff and refuses `--spec-draft-p-min > 0` when the drafter has no confidence
  head, so a DSpark row needs its own type and, absent a head, `p-min 0`.
- **The key cache is never quantized; the value cache quantizes both contexts.**
  Quantizing keys is the half of the KV trade that moves KLD, so every entry
  keeps llama.cpp's `f16` key cache and the generator emits no
  `--cache-type-k` at all — the knob is gone, not defaulted. Values may be
  quantized (`cache-type-v`), and an entry that quantizes them quantizes the
  drafter's cache from the same key (`--spec-draft-type-v`), because a drafter
  reading a finer cache than its target predicts nothing useful: the pair is one
  decision, one edit.

## Consequences

The layer still holds 356 ids. 45 rows now pass a drafter sidecar (25
`Qwen3.8-27B` — new — and 20 `gemma-4`, at `BF16` instead of `Q8_0`), 3 blend
rows pass a dflash drafter, and 6 rows drop to type-only self-speculation. No
cmd names `--spec-type` twice.

Provisioning follows the bake: `download_models.py` already fetches
`model-draft`, and a host whose snapshot lacks the file generates with a warning
and a manifest-declared path (d197's cache-miss rule) — the drafter is a normal
cache dependency, not a launch-time download.

The cache knobs resolve to: no cmd carries `--cache-type-k`; the 42 rows that
quantize values — the 33 `Qwen3.8`-family rows (unsloth, byteshape, blend) and
the 9 `gemma-4` **QAT** rows — carry `--cache-type-v q8_0` paired with
`--spec-draft-type-v q8_0` on every emitted mode (86 cmds); every other row keeps
`f16` values and passes no draft-cache flag, because llama.cpp's draft default is
`f16` too. Verification of the assumption behind the request: only the
`Qwen3.8` family carried cache overrides — the `gemma-4` QAT repos carried none,
so their `q8_0` values are an addition this record makes deliberately (QAT is
trained to absorb quantization; the plain `gemma-4` rows stay at `f16`).

The `Qwen3.8-27B` wiring replaces the target's own MTP heads with a `Q4_0`
drafter, so it is the one change here that can lower acceptance on rows whose
target quant is already Q6 or Q8 (their in-file head is finer than `Q4_0`).
Acceptance is measurable on the serving host — llama-server logs draft acceptance
per request at the log level the `LLAMA_SERVER` macro sets — and dropping the
`model-draft` key from a row reverts it to self-speculation.

## Alternatives rejected

- **Keep `--spec-type` in the macro.** Two homes for one fact, a duplicated flag
  on every sidecar row, and a dflash row that must either repeat the type or
  fight the macro's MTP default.
- **Wire the `Qwen3.8-27B` sidecar only on the sub-Q4 rows.** That arithmetic
  needs the tensor precision of the in-file MTP head, which no committed artifact
  carries; a uniform row set plus a measured A/B states the trade honestly.
- **The blend's `bf16` dflash drafter.** 3.86 GB is a sixth of the card and buys
  acceptance the target cannot cash while it is offloading layers.
- **Tune `--spec-draft-n-max` down to the observed span.** A ceiling set at the
  current workload's maximum truncates the rare confident run and saves nothing:
  the confidence rule stops the draft long before the cap.
- **Drop the macro from sidecar-less rows as "dead flags".** That reading is what
  this record corrects: those rows self-speculate against the target model.
- **Keep a `cache-type-k` knob with an `f16` default.** A default invites the
  override that costs quality, and the table already carried three of them; a
  knob that must never move is not a knob.
- **A dflash block at the trained maximum (16).** The pass is paid up front, so a
  block the confidence head abandons after two tokens buys nothing and costs the
  batch it was decoded in.
- **Quantize the value cache on every row.** The plain `gemma-4` rows and the
  non-Qwen repos stay at `f16` values: the quantized set is the one the fleet has
  measured (the `Qwen3.8` family) plus the variants trained to absorb
  quantization (QAT). A blanket `q8_0` moves a quality/VRAM line on models at
  long context with nothing behind it.
