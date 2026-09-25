---
id: d053
type: task-spec
status: active
title: "d053 — model footprint data + cheapest-first `lib/llamacpp-model-data.json`"
parent: llm-local-inference
depends-on: [llm-local-inference, lib]
references: [d025, d050, gguf-model-tooling, refresh-local-llm-manifest, gguf-vram-fit-estimates]
tags: [gguf, manifest, ordering, determinism, footprint, size]
---

# d053 — model footprint data + cheapest-first `lib/llamacpp-model-data.json`

**Status: active (landed).** `llm-local-inference/model-sizes.mjs` (shim
`model-sizes.sh`) derives each entry's footprint and orders
`lib/llamacpp-model-data.json` cheapest-first; the committed table now carries
`size-gb` / `size-parts`. R4 (active-part estimate) remains a **TODO**.

## Problem

`lib/llamacpp-model-data.json` is the canonical, cross-language model table
(d025): `llm-local-inference/generate.mjs` and the (now mostly deprecated)
`local-llm/` cache tooling both read it. It carried no footprint data, and its
`models` array was ordered by a property that is not intrinsic to the model.

That order came from `local-llm/generate_vram_fit_tables.py
--update-model-data`, which sorts by **measured decode speed**. The sort is a
function of the external `gdevenyi/huggingface-estimate` checkout, a GPU preset
(`--gpu`), a VRAM budget, `--batchSize`, the mmproj placement and the ctx set —
none of which are properties of the model. Rerunning on another host or preset
produced a different order, so the committed order churned for reasons
unrelated to the catalog, and a consumer that only wanted "how big is this
model" had to re-derive it (`du`, the estimator, or the model card).

Footprint — the bytes on disk, which are also the bytes a runner must load into
RAM/VRAM — is intrinsic, cheap, and offline. It is a *rough* proxy for "how
expensive is this model to run", which is exactly the ordering signal wanted; a
speed benchmark is a much heavier, host-bound way to get the same rough
ranking.

## Decisions (resolved)

1. **Script home** — a new `.mjs` in `llm-local-inference/`
   (`model-sizes.mjs` + a `node-run.sh` shim). The table's *content* is owned
   by that folder (d025), so its writer lives there too. `local-llm/` tooling
   is deprecated; the former Python `--update-model-data` reorder is retired.
2. **Sources** — committed manifests first, local HF cache fallback.
3. **Manifest home** — moved `local-llm/hf-manifests/` → `lib/hf-manifests/`.
   `llm-local-inference/` must not reach into the `local-llm/` sibling
   (`llm-local-inference/DESIGN.md`); a genuinely shared data table belongs in
   `lib/` (the d025 precedent, mirrored). `fetch_hf_manifests.py` (the
   deprecated writer) now points at the new path.
4. **Fields / units** — `size-gb` (SI GB, decimal 1e9, fixed 3 decimals) plus
   `size-parts` (same keys, same unit). SI because the number measures
   storage/network, not RAM; a GiB field is deliberately omitted.
5. **Order** — ascending by `size-gb` (cheapest first, a *rough* estimate),
   tie-break `hf-repo` then `model`, code-unit compare.
6. **R4** — left as a TODO; not in the first cut.
7. **Cache-only** — warn-only, implemented inline in the `.mjs` (the
   deprecated `scan_cache_coverage.py` classifier is not forked).

## Requirement

### R1 — a stable, offline size script

`llm-local-inference/model-sizes.mjs` computes each entry's footprint from
**local sources only** and writes both the footprint fields and the size order
into `lib/llamacpp-model-data.json`.

- **Deterministic.** Same inputs → byte-identical output. Exact bytes are
  summed first, converted once, rounded to a fixed 3 decimals; the sort is
  total (size, then code-unit `hf-repo`/`model`); no timestamps, no locale, no
  filesystem-order dependence. Snapshot commits are walked in sorted order and
  the first occurrence of a path wins.
- **Idempotent.** A second run over unchanged inputs changes nothing
  (`--check` asserts this and exits 1 on drift).
- **Byte-shape preserving.** Tab indentation, trailing newline, record field
  order preserved; only the `models` array order and the two new keys change.
  (The two hand-inserted blank lines in the pre-d053 file are gone — the file
  is now fully generated.)
- **Loud on failure.** An entry whose files cannot be resolved is a non-zero
  exit naming every unresolved file — never a silently partial size, a dropped
  entry, or a zero.
- **Offline.** Removing the `gdevenyi/huggingface-estimate` checkout (or
  running without its mirror) does not change the output.

*"Somewhat" reproducible* is deliberate: the inputs are the committed manifests
and the local HF cache, so two hosts with different cached quants can
legitimately differ. The guarantee is *same inputs → same bytes*, plus
host-independence for every file a committed manifest lists. As of 2026-09 all
26 table repos have a committed manifest, but the `byteshape/Qwen3.8-27B-GGUF`
manifest is stale, so 5 of its `IQ*` files fall back to the cache (see
Evidence) — those 5 are the only host-dependent inputs in the run.

### R2 — the footprint metric

For every entry, `size-gb` is the SI-GB value of the sum of the on-disk sizes
of:

1. the main GGUF named by `model`, **including every shard** when the name is
   a `-NNNNN-of-MMMMM` shard (the whole model, not just the `00001` shard);
2. the `mmproj` GGUF, when the entry declares one;
3. the `model-draft` (MTP/drafter) GGUF, when the entry declares one.

`size-parts` records the per-component breakdown (keys `model`, `mmproj`,
`model-draft`, each SI GB) so a consumer can separate the always-loaded model
from the optional sidecars. Exact bytes are the internal source of truth; only
the rounded GB value is stored.

This is the **disk footprint**. Because those same bytes must be resident to
run the model, it doubles as a rough **RAM/VRAM** footprint. It is explicitly
*not* the runtime resident set: the KV cache and activation workspace are added
at serve time and remain the estimator's job (`docs/gguf-vram-fit-estimates.md`).

### R3 — ordering

The `models` array is ordered by `size-gb` **ascending** (smallest/cheapest
first), preserving the previous "cheap first" reading. Ties break
deterministically by `hf-repo`, then `model`, using a plain code-unit compare
(not `localeCompare`), so the result does not depend on host locale.

This replaced the performance-based `--update-model-data` sort. Two writers of
one file is a drift class; `model-sizes.mjs` is now the sole writer.

### R4 — active-part estimate (TODO, not implemented)

A future `active-gb`: the weight bytes read per generated token.

- **Dense model** — active = all weights.
- **MoE model** — active = non-expert weights + (expert weights ×
  `expert_used_count` / `expert_count`), matching the archived
  `estimate_active_params.py` semantics (`docs/gguf-model-tooling.md`).
- The MTP drafter and mmproj are *resident* but not part of the base per-token
  active stream unless engaged; report them separately.

Preferred source is a header-only measurement of the local GGUF (read metadata
+ tensor-info, never the weights) — deterministic and estimator-free. Lifting
the estimator's active fields from `gguf-vram-fit-estimates.data.json` is an
acceptable fallback but re-introduces the host/parameter dependence R1 removes.
The field must be named/annotated as an estimate.

### R5 — cache-only models: warn, never add

The run reports GGUFs that exist locally but have no table entry:

- (a) a whole repo cached with no entry (zero coverage);
- (b) a quant/file in a listed repo that no entry references.

Default behaviour: **warn, do not write.** Non-fatal, to stderr, exit 0. The
report is a **summary** (counts per class, with the zero-coverage repos named),
not one line per extra quant: on the 2026-09 host there are 2 zero-coverage
repos but 76 extra cached files in 5 listed repos (`unsloth/gemma-4-12b-it-GGUF`
alone carries 19 unlisted quants). Per-file detail is behind `--verbose`.

**Auto-adding is not implemented.** The table is hand-curated and owned by
`llm-local-inference/` (d025); the cache cannot supply an entry's extensive
`hf-repo:quant` tag (byteshape `N.NNbpw`, Unsloth `UD-`), the VRAM-bound
`ctx-size` cap, the family `__argv` macro, the `active-b.json` slug, `parallel`
or the KV cache type. An auto-added entry would be incomplete or would silently
pin the wrong quant — the exact failure `fetch_hf_manifests.py` exists to catch.
If an add mode is ever wanted, it should append a *stub* carrying only what the
cache can prove (`hf-repo`, `model`, `size-gb`) and **refuse** when the quant
tag is ambiguous (bpw suffix / multiple quant keywords), leaving the rest to
the human.

## Data sources and resolution order

| # | Source | Properties |
|---|---|---|
| 1 | committed `lib/hf-manifests/<org>--<repo>.json` (`files[].path` → `size`) | host-independent, stable between manifest refreshes; **can be stale** |
| 2 | local HF cache `models--org--repo/snapshots/<commit>/<file>` via `statSync` (follows blob symlinks) | exact for what the serving host will load; host-dependent (only cached quants resolve) |

Resolution: source 1 first, source 2 as fallback. An entry that resolves in
neither is a hard error (R1).

Staleness is not hypothetical: the `byteshape/Qwen3.8-27B-GGUF` manifest
(2026-09) is missing the five `IQ*` files the table references
(`IQ2_XXS-2.56bpw`, `IQ3_S-3.23bpw`, `IQ3_XS-3.01bpw`, `IQ3_XXS-2.88bpw`,
`IQ4_XS-3.84bpw`), so a manifest-only script would fail on them. The cache
fallback covers all five — these are the 5 `cache_fallbacks` the run reports.

## Edge cases (specified and handled)

- **Sharded models** — sum *all* sibling shards even when the exact `model`
  path is present in the source. An exact-match fast path that returns shard
  `00001` alone under-counts a 100+ GB model to a few MB; this was observed in
  the draft spike on `unsloth/DeepSeek-V4-Flash-0731-GGUF` and
  `unsloth/Qwen3.8-Flash-Next-GGUF`. A source only wins when it carries the
  full declared shard count, so an incomplete manifest falls through to the
  cache instead of producing a short sum.
- **Subdirectory paths** — `model`/`model-draft` may carry a subdir
  (`UD-IQ1_S/…`, `MTP/…`); join the declared path as-is, never basename it.
- **Stale manifest** — fall back to the cache; do not fail the run for a
  manifest gap the cache can fill.
- **Duplicate filenames across repos** — `gemma-4-E2B-it-qat-GGUF` and
  `gemma-4-E2B-it-qat-mobile-GGUF` ship the same `model` filename; sizes are
  keyed by repo, never by filename alone.
- **Absent sidecar** — no `mmproj`/`model-draft` contributes 0 and is not an
  error.
- **mmproj filename casing** — `mmproj-BF16.gguf` vs `mmproj-bf16.gguf`;
  resolve the exact declared filename, no case folding.
- **`hf-repo` tag** — strip the `:quant` suffix before repo lookup.

## Schema change (cross-language contract)

Adding keys to an entry is backward-compatible with both consumers: the JS
generator spreads `{ ...DEFAULTS, ...raw }` and ignores unknown keys, and the
Python tools read named keys. The contract is documented in
`docs/gguf-model-tooling.md` (the `llamacpp-model-data.json` key table) — both
new rows live there. Field names follow the existing kebab-case. A size change
is a one-file regeneration, never a hand edit.

## Usage

```sh
./llm-local-inference/model-sizes.sh            # rewrite the table
./llm-local-inference/model-sizes.sh --check    # exit 1 if a rerun would differ
./llm-local-inference/model-sizes.sh --verbose  # list cache-only files
DRY_RUN=1 ./llm-local-inference/model-sizes.sh  # preview, do not replace
```

## Acceptance criteria (met)

- All 77 entries carry `size-gb` (and `size-parts` where sidecars exist).
- Two consecutive runs produce a byte-identical `lib/llamacpp-model-data.json`;
  `--check` passes on the committed file.
- The array is ascending by `size-gb`; as of the 2026-09 cache the smallest is
  `LiquidAI/LFM2.5-2.6B-GGUF:Q4_0` (1.594 GB) and the largest is
  `unsloth/DeepSeek-V4-Flash-0731-GGUF:UD-Q8_K_XL` (161.87 GB, 5 shards).
- Removing the estimator checkout does not change the output.
- `llm-local-inference/generate.sh` still emits `config.d/` unchanged apart
  from the model order (llama-swap does not treat model-map order as
  meaningful); verified with `DRY_RUN=1 LOCAL_INFERENCE=1`.

## Evidence (2026-09)

A resolution pass over all 77 entries (manifest-first, cache fallback,
shard-prefix summation) resolved every entry with no misses; the
shard-exact-match bug and the stale `byteshape/Qwen3.8-27B-GGUF` manifest were
both found this way. The table's 26 repos all have a committed
`lib/hf-manifests/*.json`; the cache carries 28 repos with model GGUFs, of
which 2 have zero table coverage and 76 individual cached files are absent from
the table (R5's motivating data).

## References

- `lib/llamacpp-model-data.json` — the table this changes.
- `llm-local-inference/model-sizes.mjs` / `model-sizes.sh` — the landed script.
- `local-llm/generate_vram_fit_tables.py` — the retired `--update-model-data`
  performance reorder.
- `local-llm/fetch_hf_manifests.py` — the (deprecated) manifest writer, now
  targeting `lib/hf-manifests/`.
- `docs/gguf-model-tooling.md` — schema contract, tool inventory, and the
  archived `estimate_active_params.py` (R4's semantics).
- `docs/refresh-local-llm-manifest.md` — the add-a-model runbook (now calls
  `model-sizes.sh`).
- `docs/gguf-vram-fit-estimates.md` — the estimator's KV/activation/active
  numbers (what this footprint deliberately is *not*).
- `docs/d025-shared-model-data-to-lib.md` — table ownership and the
  shared-vs-runner boundary (the manifest move follows it).
- `docs/d050-deterministic-generated-artifacts.md` — the repo's stable-output
  contract this script follows.
- `llm-local-inference/DESIGN.md` — the boundary that forced the manifest move.
