---
id: d028-provider-extensions-vs-generated-config
type: decision
status: proposed
title: d028 — provider extensions (pi/opencode plugins) vs generated-config machinery
parent: architecture
depends-on:
  - coding-agent
  - d027-models-dev-relay-fallback
references:
  - environments
tags:
  - coding-agent
  - llm-reverse-proxy
---

## Context

The current `coding-agent/` machinery decides provider routing at **generation
time**: `generate.sh` probes every cloud provider (direct endpoint first, then
the relay path-route), then emits layered configs — `model-010` (local GGUF via
llama-swap), `model-012` (reroute-only overrides for pi-native providers),
`model-015`/`model-016` (full definitions for cline-pass/hyper, which pi does
not ship natively), `opencode.jsonc` (the opencode twin) — merged by
`merge-models-json.mjs` and staged into the container by `run.sh`. The probe
cascade lives in `lib/peer-probe.mjs`; the relaying itself is now the raw
`llm-reverse-proxy` (byte-for-byte, no key injection — d027).

The question: could **runtime provider extensions** — the pattern of
`charmbracelet/pi-hyper-provider`, `jellydn/pi-clinepass-provider` (pi), and
`haconglinh1990/opencode-clinepass-provider` (opencode) — replace that
machinery, and make direct→peer fallback logic simpler?

## Findings (all verified against installed pi 0.85.1 docs and the three repos' source)

**pi `registerProvider` has exactly the semantics the generated layers
emulate** (`docs/extensions.md` §registerProvider):

- *reroute-only override*: `pi.registerProvider("anthropic", { baseUrl })`
  — overrides the endpoint for an **existing** provider and **keeps all
  models**. That is layer `model-012` as one line of runtime code.
- *live catalog*: a `refreshModels({ signal })` callback (the docs' own
  example registers a live llama.cpp catalog from `GET /v1/models` without
  persisting). That is `generate-local-llama-swap.mjs` + its probe as a
  callback.
- *full form*: `createProvider({ auth, models, fetchModels, api })` from
  `@earendil-works/pi-ai` — what both reference extensions use — for
  providers pi does not ship natively (cline-pass, hyper).
- *composition preserved*: "`models.json` overrides still apply above it"
  (community-registered providers can still be rerouted by config).
- *immediate effect*: registrations after the load phase take effect without
  `/reload` — runtime re-routing mid-session is a supported operation.

**Reference extensions (source-verified):** `pi-hyper-provider` =
`registerProvider(createProvider)` + env-key auth + lazy OAuth + live
`fetchHyperModels` (3 s timeout, schema-validated) + credit-status UI events.
`pi-clinepass-provider` mirrors it for ClinePass (WorkOS OAuth refresh, 11
curated models). `opencode-clinepass-provider` = opencode `Plugin` whose
`config` hook **auto-registers the provider (baseURL + models) with no
manual opencode.json editing**, an `auth` hook (env/static key priority,
WorkOS token refresh with custom fetch on the chat path), zero-config
credential auto-import, and drop-in install (`~/.config/opencode/plugins/`
or `plugin` array).

**Local GGUF / model-010 caveat (operator correction — llama-server is NOT
directly available here):** pi ships a built-in `llama.cpp` extension
(`packages/coding-agent/src/extensions/llama/`, plus `docs/llama-cpp.md`)
that connects to a llama-server **router-mode** endpoint (`LLAMA_BASE_URL`,
default `http://127.0.0.1:8080`) — it *connects, never supervises*: the
docs' start command is the operator's own `llama-server --models-dir …`.
It also filters the catalog to `loaded`/`sleeping` (unloaded presets only
when llama-server router autoload is enabled), which is wrong for llama-swap,
whose whole point is on-demand swapping of unloaded entries. This deployment
keeps **llama-swap as the process supervisor** (crude but working
supervision/health checks) and does not run llama-server directly, so the
built-in extension path is rejected for the local provider. The replacement
for `model-010` is therefore a small custom `llama-swap` provider extension:
llama-swap already publishes each `config.d/` entry's `metadata` block on
`/v1/models` under `meta.llamaswap`, **already pi-shaped** (that IS the
current contract — `generate-local-llama-swap.mjs` is a field-by-field
mirror, not a metadata computer; the `lib/llamacpp-model-data.json` context
windows flow into llama-swap's `config.d/` at llama-swap config generation
time). Porting the *catalog* mechanics is thus unnecessary: the extension's
`refreshModels` only needs the mirroring logic (copy `meta.llamaswap` fields,
keep loaded AND unloaded, `openai-completions` dialect) — option (b) "the
metadata bundling works as intended" holds.

**Extension packaging:** pi auto-discovers `~/.pi/agent/extensions/*/index.ts`
(global) or `.pi/extensions/` (project-local), resolves `node_modules` next to
the extension, and supports `/reload`. `coding-agent/run.sh` already stages
files into the container — staging **one extension directory** replaces
staging four generated JSON layers.

**Reference implementations in the local mirror** (cursory sweep of
`~/Downloads/references/github` against the currently handled providers):

- pi providers: `charmbracelet/pi-hyper-provider`,
  `jellydn/pi-clinepass-provider` (already adopted above), and —
  **additional find** — `tejasa97/pi-cline-provider`: a second Cline-gateway
  provider extension (free-tier `z-ai/*` lineup by default, full catalog via
  `CLINE_MODELS=all`). Overlaps with jellydn's for the same gateway; if
  adopted, pick exactly one to avoid duplicate provider registration.
- opencode plugins: `haconglinh1990/opencode-clinepass-provider` (adopted
  above). No other opencode **plugins** for the handled providers are in the
  mirror; `anomalyco/opencode` (core source, `packages/core/src/plugin`)
  is available as the plugin-system reference.
- Not applicable despite the names — checked and rejected:
  `hidenobunagai/opencode-go-provider` and `Ryosuke-Asano/oc-go-provider-extension`
  are **VS Code Copilot Chat** extensions for an OpenCode Go subscription,
  not opencode plugins (their model spec tables — GLM-5, Kimi K2.5,
  MiMo-V2, MiniMax M2.5 — are useful reference data only);
  `lgrammel/llama-cpp-provider` is a Vercel-AI-SDK provider embedding
  llama.cpp in-process (macOS-only — superseded here by pi's built-in
  extension and rejected with it); `OpenRouterTeam/ai-sdk-provider` and
  `ben-vargas/ai-sdk-provider-opencode-sdk` are AI-SDK-shaped, not
  pi/opencode-plugin shaped.
- `earendil-works/pi` itself (full source in the mirror) — the built-in
  llama extension discussed above, plus the extension-runner/composer
  sources (`core/extensions/`, `core/provider-composer.ts`) backing the
  documented semantics.

**Trust classification of the reference extensions** (the boundary is
credential handling — extensions are the only place in this stack that touch
provider secrets, which makes them the highest-value exfiltration target in
the coding-agent container):

- **First-party — adopt as dependencies:** `charmbracelet/pi-hyper-provider`
  is written by the vendor of the Hyper provider it integrates; long-term
  trust is warranted (aligned incentives, and a malicious update would attack
  Charm's own customers).
- **Third-party — reference material only:** `jellydn/pi-clinepass-provider`,
  `tejasa97/pi-cline-provider`, `haconglinh1990/opencode-clinepass-provider`
  are maintained by unaffiliated individuals. Their *current* source is a
  useful reference for the ClinePass auth flows (WorkOS refresh, credential
  extraction from Cline CLI stores) and model curation, but long-term trust
  is unwarranted: an npm-installed extension auto-updates inside the agent
  container with network access and every provider key in reach, and nothing
  binds the author's incentives to ours. These are the pieces to re-own, not
  to depend on.

**Provider facts sourcing (opencode-sdk-js question, resolved):**
`@opencode-ai/sdk` is a typed client for a *running* opencode server
(`server.provider` / `server.model` endpoint groups — source-verified in
`packages/client/src/contract.ts`), so it can read opencode's *effective*
provider view including built-ins — but that view is itself resolved from
**models.dev** (`packages/core/src/models-dev.ts` fetches
`models.dev/api.json`; provider `npm` = the `@ai-sdk/*` compatibility
package, `api` = endpoint, per-model `tool_call`/`reasoning`/`attachment`).
models.dev is therefore the primary source — already vendored and refreshed
directly (d027). Two catalog entries are OAuth/subscription sentinels
(`api = http://127.0.0.1:9/unreachable` for hyper and cline-pass; the real
endpoints live in `lib/cloud-providers.mjs` facts / the vendor extensions).
The SDK is reserved for runtime introspection of a live opencode instance,
not used as a build-time feed (a running server would be a chicken-and-egg
at generation time, for data models.dev already carries). The models.dev
`npm` → pi `api`-dialect translation is a small deterministic map the
extension owns (`@ai-sdk/openai-compatible`/`@openrouter/ai-sdk-provider`
→ `openai-completions`; `@ai-sdk/mistral` → pi's native mistral;
`@ai-sdk/anthropic` → `anthropic-messages`).

**`@opencode-ai/models` (models.dev's official typed client) — verified
against `anomalyco/models.dev/packages/sdk`:** three entrypoints — a
stateless client (`.providers()` → `/api.json`, `.models()` →
`/models.json` = provider-agnostic metadata keyed `<lab>/<model>`,
`.catalog()` → `/catalog.json`, zero caching), an Effect wrapper, and a
`/snapshot` build-time snapshot (typed constants, no network). The typed
schema is strictly richer than what our refresh chain parses today:
per-model `reasoning_options` (none…max/budget — names matching pi's
thinking levels), `interleaved`, `structured_output`, tiered cache costs,
lifecycle `status`, and per-model `ModelProviderConfig { npm?, api?,
shape?: "responses"|"completions", body?, headers? }` — the `shape` field
maps almost 1:1 to pi's `openai-responses`/`openai-completions` dialects.
Same caveats as the raw catalog (OAuth sentinels for hyper/cline-pass; no
credential surface — safe under the "data is not the trust root" rule).
Adoption candidate for replacing our hand-rolled catalog validation and
feeding the extension's model curation; pin the release (in-repo version is
`0.0.0`, early project). The `snapshot` entrypoint is the typed analogue of
our vendored `lib/models.dev.api.json`.

**`catwalk.charm.land` (Charm's model catalog) — verified live**
(`GET /v2/providers` → 200, 41 providers / ~2,400 models; source:
`charmbracelet/catwalk`, MIT, TOML in-repo). Crush's curated database:
per-provider `api_endpoint` (literal or `$ENV`), `api_key` env ref, `type`
dialect (`anthropic|azure|bedrock|google|google-vertex|openai|openai-compat|openrouter|vercel`),
curated `default_large/small_model_id`; per-model costs (incl. cached),
`context_window`, `default_max_tokens`, `reasoning_levels`
(low/medium/high/xhigh/max — pi's exact thinking-level vocabulary),
`default_reasoning_effort`, sampling `options`. Engineering: ETag
conditional fetch (304) in the official Go client + a vendored embedded
fallback — the same direct→stale-copy chain as d027, designed-in. **Coverage
gap is the verdict:** openrouter/opencode-zen/opencode-go and the big labs
are present with real endpoints, but hyper, cline-pass, and mistral are
absent (first-party/subscription products don't ride community catalogs) —
so catwalk is a **complement** (extra tier in the metadata chain, or the
curated source for key-env provider lineups), never a models.dev
replacement. Cautions: `default_headers` carries Crush branding (must not
be forwarded); `/v2/` has no OpenAPI — schema only via the in-repo Go
types (available in the reference mirror). Its ETag semantics is the model
for upgrading our own refresh chain beyond full-blob refetches.

**NVIDIA NIM cloud inferencing (no hardware) — verified live + mirror:** pi
ships `nvidia` natively (`packages/ai/src/providers/nvidia.ts`):
`https://integrate.api.nvidia.com/v1`, `openai-completions`, env
`NVIDIA_API_KEY`, with generated compat quirks (`supportsStore`/
`supportsDeveloperRole`/`supportsReasoningEffort` false, `maxTokensField:
"max_tokens"`, `NVCF-POLL-SECONDS: 3600` header, per-model quirk tables in
`generate-models.ts`). Live API (anonymous probes):
`GET /v1/models` → 200 without auth, but a **bare OpenAI listing**
(id/object/created/owned_by only — zero capability flags, no pricing) that
is **stale** (EOL models still listed); `POST /v1/chat/completions` requires
`Authorization` (missing key → plain-text descriptive error, not RFC 7807),
and aggressively-EOL'd models return an excellent self-describing `410 Gone`
problem detail with the EOL timestamp — which the relay passes through
untouched. **No free-models listing endpoint and no per-model free flag
exists**: NIM's free tier is build.nvidia.com trial credits, per-account —
corroborated by models.dev's `nvidia` entry (103 models, 99 unpriced,
`@ai-sdk/openai-compatible`). Capability metadata therefore comes from
models.dev + pi's generated compat table, not the API. Mirror sweep:
`earendil-works/pi` (the reference integration), `spring-ai` (Java IT test
confirming the OpenAI-compatible proxy shape), `NVIDIA/SkillSpector` docs
(self-hosted NIM mention — n/a, no hardware), our own archived
`pi-models.ndjson`. For the relay: one config line
(`"nvidia": "https://integrate.api.nvidia.com/v1"`), caller-supplied key;
nvidia is pi-native, so it rides the reroute-only/relay-fallback tier.

## Proposed design: one multi-purpose extension per tool

**pi — `agentcontainer-relay` extension** (`~/.pi/agent/extensions/`):

1. `registerProvider("llama-swap", { baseUrl: llama-swap :8101/v1,
   refreshModels })` — live GGUF catalog **mirrored from `meta.llamaswap`**
   (see the caveat above: llama-swap stays the supervisor; the built-in
   pi `llama.cpp` router-mode extension is NOT used because it requires
   direct llama-server availability and filters out unloaded models).
   Replaces `model-010`.
2. Reroute-only overrides for pi-native providers
   (`registerProvider("openrouter", { baseUrl: relayBase + "/openrouter" })`
   style) — replaces `model-012`.
3. Direct→relay fallback **as runtime logic** instead of a generation-time
   probe cascade: register the provider with a fetch/stream wrapper that
   tries the direct endpoint and, on a network-class failure (dns/refused/
   tls/timeout — the taxonomy `llm-reverse-proxy`'s 502s already
   standardize), transparently retries against the relay path. Byte-for-byte
   passthrough is what makes this possible: only the base URL changes, no
   model-id renaming, no key injection (pi's own auth flows untouched).
   Fallback state is per-session (re-probe on next start) — fresh every run,
   instead of frozen at generation time.
4. cline-pass: **re-owned, not adopted** — see the trust classification:
   the third-party ClinePass extensions are reference material; the
   multi-purpose extension carries the `cline-pass` provider definition
   (auth flows ported per the reference sources, curated lineup from the
   live catalog). hyper: `charmbracelet/pi-hyper-provider` is adopted
   as-is (first-party vendor); the fallback layer only needs to override
   its `baseUrl` (supported: config applies above extension providers).

**opencode — one plugin in the clinepass-plugin shape:** `config` hook sets
`baseURL` per provider (direct, with relay as the decided-at-startup
alternative), reusing the plugin's own auth machinery for non-native
providers. Mid-session failover is weaker here (config is startup-time), but
per-run freshness is still a strict improvement over per-generation.

## What the extensions would delete (machinery inventory)

- `generate-cloud-pi-native-providers.mjs`, `generate-cloud-alternative-providers.mjs`,
  `generate-local-llama-swap.mjs`, `generate-opencode.jsonc.mjs`
- the `merge-models-json.mjs` layer contract (or reduce it to "static base +
  one thin layer for anything the extension cannot express")
- `list-providers.mjs` / `count-providers.mjs` reporting
- `lib/peer-probe.mjs`'s two-candidate probe cascade + hardcoded
  `DEFAULT_PEER_FALLBACK` (the peer base is vault-sourced: `PEER_BASE_URL`
  in infisical's /inference path, required at generation time — one
  definition, no second copy) and the `PEER_MODEL_FILTERS` env surface
- most of `run.sh`'s layer staging (one extension dir + auth.json instead)
- the generation-time reachability *decision* itself — the class of bug where
  a transient probe failure at generate time froze a wrong route into config
  until the next regeneration

**Stays:** `llm-reverse-proxy` (the runtime relay), llama-swap (runtime local
GGUF server), `lib/cloud-providers.mjs` (provider facts: ids/labels/base URLs
— now consumed by the extension's own config), models.dev catalog (opencode
reads it natively; pi providers use `refreshModels` live listings instead of
a generated lineup).

## Decisions taken (proposed, not yet implemented)

- Verify-first conclusion: **the extension route is viable and simpler** —
  every semantic the generators emulate (reroute-only override, live catalog,
  full custom provider, config-above-extension composition) is a documented,
  source-verified pi/opencode capability.
- **Trust-tiered adoption** (see the classification above):
  - `charmbracelet/pi-hyper-provider` is adopted as a dependency — first-party
    vendor extension, long-term trust warranted.
  - The third-party ClinePass extensions (`jellydn`, `tejasa97`, the
    `haconglinh1990` opencode plugin) are **reference material, not
    dependencies**: their credential-handling logic (WorkOS refresh,
    Cline-CLI credential extraction) is re-owned in the multi-purpose
    extension described below, using the current sources as the reference
    for the flows. They are never npm-installed into the container.
  - The multi-purpose extension therefore grows a `cline-pass` provider
    definition (auth + curated lineup) — the one piece the original plan
    delegated to community extensions. Model lineups still come from live
    `fetchModels` (the upstream catalog is the data, not the trust root), so
    the re-owned surface is auth plumbing + curation constants.
- **Local GGUF keeps llama-swap as the supervisor**; the extension-side
  replacement for `model-010` is a `meta.llamaswap`-mirroring
  `refreshModels` (option (b)), not the pi built-in router-mode extension
  (rejected: requires direct llama-server availability and filters unloaded
  models) and not a port of the probe+catalog mechanics (unnecessary: the
  metadata already flows through llama-swap's config.d).

## Decisions avoided

- **Not implementing in this pass.** The `coding-agent/` generators are being
  reworked by a parallel effort (provider targets moving to the relay);
  introducing the extension path mid-rework would create two competing
  routing mechanisms in one module. This note is the verification record;
  implementation should land as one coherent replacement commit *after* (or
  as part of) that rework, deleting the generators it replaces.
- **Not reimplementing WorkOS/OAuth or curated model lists** — that is
  exactly what the reference extensions maintain upstream.
- **Not relying on generation-time probing at all in the new design** — its
  staleness was the original motivation for the fallback logic; runtime
  fallback supersedes it rather than complementing it.

## Consequences

- If adopted: `lib/peer-probe.mjs` shrinks to its `useEnvProxy`/fetch-plumbing
  (or moves into the extension), `hyper-facts.mjs` loses its peer-listing
  role, and the coding-agent SPEC's "probe cascade" sections are replaced by
  an extension-spec section.
- The relay's role is unchanged and strengthened: it must keep being a
  byte-for-byte pipe with no key injection — that property is what lets the
  fallback be a base-URL swap.
