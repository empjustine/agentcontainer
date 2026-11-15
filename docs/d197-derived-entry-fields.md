---
id: d197
type: module-design
status: active
title: "d197 — derived entry fields: GGUF facts, the projector fill, and warnings where generation used to die"
parent: llm-local-inference
depends-on: [llm-local-inference, d195]
references: [d170, d055, refresh-llm-local-inference-manifest, gguf-model-tooling, d029]
tags: ["gguf", "mmproj", "ctx-size", "generator", "drift", "automation"]
---

# d197 — derived entry fields

This record is the account of removing four hand-maintained fields from
`lib/llamacpp-model-data.json` and of the two places generation changed its
answer from "die" to "warn". It carries what the table still owns, what the
committed artifacts now own, and the probes that exercised each new rule. It is
not a schema reference — `refresh-llm-local-inference-manifest.md` owns the
entry contract, `gguf-model-tooling.md` the tool surface.

## Problem

The table carried four fields that were never table facts:

- `mmproj` — a REPO capability stored per quant. It drifted immediately: 135
  entries live in the 18 repos that ship a projector, only 61 carried the key
  (`gemma-4-12b` 2 of 21 entries, `gemma-4-E2B`/`E4B` 2 of 21,
  `gemma-4-26B-A4B` 5 of 21, `LFM2.5-VL-3B` 1 of 2), so the same model was
  multimodal at `Q8_0` and text-only at `Q4_K_M` with nothing recording why.
- `ctx-native` — a GGUF header fact, hand-copied into 17 of 175 entries.
- `ctx-size` — 139 hand-written windows, 98 of them restating the 65536
  default and all of them a guess at what the header already said.
- `cache-type-*` and `parallel` stay, but their defaulting was undocumented as
  policy.

Two generator behaviours then turned those drifts into operational cost:
`bakeSnapshotPaths` FAILED the whole run when the host cache lacked one
entry's snapshot (a host that has not pulled yet could not generate at all),
and a duplicate derived model id was `logWarn` + `continue` — one model
silently vanished from the catalog and the committed layer stopped being a
function of the table.

## Decision

**Header facts live in a generated artifact.** `lib/gguf-facts.json` is written
by `gguf_context_length.py --facts` from the GGUF headers of exactly the files
the table serves, pruned to those repos, normalized (sorted keys, integers, no
timestamp) so a refresh re-writes the same bytes and the diff shows only facts
that moved. A repo whose served files disagree drops to a per-file map. It is
committed, and nothing else may write it.

**The served context is the header's, capped.** `ctx-size` is now an optional
ceiling: the window is `min(header context_length, 262144)`, a written value
can only lower it, and a value above the header is clamped with a warning. This
is the fleet's stated pivot — correct behaviour (the widest honest window) over
fast execution — so the small-model-only raise and the 65536 default are gone.
`--fit on` in the launcher still reconciles a host too small for the window.

**The projector comes from the manifest.** `repoMmproj` picks the repo's
`mmproj-*.gguf` by quant priority `bf16 > f16 > f32 > q8_0`; an entry with no
`mmproj` key inherits it, an entry that names a different file keeps it and
warns ("not this repo's BF16 pick — valid override"), and the image-token pair
is inherited from the repo's declared budget so a filled entry does not silently
fall back to 1024 where its family says 1120. The key survives only as an
override.

**Declared files are validated, missing cache is not fatal.** Every declared
path (`model` and all shards, `mmproj`, `model-draft`) must exist in the
committed hf-manifest — a miss throws, because the manifest is committed truth
and a miss is a typo, not a host state. A snapshot the cache does not carry
only warns: paths bake against `refs/main`, else the manifest's resolved
commit, and the miss surfaces as llama-server's 127 at swap time, which run.py
already documents.

**A duplicate model id throws.** Two entries claiming one serving slot is an
operator decision, not a log line.

## Consequences

The table lost 218 lines and four fields; what remains per entry is
`hf-repo`, `model`, `__argv`, and the deliberate deviations (`parallel` 96
rows, `image-*-tokens` 60, `model-draft` 20, `cache-type-*` 33). The three
committed inputs — hf-manifests, `lib/gguf-facts.json`, `llama-swap-core.json`
— now decide everything a machine can decide.

The generated layer moved from 276 to 357 models: vision-capable quants 59 → 130
(all 18 projector repos, d195's 12B ceiling applied), `2mmproj` 69, `plain` 28,
and every served window sits at its header value (128000 ×8, 131072 ×155,
262144 ×194 — no more 65536). No existing model's projector changed: the fill
reproduces what the 61 hand-written keys named.

Callers see the id churn: 116 ids disappear (the plain text-only variants of
vision-repo quants that now fan out, plus the 45 `2mmproj` rows d195 retired)
and 197 appear, so anything pinned to `unsloth/gemma-4-12b-it-GGUF:Q6_K` must
move to `0text-unsloth/gemma-4-12b-it-GGUF:Q6_K` or one of its siblings.

`lib/gguf-facts.json`'s sweep reads every served GGUF's header, which is slow
(minutes to tens of minutes over a full cache) — it is a manual refresh step
next to `download_models.py`, not part of generation.

## Alternatives rejected

- **Keep `ctx-native` in the table with the artifact as a cross-check.** Two
  homes for one header fact; the drift is exactly what the artifact removes.
- **Fail generation on a missing facts entry.** It would block adding a model
  before the sweep runs. The fallback context warns instead, and the warning is
  in the run log the operator already reads.
- **Auto-writing the table from the cache** (`scan_cache_for_manifest.py`
  already emits entries). d053's R5 stands: the cache cannot supply the
  judgement fields, and a half-written entry is worse than none.

## Files touched

- `llm-local-inference/generate.mjs` — `repoManifest`, `repoMmproj`,
  `resolveEntryFiles`, `indexImageTokens`, `factsCtxNative`, `CTX_CAP`/
  `CTX_FALLBACK`, the warn-not-fail bake, the throwing duplicate-id check.
- `llm-local-inference/gguf_context_length.py` — `--facts` and its pruned,
  normalized writer.
- `llm-local-inference/lib/gguf-facts.json` — new, generated, committed.
- `llm-local-inference/lib/llamacpp-model-data.json` — the four fields removed.
- `llm-local-inference/config.d/10-local-llm-inference.yaml` — regenerated.
- `llm-local-inference/refresh-llm-local-inference-manifest.md`,
  `llm-local-inference/gguf-model-tooling.md` — entry contract and tool table.

## Verification

Probes run against a scratch copy of the table, one per rule, then reverted:

- an entry naming `mmproj-F16.gguf` while its repo ships BF16 — warned
  (`declared: mmproj-F16.gguf, preferred: mmproj-BF16.gguf`) and the F16 file
  stayed in the cmd;
- an entry pinning `ctx-size: 999999` on a 131072-native model — warned and
  clamped to 131072;
- an entry naming `mmproj-NOPE.gguf` — threw, naming the file and the repo;
- a duplicated `repo:quant` — threw with the colliding id;
- a normal run — no warning, `config.d` byte-identical across two runs.
