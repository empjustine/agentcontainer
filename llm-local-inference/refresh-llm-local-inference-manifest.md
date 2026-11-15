---
id: refresh-llm-local-inference-manifest
type: module-design
status: active
title: "Refreshing the GGUF model manifest — runbook"
parent: llm-local-inference-cache
tags: ["reference", "runbook", "manifest"]
---

# Refreshing `llm-local-inference/lib/llamacpp-model-data.json`

This is the operational runbook for keeping the GGUF model manifest in sync
with the Hugging Face cache. Run it whenever a new GGUF model or a new quant of
an existing repo lands in the cache (e.g. a background `upkeep.py pull` or a
manual `snapshot_download` finished).

The manifest is the single source of truth for the local GGUF layer
(`llm-local-inference/config.d/10-local-llm-inference.yaml` — the serving
folder was renamed/consolidated since this runbook was first written; the
flow is unchanged):

```
llamacpp-model-data.json  --(generate.mjs)-->  config.d/10-local-llm-inference.yaml
llama-swap-core.json      --(generate.mjs)----------->  config.d/00-general.yaml   (globals + sampling macros)
lib/hf-manifests/*.json   --(generate.mjs, param count + quant display)-->  which quants the layer shows
```

No part of this needs Infisical or the network — the generator reads local
files only, offline (the former `generate.sh` infisical wrapper is long gone).

## Schema (one manifest entry)

| Key                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hf-repo`                       | `org/repo:quant` — `quant` is the **trailing filename token** of the GGUF (see naming rules below)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `model`                         | exact cached GGUF filename. For sharded files, the `00001-of-NNNNN` shard (llama.cpp resolves the prefix)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `mmproj`                        | **override only.** Omit it: the generator takes the projector from the committed hf-manifest (BF16 first, then F16, d197), so vision capability is a repo fact, not a per-entry one. A written value must exist in the manifest; F16/Q8_0 while the repo ships BF16 warns but is honoured. Fills the mode set, gated from both ends (d195, d200): `1vision` always; `2mmproj` only while the weights stay under 75% of the fleet card; `0text` only once they are over 25% — below that the projector fits anyway, so the no-projector mode buys nothing |
| `model-draft`                   | optional MTP/drafter sidecar GGUF (unsloth ships these under the repo's `MTP/` subdir — the subdir prefix is part of the filename); must live in the SAME snapshot as `model`. Requires `--spec-type` at launch, which the generator emits (`draft-mtp` by default) — a bare `--model-draft` on a local-path model enables no speculative impl and just wastes VRAM                                                                                                                                                                                      |
| `cache-type-k` / `cache-type-v` | KV-cache quant; optional, **default `f16`/`f16`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ctx-size`                      | **optional ceiling**, never a target: the generator serves the GGUF header's `context_length` (from `lib/gguf-facts.json`, capped at 262144, d197). A written value lowers it; a value above the header is clamped with a warning                                                                                                                                                                                                                                                                                                                        |
| `parallel`                      | `1` or `2`; optional, **default `1`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `__argv`                        | family sampling macro ${…} (see Step 3), or omit when the family has no macro                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Keys with an implicit default are filled in by `generate.mjs`
(`DEFAULTS` map) — omit them unless the entry deviates, e.g. `parallel: 2` or a
cap other than `65536`.
The file is a flat `{ "models": [ … ] }` array. **The last element has no
trailing comma** — append before the closing `]`/`}` and add a comma to the
previous last element.

## Step 1 — Discover what changed in the cache

Run the coverage scanner, which diffs the cache against the manifest by
filename only — no GGUF headers are read and no weights are loaded:

```sh
./py-run.sh llm-local-inference/scan_cache_coverage.py
```

It prints three sections: repos with zero manifest coverage, listed repos with
extra cached quants, and ambiguous `bpw`/multi-quant filenames. The deeper
audit of each served entry against llama.cpp's implicit `repo:quant -> file`
heuristic is `fetch_hf_manifests.py` (Step 5).

## Step 2 — Gather the fields for each new entry

- **`hf-repo`** = `org/repo:QUANT`. `QUANT` is the trailing filename token.
  Keep it **extensive / unambiguous** (see naming rules): byteshape's
  `N.NNbpw` suffix and Unsloth's `UD-` dynamic-quant prefix are part of the
  specifier, not decoration.
- **`model`** = the exact filename from Step 1 (sharded → the `00001-of-NNNNN`
  shard).
- **`mmproj`** = leave it out. The generator resolves the projector from the
  committed hf-manifest (BF16 → F16 → F32 → Q8_0) and validates every written
  filename against that manifest; a repo with no `mmproj-*.gguf` stays
  text-only automatically.
- **`cache-type-k` / `cache-type-v`**: omit (the implicit default is `f16`/`f16`); set only for a non-f16 KV cache.
- **`ctx-size`** = omit. The window is the model's native `context_length`
  read from the GGUF header into `lib/gguf-facts.json` (d197), capped at 262144. `--fit on` in the `LLAMA_SERVER` macro reconciles a host that cannot
  hold it. Write the key only to pin a LOWER window for a host-specific reason.
  The header — not a model card's "256K" claim — is what the generator serves:

  ```sh
  ./py-run.sh llm-local-inference/gguf_context_length.py --repo ORG/REPO  # one model
  ./py-run.sh llm-local-inference/gguf_context_length.py --facts          # rewrite the artifact
  ```

  `--facts` re-reads every file the table serves and is the ONLY writer of
  `lib/gguf-facts.json`; run it whenever an entry's `model` changes, then commit
  the regenerated file with the table.

- **`parallel`**: omit (the implicit default is `1`); write `2` only when VRAM allows.
- **`model-draft`** = the repo's `MTP/mtp-<model>-<QUANT>.gguf` sidecar, when it
  ships one (all unsloth gemma-4 repos do). Pick `Q8_0` when available — half
  the F16 size at negligible acceptance loss for a single MTP layer. The
  generator emits `--spec-type draft-mtp` automatically; add spec sampling
  flags (`--spec-draft-n-max …`) via `__argv`.
- **`__argv`** = the family sampling macro (next step) or omit.

## Step 3 — Edit `llamacpp-model-data.json`

Insert the new object(s) into the `models` array. Example (the LFM2.5-8B-A1B
MoE, text-only, native ctx):

```json
{
  "hf-repo": "unsloth/LFM2.5-8B-A1B-GGUF:UD-Q8_K_XL",
  "model": "LFM2.5-8B-A1B-UD-Q8_K_XL.gguf",
  "__argv": "${lfm25}"
}
```

That is the whole entry. `mmproj`, `ctx-size`, `ctx-native`, `cache-type-k`/
`cache-type-v` and `parallel` are all derived (projector and parameter count
from the hf-manifest, window from `lib/gguf-facts.json`, KV type and
parallelism from the generator defaults); write one only to deviate.

Family sampling macros live under the `macros` key of `llama-swap-core.json`
(the source of truth) and are emitted into `config.d/00-general.yaml` by
`generate.mjs`. Current families include `qwen38`, `qwen36`,
`glm47f`, `gemma4`, `devstral`, `ling`, `lfm25`, plus the base `LLAMA_SERVER`
launcher (check `llama-swap-core.json` for the live list). To add/change a
macro, edit `llama-swap-core.json` and re-run generation.

## Step 4 — Regenerate `config.d/`

```sh
cd llm-local-inference
LOCAL_INFERENCE=1 ./node-run.sh llm-local-inference/generate.mjs   # -> both config.d/ layers (00-general + 10-local-llm-inference)
```

Generation runs offline (no Infisical, no network). It FAILS on a **duplicate
model id** (two entries claiming one serving slot) and on a **declared file the
manifest does not carry** — both are table bugs, not host state. It WARNS, and
still emits a complete config, when the host cache lacks an entry's snapshot
(a host that has not pulled yet must generate) and when an entry overrides the
repo's BF16 projector with an F16 one. Model ids are
`[<mmprojMode>-]<hf-repo>` — no slug prefixes (active-b and ctx, both retired by d170); quant display is pruned by the
generator from the committed hf-manifests, in shares of the 16 GiB fleet card
(d199): BF16/F16 hidden where a full-precision copy would claim >50% of it, up to
three cheapest quants dropped where the served weights claim <25% (never below
three rows, d200), `2mmproj` only up to 75% (d195) and `0text` only above 25%
(d200). A brand-new quant may therefore not appear in the
layer if the manifest still lists only cheap quants for its repo.

## Step 5 — Validate

```sh
node -e "require('./llm-local-inference/lib/llamacpp-model-data.json')"   # parses? (no output = ok)

git diff --exit-code llm-local-inference/lib/llamacpp-model-data.json    # you edited it by hand; the diff IS the change

# coverage: re-run the Step 1 scanner and confirm
#   - every cached repo has >=1 manifest entry (no repo left at zero coverage)
#   - no listed repo has a cached .gguf whose quant is absent from the manifest

# the header facts must cover every served file: re-run the writer after any
# `model` change, then commit lib/gguf-facts.json with the table (d197)
./py-run.sh llm-local-inference/gguf_context_length.py --facts

# --offline audits each entry's model against llama.cpp's implicit
# repo:quant -> file heuristic, with no network (exit 1 on mismatch)
./py-run.sh llm-local-inference/fetch_hf_manifests.py --offline
```

`fetch_hf_manifests.py` re-implements `find_best_model` offline and checks the
`:quant` label against the configured `model` filename. The tag is a label, not
a lookup key: the generator bakes `--model` from the HF cache and
`download_models.py` fetches the filename in `model`, so llama.cpp never
resolves the tag for these entries. The audit fails on two things — a tag whose
heuristic pick is a different file (a mislabelled entry, or an ambiguous one
like two `Q4_K_S` quants at different bpw), and a configured file absent from
the repo's current tree. A repo whose full-precision upload carries no tag at
all prints `label-only` and passes (`XHToken` ships `Spark-X2.6-1.7B.gguf`; no
tag selects it, the baked path serves it).

The replica carries upstream's token boundary (`common/download.cpp`, #31620):
a tag starts at `^`, `-`, `.` or `/`, so `:F16` cannot select a `BF16` file. `_`
is not a boundary — upstream added and reverted it (#31639). A replica missing
the boundary reports a correct entry as a mismatch, which is how
`LiquidAI/LFM3-1.7B-GGUF:F16` read before it was fixed.

## Step 6 — Verify the macros against the model cards

Macro values carry no mechanical check: a deviation from the family's card
can be a deliberate override, and deciding which it is remains judgement. This
step therefore runs as an agent-or-human action. The structural half —
dangling `${…}` references, orphan macros, repeated flags inside one expanded
`__argv` — is mechanical and can become a check of its own later.

1. List the family macros under `macros` in `llama-swap-core.json`.
2. For each family macro, open the family's model card under
   `model-cards/<org>/<repo>.md` and compare the card's recommended sampling
   parameters against the macro's flags. Treat an unexplained deviation as a
   defect in one of the two, and fix the side that is wrong.
3. Check the reverse direction: every macro must have at least one entry in
   `lib/llamacpp-model-data.json` that references it through `__argv`, and
   every `${…}` in an entry must resolve in `macros`. When a family leaves the
   manifest, retire its macro and its `lib/hf-manifests/<org>--<repo>.json` in
   the same change.
4. Record each deviation you keep, with its reason, under Naming rules /
   gotchas below.

## Step 7 — Reload llama-swap

llama-swap merges `config.d/` files additively at startup. Restart the
`llm-local-inference` llama-swap service
(`./environment.sh ./py-run.sh llm-local-inference/run.py`) so the regenerated
`10-local-llm-inference.yaml` (and `00-general.yaml` if changed) is picked up.

## Naming rules / gotchas

- **Extensive quant specifiers.** byteshape files carry a bpw suffix
  (`Q4_K_S-3.80bpw`, `Q5_K_M-5.60bpw`) and Unsloth uses a `UD-` dynamic-quant
  prefix (`UD-Q8_K_XL`). Keep these in `hf-repo` — never collapse to a bare
  `Q4_K_S`. llama.cpp's cached-list display only shows the _trailing_ filename
  token (so it prints `:80BPW`, `:22BPW`, `:04BPW`); the `:quant` you put in
  `hf-repo` is what `find_best_model` matches via the `(^|[-./])TAG[.-]`
  regex, so the extensive name selects the right file (an underscore is not a
  boundary upstream — #31639).
- **Never write `mmproj` to enable vision.** Capability comes from the
  committed hf-manifest: a repo that ships `mmproj-*.gguf` fans out, one that
  does not stays text-only, and every entry of a vision repo gets the same
  projector. Write the key only to pick a NON-BF16 projector, and expect a
  warning — the fleet prefers BF16 (d197).
- **A bare full-precision upload has no tag.** `XHToken`'s Spark repos ship
  `Spark-X2.6-1.7B.gguf` with no quant in the name, so `:F16` there labels a
  file llama.cpp cannot resolve by tag. The audit prints `label-only` and the
  baked `--model` path serves it; do not "fix" it by inventing a tag.
- **`ctx-size` is a ceiling, not a target.** The generator serves the header's
  `context_length` (capped at 262144) and clamps a written value that exceeds
  it, with a warning. It never shrinks a window to fit VRAM — `--fit on` does
  that at launch, so a too-large number is a host problem, not a config lie.
- **Sharded GGUFs.** `model` points at shard `00001-of-NNNNN`; the loader
  expands the prefix.
- **Last array element has no trailing comma** in `llamacpp-model-data.json`.

## Related docs

- `gguf-model-tooling.md` — schema contract, `fetch_hf_manifests.py` reference,
  and the two PoC helpers `scan_cache_coverage.py` / `gguf_context_length.py` used above.
- `d018-split-config-d.md` — why the config is split into `00-general.yaml` /
  `10-local-llm-inference.yaml` and how llama-swap merges `config.d/`.
- `hf-cache-upkeep.md` — `upkeep.py` cache GC/pull/verify; `download_models.py`
  must use the `main` ref (not a pinned SHA) to survive pruning.
- `coding-agent/generate-pi-coding-agent.mjs` — the _coding-agent_ model
  generator and the layered `models.json` contract (separate concern; not
  this local-llm manifest). The merge contract's single home is that script's
  header; the module design lives in `coding-agent/DESIGN.md`.
