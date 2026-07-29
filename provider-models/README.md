# generate-pi-models.js

Generates a `models.json` document with provider overrides by querying live
`/models` endpoints from inference providers, applying client-side model
filters, and merging pi's per-model metadata (compat, reasoning settings).

Output is printed to stdout.  Warnings and errors go to stderr so they never
pollute the JSON output.

```sh
node generate-pi-models.js                 # print to stdout
node generate-pi-models.js > models.json   # save to file
```

Raw (unfiltered) API responses are dumped as `provider-models/<id>-raw-models.json`
for offline inspection.

---

## Environment variables

Provider overrides come from **shell environment variables** (`export` before
running the script), not from a `.env` file.  Every built-in provider falls
back to its standard public endpoint when its `*_BASE_URL` var is absent, so
**no env vars are required**.

### Proxy URL overrides

| Variable | Provider | Notes |
|---|---|---|
| `OPENROUTER_BASE_URL` | openrouter-free | — |
| `__OPENROUTER_API_KEY` | | optional, pi resolves at runtime |
| `OPENCODE_ZEN_BASE_URL` | opencode-zen-free | — |
| `__OPENCODE_ZEN_API_KEY` | | optional |
| `OPENCODE_GO_BASE_URL` | opencode-go-sub | subscription tier |
| `__OPENCODE_GO_API_KEY` | | required to enable opencode-go-sub |
| `LLAMACPP_BASE_URL` | llamacpp | or `LLAMA_API_BASE_URL` |
| `__LLAMACPP_API_KEY` | | optional |
| `OLLAMA_BASE_URL` | ollama (native API) | local: `http://localhost:11434` |
| `__OLLAMA_API_KEY` | | optional |
| `GOOGLE_BASE_URL` | google-free | falls back to `GEMINI_API_KEY` |
| `__GEMINI_API_KEY` | | |
| `MISTRAL_BASE_URL` | mistral-free | — |
| `__MISTRAL_API_KEY` | | optional |
| `CLINE_BASE_URL` | clinepass | subscription-backed |
| `__CLINE_API_KEY` | | required to enable clinepass |

### API key conventions

- `__`-prefixed vars (`__OPENROUTER_API_KEY`) avoid collision with pi's
  standard auto-detection (pi looks for `OPENROUTER_API_KEY`).  The script
  prefers the `__`-prefixed var but falls back to the plain name when absent.
- `opencode-go-sub` uses a dedicated `__OPENCODE_GO_API_KEY` (no fallback to
  `OPENCODE_API_KEY`).  The subscription-tier endpoint is only enabled when
  that key is present — its model filter drops every model otherwise, so no
  tier/paid models are exposed without a credential.
- `baseUrl` is baked as a literal (`models.json` doesn't support `$VAR`
  interpolation for `baseUrl`, only for `apiKey`/`headers`).

---

## Design decisions

### Why `__`-prefixed API key vars

Pi auto-detects standard env vars like `OPENROUTER_API_KEY` at startup.  If
this script emitted a `$OPENROUTER_API_KEY` reference into `models.json`, pi
would resolve it — but we'd have no way to distinguish "user set it for pi"
from "user set it for this script."  The `__` prefix gives an unambiguous
signal that the variable is intended for this script's generated provider
overrides, while still resolving through pi's normal `$VAR` mechanism at
runtime.

### Why no `.env` file

Provider endpoints change infrequently, and the script is designed to be run
once and produce a static snapshot.  Shell env vars are the simplest
interface; adding dotenv support would introduce a dependency and a
configuration file with no real benefit.

### Why live /models fetch instead of hardcoded model lists

Pi's built-in providers have hardcoded model catalogs that go stale when
providers add or remove models.  By fetching `/models` at generation time,
the output always reflects the current lineup.  The client-side filter
(e.g. `:free` suffix for OpenRouter) is a deliberate choice over server-side
filtering because it works without authentication for public endpoints.

### Why llama.cpp context windows are parsed from slug IDs

llama-swap model IDs embed a `ctxNNN` macro (e.g. `ctx200`) that maps to a
`--fit-ctx` value in the config YAML.  Parsing this from the slug avoids
a per-model-ID lookup table — any model using a known `ctxNNN` macro gets
the right context window automatically.

### Why a cross-provider pricing database (PRICING_DB)

Free-model variants (e.g. `:free`) report zero cost from the API, and local
models (llama.cpp) have no provider pricing at all.  The pricing DB collects
real costs from ALL models across every provider response (not just the
filtered subset) so that free variants and local models can inherit a
meaningful cost estimate from their paid siblings on other providers.

### Why virtual cost estimation

When no real pricing is available (no provider has the model, or it's a
novel model with no cross-provider equivalent), the script estimates cost
from parameter count.  The heuristic ensures free variants and their paid
siblings share the same intrinsic cost (freeness is a billing artifact, not
a capability difference), premium variants (`:nitro`) cost more, and
throughput-optimized variants cost less.

### Why `openai-completions` api for most providers

Every provider listed here exposes an OpenAI-compatible `/v1/chat/completions`
endpoint.  The only exception is `google-free`, which uses
`google-generative-ai` because Gemini's API has a different auth mechanism
(`X-Goog-Api-Key` header) and returns IDs with a `models/` prefix.

### Why `requireApiKey` gating

Some providers (OpenCode Zen, ClinePass) return ALL models — including paid
ones — when contacted without authentication.  The `requireApiKey` flag on
those entries prevents the script from fetching without a key, rather than
relying solely on a naming-convention filter (which is fragile and would
let paid models through if the naming convention changed).

### Why pi-model-metadata.json exists separately

Provider `/models` endpoints never return OpenAI-compatibility flags
(`compat`, `thinkingFormat`, `reasoning`, `thinkingLevelMap`).  These are
pi-specific model properties curated per model.  The metadata file mirrors
pi's built-in definitions so generated models behave identically to pi's
own catalog — without it, models like Mistral's Devstral or Gemini Flash
would lack reasoning support configured in pi.

---

## Adding a new provider

1. Add an entry to `BUILDIN_PROVIDERS` with `id`, `api`, `baseUrlEnv`,
   and optionally `apiKeyEnv`.
2. Add the default endpoint to `DEFAULT_BASE_URLS`.
3. If the provider needs client-side model filtering, add a filter
   function to `MODEL_FILTERS`.
4. If the provider uses a non-standard auth mechanism (e.g. Google's
   `X-Goog-Api-Key`), set `fetchAuth` on the provider entry.
5. If the provider's `/models` response uses a prefix on model IDs
   (e.g. `models/`), set `modelIdPrefix` on the provider entry.
6. Map the provider ID to its pi metadata key in `METADATA_PROVIDER_MAP`.
7. If the provider uses per-million pricing (not per-token), add an
   entry to `PROVIDER_PRICING_MULTIPLIER`.
