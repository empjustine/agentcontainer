---
id: d238
type: module-design
status: active
title: "d238 — the local llama-swap farm is a first-class serving unit again (d108's pause reversed for the local half)"
parent: llm-local-inference
depends-on: [d108, d210, d232]
references: [d029, d197, d212, d220, d224]
tags: [serving, llama-swap, local-inference, deprecation]
---

# d238 — the local llama-swap farm is live work again

## Context

d108 moved the serving edge to tunnel-only and paused the bazzite llama-swap
provider "for now" as part of it: no new clients, no new features, the code
kept and the existing generation still working. It also said the pause is
reversed by a new record, not by an edit to d108 — this is that record.

The two halves of d108 landed differently, which is why the pause is lifted
for one of them and not the other:

- **The tunnel half landed and works.** The allowlist reverse proxy (mode A)
  is deprecated as insecure and deleted; estige's tunnel transports carry cloud
  traffic. Nothing here touches that, and this record does not re-arm a
  trusted TLS-terminating proxy.
- **The local half never stopped being the only place this operator runs GGUF
  inference.** The gateway `tlalocayotl.coelacanth-barb.ts.net/v1` is that
  farm, the fleet's generated client layer still names it as the
  `llama-swap` provider, and `../pi-tlalocayotl-provider/` now binds it with a
  live `/v1/models` refresh. A unit with a deployed consumer, a maintained
  catalog and a pi package in front of it is not a paused shape.

## Decision

`llm-local-inference/` is `active` again. Its `DESIGN.md` drops the deprecation
banner and points here; `docs/architecture.md`, `docs/requirements.md` and
`docs/environments-and-variants.md` lose the "deprecated for now" qualifier and
keep the tunnel-only statements d108 made about the edge.

What came in with the reversal, because each is a fact a later reader would
otherwise have to reconstruct from a diff:

- **Two ISTA-DASLab Coder uploads are served.** `DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder`
  (`IQ2_XXS`, 65 536 context) and `Qwen3.8-Flash-Next-GSQ-RCO-Coder`
  (`IQ1_M`, 65 536) move from `audit-only` to `served` in
  `lib/cache-scope.json` and join the table. Their ids carry no `:quant`
  label: each repo serves exactly one row here, and d210 drops the label where
  no choice exists. The label still names the file, in `model` and in the baked
  `--model` path.
- **The n-gram/Engram table is a sidecar, not a second quantization.** The
  DeepSeek Coder publishes its lookup table as
  `DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf` — shard 6 of the release, carrying a
  quant tag it never selects. A name-only reader therefore reported two quants
  in a repo that has one, which is how a `:quant` label survives a repo that
  must not have one, and how the authoring aid would propose an `:IQ4_NL`
  entry that does not exist. The classifier now excludes the family in all
  three of its homes — `lib/model-entries.mjs` (`isSidecarFile`, which
  `mainGgufSizes` and the proposal aid read), `_hf_cache.py`
  (`is_model_file`, the two cache scanners) and
  `10-fetch-hf-manifests.py` (`SIDECAR_RE`, tag resolution) — and each home
  carries the reason.
- **One trailing shard may be an Engram file.** `DeepSeek-V4.1-Flash-1017-GSQ-RCO-Coder`
  ships five backbone shards plus its lookup tables under another name
  (`DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf`, the unpruned release's shard 6).
  `30-generate.mjs` now resolves exactly ONE missing trailing shard from the
  committed manifest's single Engram GGUF and warns when it does; any other
  miss stays a hard error (d197's rule: the manifest is committed truth). The
  emitted `--shard` is the comma list of the paths actually served (d210), so
  no symlink or per-entry alias encoding is involved.
- **`--lazy-mode on`, not `auto`.** Both Coder rows keep their lookup table in
  a separate shard that has to stay memory-mapped, which is what the vendor
  cards state ("read one row per token", "may stay on disk"); the flag is
  recorded in d210's amendment, together with why the behaviour no longer
  rides a size heuristic.
- **A `dsv41` sampling macro** (`--temp 1.0 --top-p 1.0 --min-p 0.0` plus
  `chat_template_kwargs {"reasoning_effort": 50}`), the family the new
  DeepSeek Coder row names alongside `${SPEC_MTP}`.

## Verification

`node --test llm-local-inference/tests/*.test.mjs` — 32 passing, including the
committed-catalog cases that regenerate the layer from the committed table and
manifests with an empty hub (so the result is a function of committed bytes,
not of this host). The committed `config.d/` and `lib/curated/` artifacts were
regenerated the same way, and the diff against the previous tree is exactly the
two new rows plus the macro change.

Not claimed: a live request against the two new rows from this host. They are
served by the GPU box, and the model-card measurements are the vendor's.

## Alternatives rejected

- **Edit d108 instead of writing this record.** d108 says reversing the pause
  is a new record; a record that rewrites its own decisions cannot be read as
  history.
- **Restore the label on the two new ids** to keep the `repo:quant` spelling a
  caller might expect. d210's rule is derived from the catalog, not from a
  preference: a single-row repo drops the suffix, and the committed-catalog
  test would fail on the mixed spelling.
- **Revert the `--lazy-mode` change to keep the old pin.** The pin was never
  the requirement — the requirement is that the lookup table stays on disk for
  the served rows, and `on` is what the vendor documents for exactly that.
