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
llamacpp-model-data.json  --(30-generate.mjs)-->  config.d/10-local-llm-inference.yaml
llama-swap-core.json      --(30-generate.mjs)----------->  config.d/00-general.yaml   (globals + sampling macros)
lib/hf-manifests/*.json   --(30-generate.mjs, param count + quant display)-->  which quants the layer shows
```

No part of this needs Infisical or the network — the generator reads local
files only, offline (the former `generate.sh` infisical wrapper is long gone).

## Schema (one manifest entry)

| Key            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hf-repo`      | `org/repo:quant` — `quant` is the **trailing filename token** of the GGUF (see naming rules below). A repo whose manifest holds exactly ONE entry drops the `:quant`: nothing can be selected there, and the model id loses the suffix with it (d210). Entries of a multi-quant repo keep theirs — it names which file the entry serves                                                                                                                                                                                            |
| `model`        | exact cached GGUF filename. For sharded files, the `00001-of-NNNNN` shard (llama.cpp resolves the prefix)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `mmproj`       | **override only.** Omit it: the generator takes the projector from the committed hf-manifest (BF16 first, then F16, d197), so vision capability is a repo fact, not a per-entry one. A written value must exist in the manifest; F16/Q8_0 while the repo ships BF16 warns but is honoured. Decides the ONE mode the row serves (d220): a repo that ships a projector serves `1vision` (`--mmproj` plus the image modality), one that ships none serves `0text` (`--no-mmproj`). The mode is a repo fact, so no size rule places it |
| `model-draft`  | optional drafter sidecar GGUF (unsloth ships MTP ones under the repo's `MTP/` subdir — the subdir prefix is part of the filename); must live in the SAME snapshot as `model`. Requires `--spec-type` at launch, which the generator emits — `draft-mtp` unless the entry sets `spec-type` — because a bare `--model-draft` on a local-path model enables no speculative impl and just wastes VRAM                                                                                                                                  |
| `spec-type`    | optional; the speculative decoding kind this entry requests, default `draft-mtp`. Write `draft-dflash` for a dflash sidecar: llama.cpp refuses a type that disagrees with the drafter's head. An entry with built-in nextn heads sets `draft-mtp` and passes NO `model-draft` — llama.cpp then drafts against a second context of the target (d206)                                                                                                                                                                                |
| `cache-type-v` | value-cache quant; optional, **default `f16`**. There is no `cache-type-k`: the key cache stays at llama.cpp's `f16` default for every entry, because quantizing keys is the half of the KV trade that moves KLD (d206). An entry that quantizes values quantizes the drafter's cache with it (the generator emits `--spec-draft-type-v` from the same key)                                                                                                                                                                        |
| `ctx-size`     | **optional ceiling**, never a target: the generator serves the GGUF header's `context_length` (from `lib/gguf-facts.json`, capped at 262144, d197). A written value lowers it; a value above the header is clamped with a warning                                                                                                                                                                                                                                                                                                  |
| `parallel`     | **not a per-entry key.** Every entry serves one slot: the generator emits `--parallel 1` from its `DEFAULTS`, because llama.cpp's own default is `-1` (auto) and the fleet wants one deterministic slot per model. An entry that writes one is drift                                                                                                                                                                                                                                                                               |
| `__argv`       | family sampling macro ${…} (see Step 3), or omit when the family has no macro                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Keys with an implicit default are filled in by `30-generate.mjs`
(`DEFAULTS` map) — omit them unless the entry deviates, e.g. a window cap other
than `65536` or a projector the repo does not prefer.
The file is a flat `{ "models": [ … ] }` array. **The last element has no
trailing comma** — append before the closing `]`/`}` and add a comma to the
previous last element.

## Step 0 — the repository → model manifest step

This is the one flow that turns a repo into model-manifest entries. A repo in
cache scope with no model entry (an `audit-only` line in
`lib/cache-scope.json`) already has a committed `lib/hf-manifests/` file,
so its entries can be derived instead of typed:

    ./node-run.sh llm-local-inference/20-propose-entries.mjs

The output is a `{"models": [...]}` fragment — one entry per servable
quant, the filename an entry must write (shard 1), tab-indented like the
manifest — for review and paste. Nothing writes the manifest for you: a
promotion is a decision (which quant, which window, which macro), so the tool
stops at the fragment.

The `:quant` label is the one field only a human supplies;
`10-fetch-hf-manifests.py --print-plan` audits it afterwards. The scope line is
bookkeeping: the model manifest is authoritative, so a stale `audit-only`
line only warns (docs/d212).

## Step 1 — Discover what changed in the cache

Run the coverage scanner, which diffs the cache against the manifest by
filename only — no GGUF headers are read and no weights are loaded:

```sh
uv run --script llm-local-inference/scan_cache_coverage.py
```

It prints three sections: repos with zero manifest coverage, listed repos with
extra cached quants, and ambiguous `bpw`/multi-quant filenames. The deeper
audit of each served entry against llama.cpp's implicit `repo:quant -> file`
heuristic is `10-fetch-hf-manifests.py` (Step 5).

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
- **`cache-type-v`**: omit (the implicit default is `f16`); set it to `q8_0` only for the models measured to tolerate it — today the `Qwen3.8`-family rows and the `gemma-4` **QAT** variants, never the plain `gemma-4` rows — and expect the drafter's cache to follow in the same flag stream. Keys are not a knob: no entry can quantize them (KLD).
- **`ctx-size`** = omit. The window is the model's native `context_length`
  read from the GGUF header into `lib/gguf-facts.json` (d197), capped at 262144. `--fit on` in the `LLAMA_SERVER` macro reconciles a host that cannot
  hold it. Write the key only to pin a LOWER window for a host-specific reason.
  The header — not a model card's "256K" claim — is what the generator serves:

  ```sh
  uv run --script llm-local-inference/gguf_context_length.py --repo ORG/REPO  # one model
  uv run --script llm-local-inference/gguf_context_length.py --facts          # rewrite the artifact
  ```

  `--facts` re-reads every file the model manifest serves and is the ONLY writer of
  `lib/gguf-facts.json`; run it whenever an entry's `model` changes, then commit
  the regenerated file with the model manifest.

- **`parallel`**: never write it. The fleet serves one slot per model — a second
  slot spends the KV cache to buy concurrency the catalog does not need, and
  llama.cpp's own default is `-1` (auto), so the generator emits `--parallel 1`
  from `DEFAULTS` for every entry. The same rule as `cache-type-v: f16`: the
  table carries a key only when it deviates, and nothing deviates here.
- **`model-draft`** = the repo's drafter sidecar, when it ships one (every
  unsloth gemma-4 repo ships `MTP/mtp-<model>-<QUANT>.gguf`;
  `unsloth/Qwen3.8-27B-GGUF` ships only `MTP/mtp-Qwen3.8-27B-Q4_0.gguf`;
  `JetBrains/Qwen3.8-3.6-27B-blend-GGUF` ships the dflash pair). Choose the
  highest precision the repo publishes (BF16 → F16 → Q8_0 → Q4_0) and stop where
  the target would leave the GPU: a drafter's precision is its acceptance rate,
  so `Q8_0` is a last resort, not a default.
- **Each span shape has its macro.** `${SPEC_MTP}` / `${SPEC_DFLASH}` in
  `llama-swap-core.json` split the ceiling by how a drafter emits tokens: MTP
  emits one token at a time, so its ceiling is 16; dflash emits a whole BLOCK per
  forward pass, and the ceiling IS that block — `--spec-draft-n-max 3` for four
  tokens, because a longer block costs a full pass whether or not the confidence
  head fills it.
- **The drafter is confidence-gated, not window-gated.** Both macros carry
  `--spec-draft-p-min 0.8`: the drafter keeps emitting tokens while its own
  next-token probability stays at or above `p-min` and stops as soon as it falls
  below, so the span follows the model's certainty and `--spec-draft-n-max` is
  only a ceiling over it (llama.cpp's default is 3, which would cap an MTP span at
  three tokens). A smaller `--spec-draft-n-max` in `__argv` buys nothing and
  defeats the rule; a ceiling set at the ~9-token spans the fleet sees truncates
  the rare confident run and saves nothing. `p-min` is a greedy-path threshold
  (llama.cpp warns if combined with `--spec-draft-sampling probabilistic`), and it
  caps throughput, never quality: drafted tokens are verified against the target.
- **Three routes, and the type is the entry's.** A sidecar entry takes `draft-mtp` by
  default and `draft-dflash`/its own kind otherwise (llama.cpp refuses a type
  that disagrees with the drafter's head). A row whose model carries nextn heads
  needs no sidecar at all: `spec-type: draft-mtp` alone makes llama.cpp draft
  against a second context of the target. A DSpark sidecar uses `p-min` as its
  confidence-head cutoff and refuses `p-min > 0` without a head, so it needs its
  own type and, absent a head, `p-min 0` (d206).
- **`__argv`** = the family sampling macro (next step) or omit.

## Step 3 — paste the entries (the promotion's human half)

Insert the new object(s) into the `models` array. Example (the LFM2.5-8B-A1B
MoE, text-only, native ctx, and the repo's only row):

```json
{
  "hf-repo": "unsloth/LFM2.5-8B-A1B-GGUF",
  "model": "LFM2.5-8B-A1B-UD-Q8_K_XL.gguf",
  "__argv": "${lfm25}"
}
```

That is the whole entry. Drop the `:quant` `20-propose-entries.mjs` hands you
when the entry is the repo's only row: the label exists only where it selects
something, and the served id loses the suffix with it (d210). `mmproj`, `ctx-size`, `ctx-native`, `cache-type-v`
and `parallel` are all derived (projector and parameter count
from the hf-manifest, window from `lib/gguf-facts.json`, KV type and
parallelism from the generator defaults); write one only to deviate.

Family sampling macros live under the `macros` key of `llama-swap-core.json`
(the source of truth) and are emitted into `config.d/00-general.yaml` by
`30-generate.mjs`. Current families include `qwen38`, `qwen36`,
`glm47f`, `gemma4`, `devstral`, `ling`, `lfm25`, plus the base `LLAMA_SERVER`
launcher (check `llama-swap-core.json` for the live list). To add/change a
macro, edit `llama-swap-core.json` and re-run generation.

The `LLAMA_SERVER` launcher spells out every default the fleet depends on:
`--log-jsonl` with `--no-log-timestamps` (structured lines; the relay adds its
own timestamps), `--lazy-mode auto` (on-demand reading of per-layer tensors over
4 GiB, which needs the `--load-mode mmap` the macro pins), `--load-mode mmap`,
`--kv-unified`, `--cache-ram 8192`, `--flash-attn on`, `--fit on --fit-target
1024`, `--no-context-shift` and `--reasoning-preserve`. A flag whose value is
the server's default is written down on purpose: a build that changes the
default then shows up as a behaviour change to review, not a silent shift
(d210).

## Step 4 — curate: curated manifests + config.d

```sh
cd llm-local-inference
LOCAL_INFERENCE=1 ./node-run.sh llm-local-inference/30-generate.mjs   # -> both config.d/ layers (00-general + 10-local-llm-inference)
```

Generation runs offline (no Infisical, no network). It FAILS on a **duplicate
model id** (two entries claiming one serving slot) and on a **declared file the
manifest does not carry** — both are table bugs, not host state — and with
**exit 95 when the HF hub root itself is not visible** (absent, not a directory,
or unreadable): an invisible cache cannot verify a single baked path, and that
is a mount/configuration fault rather than a host that has not pulled yet
(d207). It WARNS, and still emits a complete config, when the hub exists but
lacks an entry's snapshot (a host that has not pulled yet must generate) and when
an entry overrides the repo's BF16 projector with an F16 one. The quant-display
decisions (a hidden full-precision row, a dropped cheap quant, an unsizable repo)
log at INFO, so a healthy run leaves the WARN band empty and
`jq 'select(.severityNumber >= 13)'` is a signal (d208). Failure artefacts
INSIDE a visible hub — a half-pulled snapshot, an `.incomplete` blob, a lock left
by a killed download — are the operator's to prune: generation does not classify
them, it only reports the entries whose bake cannot resolve. Model ids are the manifest key — `repo` or `repo:quant`, no mode segment and no
slug prefixes (d220; active-b and ctx retired by d170), so an id names its cache
directory exactly. Quant display is pruned by the generator from the committed
hf-manifests, in shares of the 16 GiB fleet card (d199): BF16/F16/F32 hidden
where the row would claim >50% of it (never the last row a repo publishes,
d202), and up to three cheapest quants dropped where the served weights claim
<25% (never below three rows, d200). A brand-new quant may therefore not appear
in the layer if the manifest still lists only cheap quants for its repo.

## Step 5 — Validate

```sh
node -e "require('./llm-local-inference/lib/llamacpp-model-data.json')"   # parses? (no output = ok)

git diff --exit-code llm-local-inference/lib/llamacpp-model-data.json    # you edited it by hand; the diff IS the change

# coverage: re-run the Step 1 scanner and confirm
#   - every cached repo has >=1 manifest entry (no repo left at zero coverage)
#   - no listed repo has a cached .gguf whose quant is absent from the manifest

# the header facts must cover every served file: re-run the writer after any
# `model` change, then commit lib/gguf-facts.json with the model manifest (d197)
uv run --script llm-local-inference/gguf_context_length.py --facts

# --offline audits each entry's model against llama.cpp's implicit
# repo:quant -> file heuristic, with no network (exit 1 on mismatch)
uv run --script llm-local-inference/10-fetch-hf-manifests.py --offline
```

`10-fetch-hf-manifests.py` re-implements `find_best_model` offline and checks the
`:quant` label against the configured `model` filename. The tag is a label, not
a lookup key: the generator bakes `--model` from the HF cache and
`40-download-models.py` fetches the filename in `model`, so llama.cpp never
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
(`./environment.sh uv run --script llm-local-inference/run.py`) so the regenerated
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

- `gguf-model-tooling.md` — schema contract, `10-fetch-hf-manifests.py` reference,
  and the two PoC helpers `scan_cache_coverage.py` / `gguf_context_length.py` used above.
- `d018-split-config-d.md` — why the config is split into `00-general.yaml` /
  `10-local-llm-inference.yaml` and how llama-swap merges `config.d/`.
- `hf-cache-upkeep.md` — `upkeep.py` cache GC/pull/verify; `40-download-models.py`
  must use the `main` ref (not a pinned SHA) to survive pruning.
- `coding-agent/generate-pi-coding-agent.mjs` — the _coding-agent_ model
  generator and the layered `models.json` contract (separate concern; not
  this local-llm manifest). The merge contract's single home is that script's
  header; the module design lives in `coding-agent/DESIGN.md`.
