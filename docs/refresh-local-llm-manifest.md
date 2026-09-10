# Refreshing `lib/llamacpp-model-data.json`

This is the operational runbook for keeping the local-llm manifest in sync
with the Hugging Face cache. Run it whenever a new GGUF model or a new quant of
an existing repo lands in the cache (e.g. a background `upkeep.py pull` or a
manual `snapshot_download` finished).

The manifest is the single source of truth for
`openai-completions-gfx1030/config.d/10-local-llm-inference.yaml`:

```
llamacpp-model-data.json  --(generate-local-llm-models.yaml.mjs)-->  config.d/10-local-llm-inference.yaml
llama-swap-core.json      --(generate-general.yaml.mjs)----------->  config.d/00-general.yaml   (globals + sampling macros)
active-b.json             --(consumed by deriveModelId)----------->  the <slug> prefix of every model id
```

No part of this needs Infisical or the network — the two `node` generators read
local files only. (`generate.sh` wraps them in `infisical run` and *does* need
`infisical login` + network; use it only when you also need provider secrets.)

## Schema (one manifest entry)

| Key | Meaning |
|---|---|
| `hf-repo` | `org/repo:quant` — `quant` is the **trailing filename token** of the GGUF (see naming rules below) |
| `model` | exact cached GGUF filename. For sharded files, the `00001-of-NNNNN` shard (llama.cpp resolves the prefix) |
| `mmproj` | optional vision projector file; **omit entirely** if no projector is cached |
| `model-draft` | optional MTP/drafter sidecar GGUF (unsloth ships these under the repo's `MTP/` subdir — the subdir prefix is part of the filename); must live in the SAME snapshot as `model`. Requires `--spec-type` at launch, which the generator emits (`draft-mtp` by default) — a bare `--model-draft` on a local-path model enables no speculative impl and just wastes VRAM |
| `cache-type-k` / `cache-type-v` | KV-cache quant; optional, **default `f16`/`f16`** |
| `ctx-size` | **authoritative** context window; optional, **default `65536`**. The generator never applies `--fit-ctx` |
| `parallel` | `1` or `2`; optional, **default `1`** |

Keys with an implicit default are filled in by `generate-local-llm-models.yaml.mjs`
(`DEFAULTS` map) — omit them unless the entry deviates, e.g. `parallel: 2` or a
cap other than `65536`.
| `__argv` | family sampling macro `${…}` (see below), or omit when the family has no macro |

The file is a flat `{ "models": [ … ] }` array. **The last element has no
trailing comma** — append before the closing `]`/`}` and add a comma to the
previous last element.

## Step 1 — Discover what changed in the cache

Run the PoC coverage scanner, which diffs the cache against the manifest
(`local-llm/scan_cache_coverage.py`, header-free — it only walks filenames):

```sh
cd openai-completions-gfx1030
uv run local-llm/scan_cache_coverage.py
```

It prints three sections:

- **A) repos with ZERO manifest coverage** — entirely new repos to add.
- **B) listed repos with EXTRA cached quants** — new quants of known repos.
- **C) ambiguous filenames** — byteshape `bpw` suffixes / multi-quant names and
  the `<n>BPW` display tag llama.cpp would show for them.

`scan_cache_coverage.py` does not read GGUF headers or load weights. The deeper
audit of each *served* entry's `model` vs llama.cpp's implicit
`repo:quant -> file` heuristic is `fetch_hf_manifests.py` (Step 6).

> Manual fallback: `ls -1 "$HF_HUB_CACHE"/models--*/snapshots/*/` lists every
> cached GGUF, and `node -e "require('./llamacpp-model-data.json').models.forEach(m=>console.log(m['hf-repo'],'->',m.model))"` lists what is served — diff by eye.

## Step 2 — Gather the fields for each new entry

- **`hf-repo`** = `org/repo:QUANT`. `QUANT` is the trailing filename token.
  Keep it **extensive / unambiguous** (see naming rules): byteshape's
  `N.NNbpw` suffix and Unsloth's `UD-` dynamic-quant prefix are part of the
  specifier, not decoration.
- **`model`** = the exact filename from Step 1 (sharded → the `00001-of-NNNNN`
  shard).
- **`mmproj`** = `mmproj-*.gguf` **only if one is cached in the same
  `snapshots/<commit>/` dir**. If the repo is text-only, leave the key out.
- **`cache-type-k` / `cache-type-v`**: omit (the implicit default is `f16`/`f16`); set only for a non-f16 KV cache.
- **`ctx-size`** = the model's native `context_length` from the GGUF header,
  capped to fit VRAM. Read it without loading weights — the PoC header reader
  (`local-llm/gguf_context_length.py`) uses the PyPI `gguf` package and is
  header-only (memory-mapped, no tensor weights):

  ```sh
  uv run local-llm/gguf_context_length.py --repo ORG/REPO
  # or pass one or more explicit file paths / globs instead of --repo
  ```

  Policy applied so far: Qwen3.8 / GLM-4.7 capped to `65536`; LFM2.5 kept at
  native (`131072` / `128000`); others at native or `65536` when VRAM-bound.
  Write the key only when the cap is **not** the `65536` default.
- **`parallel`**: omit (the implicit default is `1`); write `2` only when VRAM allows.
- **`model-draft`** = the repo's `MTP/mtp-<model>-<QUANT>.gguf` sidecar, when it
  ships one (all unsloth gemma-4 repos do). Pick `Q8_0` when available — half
  the F16 size at negligible acceptance loss for a single MTP layer. The
  generator emits `--spec-type draft-mtp` automatically; add spec sampling
  flags (`--spec-draft-n-max …`) via `__argv`.
- **`__argv`** = the family sampling macro (next step) or omit.

## Step 3 — New model *family*? update `active-b.json` (slug)

`deriveModelId()` builds each id as `<slug>-ctx<ctxSlug>-<hf-repo>`, where
`ctxSlug = round(ctx-size/1024)` and `<slug>` comes from `active-b.json`.

`active-b.json` maps a **substring** of `hf-repo` → zero-padded `NNb` slug
(`3.45B active → 03b`, `≥100B → NNNb`). The **first matching substring wins**,
so insert a more specific key *before* a generic one:

```json
"LFM2.5-8B-A1B": "01b",   // specific — must precede the generic line below
"LFM2.5":         "03b",
```

Use `estimate_active_params.py --emit-slugs` (in `local-llm/`) to (re)derive
slugs from real header shapes and review the diff before overwriting
`active-b.json`.

## Step 4 — Edit `llamacpp-model-data.json`

Insert the new object(s) into the `models` array. Example (the LFM2.5-8B-A1B
MoE, text-only, native ctx):

```json
{
  "hf-repo": "unsloth/LFM2.5-8B-A1B-GGUF:UD-Q8_K_XL",
  "model": "LFM2.5-8B-A1B-UD-Q8_K_XL.gguf",
  "ctx-size": 128000,
  "__argv": "${lfm25}"
}
```

(`cache-type-k`/`cache-type-v`/`parallel` are omitted — they equal the implicit
defaults `f16`/`f16`/`1`; only the non-default `ctx-size: 128000` is written.)

Family sampling macros live under the `macros` key of `llama-swap-core.json`
(the source of truth) and are emitted into `config.d/00-general.yaml` by
`generate-general.yaml.mjs`. Current families include `qwen38`, `qwen36`,
`glm47f`, `gemma4`, `devstral`, `ling`, `lfm25`, plus the base `LLAMA_SERVER`
launcher (check `llama-swap-core.json` for the live list). To add/change a
macro, edit `llama-swap-core.json` and re-run `generate-general.yaml.mjs`.

## Step 5 — Regenerate `config.d/`

```sh
cd openai-completions-gfx1030
node generate-local-llm-models.yaml.mjs     # -> config.d/10-local-llm-inference.yaml  (always)
node generate-general.yaml.mjs              # -> config.d/00-general.yaml  (only if macros/00-general changed)
# full pipeline incl. provider secrets (needs infisical login + network):
./generate.sh
```

Both `node` generators run offline. The generator warns on **duplicate model
ids** — fix any collision (usually a `slug`/`ctx-size` clash) before shipping.

## Step 6 — Validate

```sh
node -e "require('./llamacpp-model-data.json')"        # parses? (no output = ok)

# coverage: re-run the Step 1 scanner and confirm
#   - every cached repo has >=1 manifest entry (no repo left at zero coverage)
#   - no listed repo has a cached .gguf whose quant is absent from the manifest

uv run local-llm/fetch_hf_manifests.py --offline       # audits each entry's
                                                       # model vs llama.cpp's
                                                       # implicit repo:quant->file
                                                       # heuristic (exit 1 on mismatch)
```

`fetch_hf_manifests.py` is the load-bearing check: it re-implements
`find_best_model` offline and verifies the configured `model` filename is what
`llama-server` would actually pick for that `hf-repo:quant`. A mismatch means
the entry is ambiguous (e.g. two `Q4_K_S` quants at different bpw) and needs an
explicit `model` pin.

## Step 7 — Reload llama-swap

llama-swap merges `config.d/` files additively at startup. Restart the
`openai-completions-gfx1030` llama-swap service so the regenerated
`10-local-llm-inference.yaml` (and `00-general.yaml` if changed) is picked up.

## Naming rules / gotchas

- **Extensive quant specifiers.** byteshape files carry a bpw suffix
  (`Q4_K_S-3.80bpw`, `Q5_K_M-5.60bpw`) and Unsloth uses a `UD-` dynamic-quant
  prefix (`UD-Q8_K_XL`). Keep these in `hf-repo` — never collapse to a bare
  `Q4_K_S`. llama.cpp's cached-list display only shows the *trailing* filename
  token (so it prints `:80BPW`, `:22BPW`, `:04BPW`); the `:quant` you put in
  `hf-repo` is what `find_best_model` matches via the `TAG[.-]` regex, so the
  extensive name selects the right file.
- **`mmproj` only when cached.** Don't guess a projector filename; if the
  snapshot dir has no `mmproj-*.gguf`, omit the key (text-only).
- **`ctx-size` is authoritative.** The generator does not auto-fit context;
  whatever you write (or the `65536` default, when omitted) is what the server
  gets. Read `context_length` from the header and cap to VRAM.
- **`active-b.json` substring ordering.** More-specific repo substrings must
  precede generic ones, or the wrong slug wins.
- **Sharded GGUFs.** `model` points at shard `00001-of-NNNNN`; the loader
  expands the prefix.
- **Last array element has no trailing comma** in `llamacpp-model-data.json`.

## Related docs

- `gguf-model-tooling.md` — schema contract, `fetch_hf_manifests.py`,
  `estimate_active_params.py`, `generate_layer_cards.py` reference, and the two
  PoC helpers `scan_cache_coverage.py` / `gguf_context_length.py` used above.
- `d018-split-config-d.md` — why the config is split into `00-general.yaml` /
  `10-local-llm-inference.yaml` and how llama-swap merges `config.d/`.
- `hf-cache-upkeep.md` — `upkeep.py` cache GC/pull/verify; `download_models.py`
  must use the `main` ref (not a pinned SHA) to survive pruning.
- `coding-agent/merge-models-json.mjs` / `coding-agent/generate-models.json.mjs`
  — the *coding-agent* model generators and the layered `models.json` contract
  (separate concern; not this local-llm manifest). Their documentation lives in
  those scripts' headers.
