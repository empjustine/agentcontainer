# d011: supplementary tools — `dump-provider-models.mjs` & `apply-*.js`

> **Note (v13 refactor):** The old monolithic `generate-models.json.js` was split
> into two scripts. References below use the new names:
> - `openai-completions-peer/generate-config.yaml.js` — generates the llama-swap
>   `config.yaml` (local GGUF models + cloud peers); fetches live `/models`.
> - `coding-agent/generate-models.json.js` — generates pi's `models.json`
>   (provider baseUrl/apiKey overrides only).

## Context

Beside `generate-config.yaml.js`, several other scripts in the repository
interact with pi's provider models or settings. Their roles and relationship
to the main generator need to be clear.

## Decisions

### 1.  `dump-provider-models.mjs` — pi internal catalogue snapshot

**Purpose:** Read pi's **built-in** provider model definitions directly from
the installed `@earendil-works/pi-ai` package and dump the combined catalog as
a single newline-delimited JSON snapshot at `cloud-llm/pi-models.ndjson` (written by `cloud-llm/dump-provider-models.mjs`)
(one model object per line; each model already carries its `provider` field, so
a single file preserves the per-provider grouping without one document per
provider).

**When to use:** After `pi update` or when investigating what models pi ships
natively. No network calls, no API keys.

**Relationship to `generate-config.yaml.js`:** These are different sources.
`dump-provider-models.mjs` reads pi's internal `.models.js` files (static,
shipped with the package). `generate-config.yaml.js` fetches live `/models`
endpoints from running providers. The snapshots are useful for comparison,
debugging, and metadata extraction.

### 2.  `apply-models.js` — legacy one-shot for llama.cpp only

**Purpose:** Quick one-time setup for a llama.cpp provider. Fetches `/models`
from a running instance and writes directly to `~/.pi/agent/models.json`.

**When to use:** When you just need llama.cpp configured fast, without the
full `generate-config.yaml.js` pipeline. Simpler, fewer dependencies.

**Note:** Hardcodes `contextWindow: 65536` for all models — does not read the
YAML config for real context windows. Use `generate-config.yaml.js` for accurate
context windows.

### 3.  `apply-pi-settings.js` — combined retry + models setup

**Purpose:** Two-in-one: writes retry settings to `settings.json` AND
configures llama.cpp models in `models.json`. Replaces the need to run
`apply-models.js` and `apply-retry-settings.js` separately.

**Relationship:** Supersedes both `apply-models.js` and `apply-retry-settings.js`.
Same limitation as `apply-models.js` (hardcoded 65536 context).

### 4.  `apply-retry-settings.js` — retry config only

**Purpose:** Writes retry configuration (`maxRetries: 6`, `baseDelayMs: 10000`,
`maxRetryDelayMs: 600000`) to `~/.pi/agent/settings.json`.

**When to use:** When you only need retry settings without touching models.

### 5.  `coding-agent/models.sh` — legacy shell pipeline (removed)

**Purpose:** Original shell-based model fetcher using `curl` + `jq`. Same
functionality as `apply-models.js` but as a shell script.

**Status:** Removed during the v13 refactor (git-staged deletion). The curl
+ jq logic is now handled inline by `generate-config.yaml.js` /
`apply-models.js`. Kept only as a historical reference in `old/`.

## Future direction

The `apply-*.js` scripts are conveniences for quick local setup. Long-term,
`generate-config.yaml.js` is the canonical tool for generating `models.json`,
and `dump-provider-models.mjs` is the canonical tool for inspecting pi's
internal catalog.
