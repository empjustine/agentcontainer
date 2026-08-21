# Layered pi `models.json` (base + `model-*.json` overlays)

Pi reads a single `models.json` (from `~/.pi/agent/`). Instead of one big
hand-written file, `coding-agent/` builds it by **layering** concern-scoped
overlay files on top of a base. This is the pi-side half of the "config
generator system" — each generator owns one concern and emits one `model-*`
layer; a small merge stacks them and writes the final `models.json`.

## Naming

Layers are named so the collector can glob them and order them by filename:

```text
model-${lexorank}-${environ}-${uniquename}.json
```

- `lexorank` — merge-order rank. Zero-padded (`000`, `010`, `020`, …) so that
  plain lexicographic filename sort equals merge order. Kept numeric rather
  than a full LexoRank string because the layer set is small and near-static —
  a simple `readdir().sort()` is all the collector needs.
- `environ` — deployment concern: `cloud` | `local` | `peer`.
- `uniquename` — distinguishes multiple layers of the same `environ` (`default`
  when there is only one).

The base is **not** a `model-*` layer; it is the foundation everything is
overlaid onto and stays out of the collection.

## The layer set (in `coding-agent/`)

| File | Concern | How it's produced |
|------|---------|-------------------|
| `00-model-base.json` | base foundation (usually `{}`) | checked in |
| `model-000-cloud-default.json` | cloud providers | `generate-model-000-cloud-default.json.mjs` — a no-op, writes `{}`; cloud config lives in env vars / `auth.json` (pi auto-detects) |
| `model-010-local-default.json` | local llama-swap models **+ cloud-via-peer fallback** | `generate-models.json.mjs` — probes the gfx1030 instance for GGUF models; for each cloud provider whose default endpoint is unreachable, re-routes that provider through the bazzite peer |
| `model-020-peer-default.json` | peer reverse-proxy models | *(future)* |

Each `model-*.json` is a `models.json`-shaped **layer**: `{ "providers": { "<id>": {...} } }` — or `{}` for a no-op layer. A deployment keeps the `model-*.json` layers it needs (cloud/local/peer) and drops the rest; the collector merges whatever is present.

## Merge order and semantics

`merge-models-json.js` reads the base then every `model-*.json` in **lexical
order** (equivalently lexorank order), deep-merging each on top of the
previous, and writes the final `models.json`:

```text
00-model-base.json  (or {})
  + model-000-cloud-default.json
  + model-010-local-default.json
  + model-020-peer-default.json   (future)
  → models.json
```

Merge rules:
- `providers` merge per **provider id**; a provider defined in a later layer is
  added, or its fields are merged if it already exists.
- Within a provider, **objects** (e.g. `compat`) recursively merge; **scalar**
  and **array** fields (e.g. `baseUrl`, `models`) are **replaced** by the later
  layer.

A later layer therefore *overrides* a scalar/base setting and *adds* models,
without the earlier layer needing to know about it. Because the collector reads
whatever `model-*.json` files are present at runtime, a deployment picks its
layers simply by placing the files it wants next to the merge.

## Generators

### `generate-model-000-cloud-default.json.mjs`

Writes `model-000-cloud-default.json` as `{}`. Cloud provider configuration is
*not* modelled in `models.json` — pi discovers providers from standard env vars
and reads keys from `auth.json`, so this layer is intentionally empty.

### `generate-models.json.mjs`

The local llama-swap layer — and the cloud-via-peer fallback. Emits a
`providers` map containing only the providers whose default routing is not
usable on this host, rewritten to routes that are:

- **`llama-swap`** (local GGUF): probes the multipurpose llama-swap instance —
  `$PEER_BASE_URL` → `localhost:8080` (co-located LAN port; also what the
  tailscale funnel reverse-proxies, so the FQDN serves the identical
  catalog) → bazzite tailscale URL — and takes the first candidate that
  serves `-GGUF` model ids. (The legacy `:18080` local-inference port is
  deprecated.) When the chosen source is the peers-only router, GGUF-only
  filtering keeps cloud models from being double-listed under both
  `llama-swap` and their own provider.
- **`openrouter` / `opencode` / `opencode-go`**: each provider's DEFAULT
  `/v1/models` endpoint is probed first; reachable ⇒ pi's built-in provider
  handles it natively and nothing is emitted. Unreachable ⇒ the models are
  looked for behind the bazzite peer router (`$PEER_BASE_URL`, then
  `localhost:8080`, then the bazzite tailscale URL — an https reverse proxy of
  that same router); if visible, a provider override is emitted so pi routes
  that provider through the peer instead.

Example (remote host with no direct cloud access, all traffic thru bazzite):

```json
{ "providers": {
  "llama-swap": {
    "baseUrl": "http://localhost:8080/v1",
    "api": "openai-completions",
    "compat": { "supportsStore": false, "supportsDeveloperRole": false,
      "supportsReasoningEffort": false, "supportsUsageInStreaming": true,
      "supportsStrictMode": false, "maxTokensField": "max_tokens" },
    "apiKey": "$PEER_API_KEY",
    "models": [
      { "id": "27b-ctx032-unsloth/Qwen3.8-27B-GGUF:Q6_K", "name": "Qwen3.8-27B Q6_K",
        "reasoning": true, "input": ["text", "image"],
        "contextWindow": 32768, "maxTokens": 32768,
        "cost": { "input": 1, "output": 1, "cacheRead": 1, "cacheWrite": 1 } }
    ]
  },
  "opencode": {
    "baseUrl": "http://localhost:8080/v1",
    "apiKey": "$PEER_API_KEY",
    "models": [ { "id": "opencode/deepseek-v4-flash-free", ... } ]
  }
} }
```

Routing rules:
- **baseUrl is a LITERAL url**, resolved at generation time (pi does not
  expand environment references in baseUrl). **apiKey is the literal string
  `$PEER_API_KEY`**, which pi resolves from the environment at request time.
- **Cloud-model attribution**: through the peers-only router, ids arrive fully
  qualified as `<peerId>/<modelId>` (`openrouter/org/model:free`). The owning
  peer prefix is authoritative when present; bare ids fall back to suffix
  heuristics matching the peer generators' filters (`:free` → openrouter,
  `-free` → opencode, remainder without `/` and no grok → opencode-go).
- If nothing usable is detected, nothing is written and any existing layer is
  left untouched.
- **Models**: full pi-shaped entries (`pi docs/models.md`), deduplicated by id,
  order preserved. *All* are listed — both `loaded` and `unloaded` — because
  llama-swap swaps models in/out on demand (unlike pi's built-in `llama.cpp`
  provider, which lists only `status: loaded`).
- Per-model metadata mirrors what `generate-local-llm-models.yaml.js`
  published upstream: llama-swap serves each config.d/ entry's `metadata`
  block on `/v1/models` under `meta.llamaswap`, which is already pi-shaped —
  it is copied field-by-field (`reasoning`, `input`, `contextWindow`,
  `maxTokens`, `cost`). Older llama-swap builds without that block fall back
  to the OpenAI-ish top-level fields (`context_length`,
  `architecture.input_modalities`, `capabilities.vision`). `name` is derived
  from the model id (`<repo-basename> <quant>`) purely for display.
- **`api`** is `openai-completions` and `baseUrl` is normalized to `/v1` (the
  same convention pi's built-in `llama.cpp` provider uses).
- **`compat`** is the exact block the built-in `llama.cpp` provider attaches
  per model (pi `docs/models.md`), placed at the provider level so every model
  shares it. It is set **explicitly** — because the provider is hand-defined
  here, pi's provider-composer does not auto-inherit that compat from the
  `llama.cpp` provider id (only `api`/`baseUrl` are inherited from built-in
  defaults).

## Usage

```sh
export PEER_BASE_URL=http://127.0.0.1:8080   # or leave unset on a co-located
                                             # host (LAN :8080 is probed)
export PEER_API_KEY=...                  # optional

node generate-model-000-cloud-default.json.mjs   # -> model-000-cloud-default.json
node generate-models.json.mjs   # -> model-010-local-default.json
node merge-models-json.js                        # -> models.json
```

Each output path defaults to `$PI_MODELS_JSON`, else the path on the command
line, else the default `model-*.json` / `models.json` in `coding-agent/`. Copy
the merged `models.json` into the container's `~/.pi/agent/models.json`.
