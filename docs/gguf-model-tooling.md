# GGUF model tooling (PARTIALLY ARCHIVED)

> **Status:** the size-estimation tools — `generate_layer_cards.py`,
> `estimate_active_params.py`, `fit_analysis.py` — are **archived** to
> [`OLD/gguf-size-estimation/`](../OLD/gguf-size-estimation/) and no longer
> maintained. Their replacement is
> [`gdevenyi/huggingface-estimate`](https://github.com/gdevenyi/huggingface-estimate)
> (`run-calc.js`), which models per-layer `n_head_kv`, SWA windows, recurrent
> state, MTP heads and MoE hybrid fits that the archived tools never handled.
> The estimator is invoked by `local-llm/generate_vram_fit_tables.py`, which
> regenerates [`gguf-vram-fit-estimates.md`](gguf-vram-fit-estimates.md) and its
> raw-data JSON. Point it at a checkout via `--estimator-dir` or
> `$HUGGINGFACE_ESTIMATE_DIR` (a read-only checkout is copied and `npm install`
>ed automatically).
>
> Only `fetch_hf_manifests.py` remains live in `local-llm/`. The sections below
> are kept for reference on the archived tools.

This repository contains tools for working with GGUF model files for local
llama.cpp inference. They share two design constraints:

1. **They read only the GGUF header (metadata scalars + tensor-info section)
   and never load tensor weights into memory**, so they run cheaply on any
   machine with a local Hugging Face cache.
2. **PyPI dependencies over hand-rolled code, consumed via PEP 723 inline script
   metadata + `uv run`** (the established `upkeep.py` pattern).
   The `gguf` package (ggml-org) supplies the authoritative `GGML_QUANT_SIZES`
   table and header reader — killing the stale-table bug class outright (e.g.
   the unknown UD-Q8_K_XL quant type of earlier hand-copied tables) — and
   `huggingface_hub` supplies pagination/token-auth/retries for anything that
   talks to the Hub. Tested versions are recorded in each tool's PEP 723
   header; a `gguf` bump can change quant-type coverage, so re-run
   `estimate_active_params.py` after upgrades (its unknown-type warning doubles
   as the drift canary).

Run them via uv (no venv or manual installs needed):

```sh
uv run local-llm/<tool>.py ...
```

| Tool | Purpose |
|---|---|
| `generate_layer_cards.py` | Extract per-tensor (layer) names/sizes and render markdown "layer cards" |
| `fit_analysis.py` | Compute how many layers must be evicted to CPU to fit a GPU budget |
| `estimate_active_params.py` | Measure total and per-token ACTIVE parameter counts / bytes from the GGUF header |
| `fetch_hf_manifests.py` | Persist HF repo file listings and audit each configured `--hf-file` against llama.cpp's implicit `repo:quant` → file heuristic |
| `scan_cache_coverage.py` | **PoC/MVP** — diff the HF cache against `llamacpp-model-data.json`: repos with zero coverage, listed repos with extra cached quants, ambiguous `bpw`/multi-quant filenames (header-free; see `docs/refresh-local-llm-manifest.md`) |
| `gguf_context_length.py` | **PoC/MVP** — read `general.architecture` / `context_length` / `general.name` from a GGUF header via the PyPI `gguf` package (no weights loaded); used to pick `ctx-size` |

All four consume the same canonical model list in
`openai-completions-gfx1030/llamacpp-model-data.json` that also drives
`openai-completions-gfx1030/config.d/10-local-llm-inference.yaml` (via
`generate-local-llm-models.yaml.js`).

### Shared code policy

There is deliberately **no shared Python library**. The remaining shared
surface between the three GGUF-header tools (`read_gguf_header`,
`tensor_bytes`, `bare_repo`/`revision`, cache resolution, `BLK_RE`) lives in
`generate_layer_cards.py`, which the other two import directly
(`import generate_layer_cards as glc`). A dedicated `gguflib.py` was evaluated
and rejected: extraction would be churn without a third independent consumer.
The guardrail stands: single-purpose CLIs over shared code — not a mega-tool
with subcommands (that consolidation pattern already failed once).

`upkeep.py` (HF cache maintenance) and `fetch-model-cards.sh` (README mirrors)
stay standalone by design: different concerns, no GGUF parsing.

### `llamacpp-model-data.json` — cross-language contract

The flat, llama.cpp-shaped schema is consumed by both Python tools (this
directory) and the JS generator
(`openai-completions-gfx1030/generate-local-llm-models.yaml.js`). Keys:

| Key | Meaning | Generator flag |
|---|---|---|
| `hf-repo` | `org/repo:revision` (revision = quant tag) | `--hf-repo` |
| `hf-file` | exact GGUF filename (load-bearing: see `fetch_hf_manifests.py`) | `--hf-file` |
| `mmproj` | optional vision projector file | `--mmproj` |
| `model-draft` | optional MTP/drafter sidecar GGUF (same snapshot as `model`); generator emits `--model-draft` via the launcher plus an explicit `--spec-type draft-mtp` (auto-inference of the spec type only happens on the `--hf-repo` path) | `--model-draft` |
| `cache-type-k` / `cache-type-v` | KV cache quant (`f32 f16 bf16 q8_0 q4_0 q4_1 iq4_nl q5_0 q5_1`); optional, default `f16`/`f16` | `--cache-type-k/-v` |
| `ctx-size` | AUTHORITATIVE context window (no `--fit-ctx`); optional, default `65536` | `--ctx-size` |
| `parallel` | 1 or 2; optional, default `1` | `--parallel` |
| `__argv` | family macro reference (`${qwen36}` …) + literal extra flags; llama-swap expands `${…}` at load; omit when empty | verbatim |

Companion manifests: `active-b.json` (repo-basename → active-params slug,
consumed by `deriveModelId`; regenerate with
`estimate_active_params.py --emit-slugs`).

### Model-id slug convention

`slug()` here and `deriveModelId()` in the JS generator share one convention:
**zero-padded integer billions, `NNb`** (e.g. `3.45B active → "03b"`, `≥100B →
"NNNb"`), combined as `<slug>-ctx<ctxSlug>-<hf-repo>`. Keep both sides in sync;
this is the single documented reference.


---

## generate_layer_cards.py

For every model entry with a locally cached GGUF file it resolves the file in
the local HF cache (`HF_HUB_CACHE` / `~/.cache/huggingface/hub`, in the
`models--org--repo` layout), extracts each tensor's name/shape/quant type/size
from the header, and writes one **layer card** per repo at
`local-llm/model-cards/<org>/<repo>.layers.md`.

- Tensor names are **architecture-level and identical across quants**, so quants
  of the same repo are grouped into one card; per-tensor sizes are listed per
  quant.
- If an entry carries `extraArgs` containing `--override-tensor '<pattern>=DEVICE'`,
  the pattern is audited against the real tensor names using llama.cpp's exact
  semantics — `std::regex_search` on the full tensor name, first match wins
  (`src/llama-model-loader.cpp`) — and a match report (matched layers, bytes
  moved, accidental non-`ffn_*` matches) is appended to the card.

Usage:

```sh
uv run generate_layer_cards.py                 # all repos with local files
uv run generate_layer_cards.py --repo unsloth/Qwen3.8-27B-GGUF
uv run generate_layer_cards.py --json /path/to/llamacpp-model-data.json
uv run generate_layer_cards.py --gguf path/to/model.gguf --stdout
uv run generate_layer_cards.py --outdir /tmp/cards
```

Exit code 0 if at least one card was written, 1 otherwise.

Headers are read via `gguf.GGUFReader` from the PyPI `gguf` package
(memory-mapped). A small subclass skips ARRAY field *contents* (tokenizer
vocab/merges — seconds per element-wise view otherwise); scalar fields and
tensor infos use the base reader untouched. Per-tensor byte sizes come from
`gguf.constants.GGML_QUANT_SIZES` (`type_size/blck_size` per element), the
table that tracks llama.cpp releases.

## fit_analysis.py

Computes, for the **dense** models in `llamacpp-model-data.json`, how many
layers must be evicted from GPU to CPU so that weights + KV cache +
activation/batch workspace + runtime overhead fit inside a GPU budget
(default 15 GiB).

Method, per dense model/quant with a local GGUF file:

1. Read the GGUF header (metadata + tensor infos) — no weights loaded.
2. Compute weight bytes per block and per block's ffn-only subset, plus the
   fixed non-block weights (token_embd/output/norms) that a layer override
   cannot touch.
3. **KV cache**: llama.cpp allocates KV per layer with per-layer
   `n_head_kv(il)` (0 for SSM layers in hybrids → zero-size tensors, see
   `src/llama-kv-cache.cpp`), so KV = n_attn_layers × 2 × kv_dim × 2B × ctx.
   K and V are always **f16** — KV quantization (`--cache-type-k/-v`) is no
   longer attempted; the tested dimension is context size alone:
4. **Activation workspace**: llama.cpp processes tokens in batches (`n_batch`),
   so the single-layer peak workspace is
   (2 up+gate + 1 down + ~5 attention/residual copies of `n_embd`) × `n_batch` × 2B,
   **not** ctx-sized.
5. **Solve**: evict the largest blocks (whole-block, or ffn-only like the
   `--override-tensor` pattern) until
   fixed + KV + act + overhead + remaining_blocks ≤ GPU budget.

Usage:

```sh
uv run fit_analysis.py [--gpu 15] [--ctxs 32768,65536,131072]
                        [--batch 2048] [--overhead 0.5]
```

Contexts (tool default): **32768 vs 65536 vs 131072**, KV fixed at f16/f16.

MoE models are skipped (architecture string contains `moe` or any `_exps`
tensor).

## estimate_active_params.py

Measures **total** and **per-token active** parameter counts straight from the
tensor shapes in the GGUF header, for every model entry in
`llamacpp-model-data.json` (or a single `--gguf` file). This replaces the
hand-maintained marketing-style table in
`openai-completions-gfx1030/active-b.json`, whose values were copied from model
cards and drifted from reality.

### Active-weight semantics

A tensor counts toward the per-token active weight iff the decoder graph reads
it on every generated token. Classification mirrors llama.cpp's expert naming
(and `gdevenyi/huggingface-estimate` `calculations.js` `buildMoe` predicates):

| Tensor class | Match | Active contribution |
|---|---|---|
| Routed experts | name contains `_exps.` | elements × `expert_used_count / expert_count` (from GGUF metadata, not model-card claims) |
| Everything else | attention, norms, router (`ffn_gate_inp*`), shared experts (`*_shexp.*`/`*_chexp.*`), dense-layer FFN of leading-dense MoE archs, `token_embd`, output head, routing biases (`exp_probs_b`) | 100% |
| MTP tail blocks | `blk.N` with `N ≥ block_count − nextn_predict_layers` | 0% — resident in memory but only executed by speculative decoding; reported separately |

Leading dense layers need no special-casing: their plain `ffn_{gate,up,down}.weight`
tensors simply contain no `_exps.` and are counted fully. The same applies to
fused expert tensors (`ffn_gate_up_exps`) and grouped-routing metadata —
whatever the file declares is what gets measured.

Alongside element counts the tool reports **active GiB at the stored
quantization** (using the same GGML type table as `generate_layer_cards.py`).
For decode-speed purposes that byte figure is the more honest number: MoE
quants mix per-tensor types, so "3B active" and the bytes actually streamed per
token can disagree across quants.

### Usage

```sh
uv run estimate_active_params.py                  # all entries with local files
uv run estimate_active_params.py --repo unsloth/GLM-4.7-Flash-GGUF
uv run estimate_active_params.py --gguf /path/to/model.gguf
uv run estimate_active_params.py --emit-slugs     # print an active-b.json replacement
```

The table compares the measured slug against the old `active-b.json` value;
divergences are flagged `<-- differs`. `--emit-slugs` prints a JSON object with
keys derived the same way the generator's `indexOf(slice)` matching expects
(repo basename minus `-GGUF`), ready to overwrite `active-b.json` after review.

### Known results (2026-06 cache)

- `GLM-4.7-Flash` (deepseek2 arch): 29.94B total, **3.90B active** → `04b`, not
  the tabulated `03b`. MLA + shared expert push the always-on weight up.
- `Muse-Glimmer-30B`: marketed "30B", header says **27.85B total** → slug `28b`.
- `Qwen3.8-27B`: carries a `nextn` MTP tail (0.42B) excluded from active →
  26.90B, same as its non-MTP sibling `Qwen3.6-27B`.
- `Ling-3.0-tiny`: 7.89B total, 1.38B active (8/128 experts) → `01b`.
  (Its UD-Q8_K_XL quant type was once outside the hand-copied type table,
  leaving the active-GiB column partial; the PyPI `gguf` table resolves it.)

## fetch_hf_manifests.py

llama.cpp has **no quantization-to-file manifest**: given
`--hf-repo <org>/<repo>:<quant>` without `--hf-file`, it resolves the repo's
default branch to a commit (`GET /api/models/{repo}/refs`, prefers `main`),
lists the tree (`GET /api/models/{repo}/tree/{commit}?recursive=true`), then
picks a GGUF by a pure filename heuristic (`find_best_model`,
`common/download.cpp`): the quant tag must appear in the path followed by `.` or
`-` (case-insensitive), sidecars (`mmproj`/`imatrix`/`mtp-`/`eagle3-`/`dflash-`/
`dspark-`) are excluded, sharded models resolve to shard `-00001-of-`, and the
**first match in tree order wins**. No tag defaults to trying `Q4_K_M` then
`Q8_0`.

Because that is fragile (duplicate quants at different bpw, tag strings that
don't appear verbatim in filenames), this tool downloads the tree listing once
per repo and persists it as `local-llm/hf-manifests/<org>--<repo>.json`
(including the resolved commit), then re-implements the heuristic offline and
checks every `llamacpp-model-data.json` entry: does the configured `--hf-file`
match what llama-server would pick implicitly?

```sh
uv run fetch_hf_manifests.py                # refresh manifests + audit all repos
uv run fetch_hf_manifests.py --print-plan   # also list ok entries
uv run fetch_hf_manifests.py --offline      # audit against cached manifests only
```

Network access goes through `huggingface_hub.HfApi` (`repo_info` for the
resolved `main` commit, `list_repo_tree(recursive=True)` for the tree) —
pagination, `HF_TOKEN` auth and retries included; `HF_ENDPOINT` overrides apply
as usual. Exit code 1 on any mismatch. Known findings (2026-06): for
`byteshape/Qwen3.6-35B-A3B-GGUF:Q4_K_S` the repo ships two Q4_K_S quants
(3.80bpw / 4.22bpw) and the heuristic would pick the other one — the explicit
`--hf-file` there is load-bearing. (A third bogus entry,
`unsloth/Qwen3.8-27B-GGUF:Q3_K_S` pinning `UD-Q3_K_XL` whose name never
contains `Q3_K_S[.-]`, was removed after this audit caught it.)

## gguf-metadata-parser.js

> Archived: moved to `old/agentcontainer/local-llm/huggingface/` with the
> scrapped "huggingface environment"; no live consumers.
>
> A standalone Node script that fetches the header of a remote GGUF file via an
HTTP Range request (first 100KB, redirects followed, 60s timeout) and extracts
architecture metadata relevant for model selection: architecture, block count,
embedding length, head_dim, attention head counts, expert counts, context
length, feed-forward length, rope.* settings, plus estimated parameter counts
(active/total) and KV-cache bytes-per-token (including MLA and hybrid-attention
special cases).

Usage:

```sh
node gguf-metadata-parser.js <gguf-url>
node gguf-metadata-parser.js <hf-repo> <hf-file>
```

Output is JSON with a `params` block and a `kvCache` block (with memory at
quarter/half/full context).

### Parameter estimation

`estimateParams` first checks a small table of canonical model names (Qwen,
GLM, Gemma, Devstral, Laguna); otherwise it falls back to an estimate from the
architecture fields (embedding + per-layer attention/FFN, with MoE handling
via expert counts).

### KV-cache estimation

`estimateKVCache` computes raw fp16-equivalent KV bytes per token:

- **MLA (DeepSeek2)**: KV is a compressed latent; only K is stored (no separate
  V), dimension = `kv_lora_rank + rope.dimension_count`.
- **Hybrid attention (Qwen3.5 style)**: some layers are recurrent with no KV
  cache; `full_attention_interval=N` or an explicit `attention.recurrent_layers`
  array determines the effective attention layer count.
- **Standard transformer**: separate K and V caches per layer.
