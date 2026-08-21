# d002: client-side model ID filters

## Context

Remote provider `/models` endpoints return their full catalogue including paid
models. The generated llama-swap `config.yaml` should only contain the models
appropriate for each provider tier (free, subscription, or family-restricted).

> **Note (v13 refactor):** The pi `models.json` generator
> (`coding-agent/generate-models.json.js`) no longer fetches `/models` or
> applies these filters at all — it emits only `baseUrl` + `apiKey` overrides
> and lets pi reuse its own built-in catalog. `MODEL_FILTERS` now lives
> exclusively in `openai-completions-peer/generate-config.yaml.js` and applies
> only to the llama-swap `config.yaml` serving layer. See
> [`scoped-models-and-proxy-overrides.md`](scoped-models-and-proxy-overrides.md).

## Decision

Each provider with a `MODEL_FILTERS` entry gets a client-side filter function
applied after fetching. The filter receives each raw model object and returns
`true` to keep it or `false` to drop it.

| Provider ID         | Filter rule                                                                 |
|---------------------|-----------------------------------------------------------------------------|
| `openrouter-free`   | `id.endsWith(":free")` — OpenRouter tags free models with `:free` suffix    |
| `opencode-zen-free` | `id.endsWith("-free")` — OpenCode uses `-free` for no-cost tiers            |
| `opencode-go-sub` *(deprecated — see d019)* | Keep all models, but **only while** `__OPENCODE_GO_API_KEY` is present.<br>Without the key the filter drops every model → provider is disabled. |
| `google-free`       | Two inclusion rules:<br>• `id` contains `gemma-4` (all Gemma 4 variants are always free)<br>• `id` contains `flash` but NOT `pro` or `preview` (Gemini Flash free tier) |
| `mistral-free`      | `id` contains `devstral` or `devstral-small` (case-insensitive)             |

> **Deprecated:** the `opencode-go-sub` row above is retired. OpenCode now uses
a single `OPENCODE_API_KEY` for both peers (gated via that unified key); see
**[d019](d019-unified-opencode-key.md)**.

Providers with **no filter** registered either keep all returned models or
fall back to override-only (baseUrl + apiKey, no model list), letting pi use
its built-in list routed through the proxy.

## Rationale

Client-side filtering is simpler than server-side gating and works uniformly
across all providers. The filter is applied *after* fetching, so the same
fetch-and-filter pattern works for any provider that publishes a full catalogue.
