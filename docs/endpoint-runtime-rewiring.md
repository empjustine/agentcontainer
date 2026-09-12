# Endpoint Runtime Rewiring: findings

Consolidated findings from two verification passes:

1. Whether the `pi-free` extension (`/reference/github/apmantza/pi-free`) is a valid example of
   "turning models on and off" at runtime, as an alternative to the static
   generation-time approach in `./coding-agent/run.sh`.
2. Whether custom LLM endpoint routing — proxying limited-availability endpoints
   through a bazzite `llama-swap` — can be achieved with a pi extension.

Verified against the installed pi 0.84.1 docs and pi-free's source + tests.

---

## 1. Two competing approaches to "turning models on and off"

### 1.1 Current approach: two generators, split by function (static, build-time)

On/off is decided **at container start, on the host, outside pi**. The v13
refactor split the old unified generator into two scripts with non-overlapping
responsibilities:

**LLM serving** (`openai-completions-peer/run.sh` → `config.yaml`):
1. `openai-completions-peer/run.sh` runs `openai-completions-peer/generate-config.yaml.js`
   with the `.env` file, producing llama-swap's `config.yaml`.
2. The script fetches `/models` from each enabled cloud provider (using
   `MODEL_FILTERS` to keep only `:free` / `-free` variants) and emits the
   full model catalog into the `models` section.
3. Locally, it reads `llamacpp-model-data.json` to build `--model`/`--hf-repo`
   cmds for each GGUF file (using `${LLAMA_SERVER}` / `${<family>}` /
   `${<cacheType>}` macros).
4. This file is mounted into the llama-swap container at runtime.

**LLM usage** (`coding-agent/run.sh` → `~/.pi/agent`):
1. `coding-agent/run.sh` copies `settings.json` and `auth.json` into the agent
   dir mounted at `~/.pi/agent`. `auth.json` carries pi's provider credentials
   (replacing the old `.env` + generated `models.json` with `$VAR` api keys).
2. **No `/models` fetching, no `models.json` generation** — pi uses its own
   built-in catalog for the configured providers (openrouter, opencode,
   opencode-go), re-routed through their default endpoints.
3. The "scoped models" set (which models the agent actually uses) is pinned
   via `enabledModels` in `settings.json`, not by overwriting provider catalogs.

*(Deprecated — `coding-agent/models.sh` was removed during the v13 refactor;
the full-catalog generation logic it provided is now handled inline by
`generate-config.yaml.js` for llama-swap. pi's own catalog is used directly,
with credentials supplied via `auth.json` copied by `run.sh`.)*

Consequence: turning models on/off = editing env vars or filter functions and
re-running the generator (i.e. restarting the container). There is no runtime
switching.

### 1.2 Alternative: `pi-free` (runtime extension)

pi-free is a **runtime pi extension** that toggles models inside a running pi
session:

- On `session_start` it captures the full catalog via `ctx.modelRegistry`
  (`lib/built-in-toggle.ts`), splits it into free/all sets, and applies a
  free-only filter by default.
- `/toggle-{provider}` (and global `/toggle-free`) re-register the provider
  with the chosen model subset via `pi.registerProvider(name, { models: [...] })`
  (`lib/toggle-state.ts`, `lib/native-provider.ts`).
- The choice is persisted as `${providerId}_show_paid` in `~/.pi/free.json`
  and re-applied on the next `session_start`.

### 1.3 Verdict

**Yes — pi-free is a legitimate, tested example** of the runtime mechanism,
and a real alternative to the static `run.sh` generation approach. Cross-checked
against pi 0.84.1 docs:

| Mechanism | Doc reference | pi-free usage |
|---|---|---|
| `pi.registerProvider(name, config)` with `models` replacing a provider's model list, effective immediately | `docs/extensions.md` (lines 1705–1845) | `lib/built-in-toggle.ts:238`, `provider-helper.ts:247` |
| `pi.unregisterProvider(name)` for teardown | `docs/extensions.md` (~line 1840) | native registrar |
| `ctx.modelRegistry` / `ctx.scopedModels` capture | `docs/extensions.md` (~line 990) | `lib/built-in-toggle.ts` |
| `refreshModels` live catalog discovery | `docs/extensions.md` (line 1766) | `lib/native-provider.ts:195` |
| Tests | — | `tests/built-in-toggle.test.ts`, `tests/toggle-state.test.ts`, `tests/registry-provider-overrides.test.ts` |

### 1.4 Caveats

1. **Granularity**: pi-free toggles **per provider free/all**, not arbitrary
   per-model enable/disable. For arbitrary patterns pi's native `enabledModels`
   setting / `--models` flag (minimatch, resolved into `ctx.scopedModels`) is
   the built-in equivalent (`docs/usage.md` line 192/290).
2. **Installation**: the extension must be installed/loaded in the session
   (`pi install npm:pi-free`). The current `Containerfile` only installs pi itself.
3. **Composition**: pi composes `models.json` overrides **above** registered
   providers, so `run.sh`'s generated file and pi-free can coexist — but for the
   same provider `models.json` wins.
4. **Dynamic local catalogs**: pi-free does not cover a live llama.cpp/llama-swap
   `/models` endpoint; pi's documented pattern there is a `refreshModels` callback.
5. **Security posture**: `run.sh` env-gating never even exposes paid providers
   without credentials; pi-free registers the full catalog and hides paid models
   by default (free-only) — the paid models are still present in the registered
   provider.

---

## 2. Custom LLM endpoint routing through bazzite llama-swap

### 2.1 The scenario

In other environments (e.g. Termux/mobile — see `api-gateway/DECISIONS.md`, or
restricted networks) only a limited set of LLM endpoints is reachable. The goal:
**proxy** those upstreams through the local (bazzite) `llama-swap`, so pi talks
only to llama-swap and llama-swap carries the upstream traffic.

Answer: **yes, with an extension** — split into two halves.

### 2.2 Half A — pi → llama-swap routing (extension's job)

Register one provider whose `baseUrl` is the local llama-swap endpoint and let
`refreshModels` discover whatever llama-swap currently exposes (local models
**and** peer models all appear in `/v1/models`). This is the documented "live
llama.cpp catalog" pattern (`docs/extensions.md` line 1766):

```typescript
pi.registerProvider("llama-swap", {
  baseUrl: "http://127.0.0.1:8080/v1",   // bazzite llama-swap endpoint (env-configurable)
  apiKey: "$LLAMASWAP_API_KEY",          // or "$LLAMACPP_API_KEY"
  api: "llm-local-inference",
  async refreshModels({ signal }) {
    const res = await fetch("http://127.0.0.1:8080/v1/models", { signal });
    const { data } = await res.json();
    return data.map(({ id }) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }));
  },
});
```

- *(Deprecated — `coding-agent/models.sh` was removed; its role is now
  handled inline by `generate-config.yaml.js` when local llama.cpp is configured.)*
  This is the runtime equivalent of what `coding-agent/models.sh` does
  statically (curl `/models` + jq).
- The context-window/`NNNctx` slug is produced by `ctxSlug()` in
`generate-config.yaml.js` at generation time; the matching `--fit-ctx NNNN` is
written directly into each model's `cmd`, so no runtime parsing is needed.
- Finer routing: model definitions support **per-model `baseUrl` overrides**
  ("Model definitions can set `baseUrl` to override the provider endpoint for
  that model"). pi-free's `getOpenCodeModelBaseUrl`
  (`providers/opencode-session.ts:125`) is a working example of an extension
  rewriting per-model endpoints at runtime.
- `pi.unregisterProvider()` handles teardown.

### 2.3 Half B — llama-swap → upstream peers (config, extension can drive it)

The proxying itself is llama-swap's **`peers`** feature:

- Already in use in this repo: `openai-completions-peer/config.d/`
  (`"peers": { "openrouter-free": { "proxy": "https://openrouter.ai/api", ... } }`).
- `generateLlamaSwapConfig()` (in `generate-config.yaml.js`) emits the peers
  section from fetched cloud providers:
  `peers[id] = { proxy, models, apiKey }` where `proxy` is the upstream base
  URL and `apiKey` is interpolated as `"${env.PROVIDER_API_KEY}"`.

An extension cannot edit llama-swap's config file directly (separate process),
but it can:

1. Run the existing generator (`generate-config.yaml.js --llama-swap-config
   <path>`) from a command handler (e.g. `/sync-llamaswap`) — the same thing
   `openai-completions-peer/run.sh` does at boot;
2. Then reload llama-swap (SIGHUP / config watch) or restart the container,
   per environment.

### 2.4 Design for the "limited endpoint" environment

pi-free's `lib/native-provider.ts` (lines 195–240) is the full template:
`registerProvider` with `getModels`/`filterModels`/`refreshModels` plus runtime
re-registration. An extension can decide **at runtime** which routes to register
based on env:

- endpoints reachable → register direct providers (current behavior);
- not reachable → register only the `llama-swap` provider, so pi never talks to
  the internet; keys stay in llama-swap's env
  (`${env.OPENROUTER_API_KEY}` style, as the generated config already does).

### 2.5 Caveats

1. **Metadata through the proxy**: when pi reaches peer models *through*
   llama-swap, the `/v1/models` response only carries `id`/`status` — context
   windows, reasoning, and cost must be supplied by the extension (same data
   `llamacpp-model-data.json` / the pricing DBs provide today).
2. **llama-swap config still needs generating** — the extension replaces
   `models.json` generation for the pi side, but Half B (peers config) must
   still be produced and loaded by llama-swap.
3. **Composition with `models.json`**: registered providers compose *below*
   `~/.pi/agent/models.json` overrides, so a stale generated file can mask the
   runtime registration for the same provider.

---

## 3. References

- pi-free: `/reference/github/apmantza/pi-free`
  - `lib/built-in-toggle.ts`, `lib/toggle-state.ts`, `lib/native-provider.ts`,
    `provider-helper.ts`, `providers/opencode-session.ts`
  - tests: `tests/built-in-toggle.test.ts`, `tests/toggle-state.test.ts`,
    `tests/registry-provider-overrides.test.ts`
- pi docs (0.84.1): `docs/extensions.md` (registerProvider/unregisterProvider/
  refreshModels/modelRegistry), `docs/custom-provider.md`, `docs/models.md`,
  `docs/usage.md` (`--models`, `enabledModels`)
- This repo:
  - `coding-agent/run.sh` — copies `settings.json` + `auth.json` into the container, then launches
  - `openai-completions-peer/generate-config.yaml.js` — MODEL_FILTERS,
    `generateLlamaSwapConfig()` (peers), `--llama-swap-config` flag
  - *(Removed — `coding-agent/models.sh` was deleted during the v13 refactor;
    llama.cpp `/models` is now fetched by `generate-config.yaml.js` when
    `LLAMACPP_BASE_URL` is set.)*
  - `openai-completions-peer/run.sh`, `openai-completions-peer/config.d/`
    (peers in use), `openai-completions-peer/llama-swap-core.json`
  - `api-gateway/` — basic-auth UUID-routed gateway for mobile/limited networks
