---
id: d033
type: architecture-design
status: active
title: "d033 — cloud/local generator cascade & emitted layer shapes"
parent: architecture
tags: ["generators", "cascade", "probing", "reachability"]
references: [d022, d024, d027]
depends-on: [coding-agent]
---

# d033 — Cloud/local generator cascade & emitted layer shapes

The three `coding-agent/` model generators
(`generate-local-llama-swap.mjs`, `generate-cloud-providers.mjs` —
the d037 merge of the former pi-native + alternative generators —
`generate-opencode.jsonc.mjs`)
share **one detection cascade**. This document is the single home for that
cascade and for the shape each generator emits. It exists because the same
"probe direct, else peer path-route, else emit nothing" narrative was pasted
into all four code headers (and partly into `coding-agent/peer-probe.mjs` and
`docs/d022`); those headers now point here. The WHY-level per-file facts that
only that file can justify (its merge semantic, provider quirks, field
mirrors) stay short in the headers.

Related: `coding-agent/peer-probe.mjs` owns the probe toolkit and the canonical
"reachable ≠ authenticated" wording; `coding-agent/merge-models-json.mjs` owns
the layered-`models.json` merge contract; `docs/d022` (peer-routing history),
`docs/d024` (generator split + shared fact table), `docs/d027` (path-prefix
cloud router).

## The reachability rule (reachable ≠ authenticated)

"Reachable" means the **network path works**, not that we hold credentials.

A 401/403 (or any other HTTP response) from an OpenAI-compatible `/models`
endpoint is what that endpoint returns to *any* unauthenticated request. The
generators legitimately run without provider keys — pi and opencode resolve
their own key / OAuth login at request time — so such a response proves
routing to the provider works and must **not** trigger a peer override.

Only the **total absence of an HTTP response** — DNS failure, connection
refused, TLS failure (a bogus certificate with verification ON dies *before*
any request byte, so a credentialed probe can never reach an impostor),
timeout —, or a **5xx server-error response** (the endpoint answered but says
it cannot serve right now: outage/overload) is evidence that the endpoint is
unusable from this host.

**Unverified TLS is not a valid reachability scenario.** With
`NODE_TLS_REJECT_UNAUTHORIZED=0` the handshake accepts any certificate, so an
https answer — and any credential sent with it — belongs to whoever terminated
the TLS, never the claimed host. Those probes **fail closed** (`tlsUnverifiable`
in `coding-agent/peer-probe.mjs`): no request is made (the provider key is
never handed to an impostor) and no https route is certified. Plain-**http**
peers remain usable as the operator's explicit emergency choice — there is no
TLS to verify, and the plaintext-credential risk is theirs to accept.

Routing a layer at a dead/unverifiable URL just ships errors, so these fall
into the same peer-fallback bucket; the peer path-routes already refuse
502/504 the same way (`DEAD_ROUTE_STATUSES` in `coding-agent/peer-probe.mjs`).
The cascade self-heals: the next generation run re-probes and returns to
direct once the provider answers 2xx again.

## Detection cascade

Per provider, independently, direct-first and lazy — unless **`PEERS_ONLY=1`**:
the operator declares this host reaches cloud providers only through the peer
funnel, so the generators skip step 1 (the direct cloud probe, a full 8s
timeout per provider on a blocked host) and go straight to step 2. Layers are
emitted in peer mode for every provider; direct mode's live-lineup sync and
live-only appends are never taken (docs/d033's full-row section). On a healthy
host this knob costs nothing but route variance; it exists for the hosts the
peer exists for (measured: ~26s → ~2s on a blocked-cloud host). It is the
GENERATION-side counterpart of the archived serving-side PEERS_ONLY
(docs/archive/peer-variant-work.md). Env is forwarded into the container by
`coding-agent/run.sh`'s workload env allowlist.

1. **Probe the real endpoint** (the provider's fact-table `baseUrl`).
   Reachable ⇒ use the built-in routing (pi-native / opencode-native) or emit
   the real `baseUrl` (non-native providers). Nothing about credentials
   changes this step.
2. **Unreachable ⇒ probe the provider's peer path-route** on the simplified
   cloud router (`llm-reverse-proxy`): `<peerBase>/<providerId>`, where
   `peerBase` candidates are vault-sourced (`coding-agent/peer-probe.mjs peerBaseUrls()`,
   `PEER_BASE_URLS`; `peerBaseUrl()` returns the first — docs/d034). Peer
   routes are probed in candidate order until one is usable. The route
   forwards `<route>/…` byte-for-byte to the provider's FULL real base URL —
   no model-id magic, no key injection (`docs/d027`). Usable ⇒ reroute the
   provider through the route.
3. **Neither usable ⇒ emit nothing** for that provider and leave any existing
   layer untouched (the provider is genuinely unreachable from this host).

The peer is probed **per provider and lazily**: when every direct endpoint is
reachable, no peer route is probed at all, so no request is spent and no
401/403 noise is logged.

Both probe phases run their providers **concurrently** (`Promise.allSettled`:
direct first, then only the unreachable providers), so N providers cost one
probe timeout instead of N; the multi-hop candidate chain itself is walked
sequentially per provider, in order (docs/d034).

### Peer-route probe specifics

`coding-agent/peer-probe.mjs probePeerRoute` applies the reachability rule with three
"the response did not come from the provider" exceptions, which are **not**
usable:

- **404** — the funnel's default-404 (llama-swap answering an unmanaged
  prefix) and `llm-reverse-proxy`'s unknown-provider problem detail both look
  like this; a route that 404s on `/models` cannot be trusted to deliver.
- **502** — `llm-reverse-proxy`'s own RFC 9457 problem detail: the
  proxy→upstream leg failed (the provider was not reached).
- **504** — the same leg timed out.

Every other status (401/403 credential gates, or any other provider answer)
is usable: the route delivered to the real endpoint.

## What each generator emits

| Generator | Layer | Semantic | Subset |
|---|---|---|---|
| `generate-local-llama-swap.mjs` | `model-010-local-default.json` | **ADDS** the `llama-swap` provider (pi has no native one) | local GGUF models |
| `generate-cloud-providers.mjs` (override-only rows) | `model-012-cloud-pi-native.json` | **override-ONLY** (peer reroutes for unreachable endpoints, minimal
  models.dev ∪ catwalk id merges otherwise) | openrouter / opencode / opencode-go / mistral / google / nvidia |
| `generate-cloud-providers.mjs` (full rows) | `model-015/016/017-*.json` | **AUTHORITATIVE full block** (pi has no native provider for any of them) | cline-pass / hyper / inferx |
| `generate-opencode.jsonc.mjs` | `opencode.jsonc` (opencode V1 schema) | same cascade, opencode's provider subset | opencode / opencode-go / openrouter + local GGUF |

Merge order and semantics are owned by `coding-agent/merge-models-json.mjs`.

### `generate-local-llama-swap.mjs`

- Probes the vault-sourced peer base as the llama-swap path-route
  `peerProviderUrl(base, "llama-swap")`; `llm-reverse-proxy` (host port 8080,
  the funnel front) strips the prefix and forwards to the local instance on
  loopback `:8101`. First candidate serving GGUF models wins.
- Emits ONE `llama-swap` provider. `baseUrl` is a **literal** URL resolved at
  generation time (pi does not expand `${vars}` in `baseUrl`) normalized to
  `/v1`; `api` is `openai-completions`.
- `models` are full pi-shaped entries, deduplicated by id, order preserved,
  and **all** listed (`loaded` and `unloaded`) because llama-swap swaps models
  on demand. Per-model metadata mirrors llama-swap's `meta.llamaswap`
  (already pi-shaped: `reasoning`, `input`, `contextWindow`, `maxTokens`,
  `cost`); older builds fall back to the OpenAI-ish top-level fields
  (`context_length`, `architecture.input_modalities`, `capabilities.vision`).
  `name` is derived from the id (`<repo-basename> <quant>`) for display.

### `generate-cloud-providers.mjs` — override-only rows

- pi ships openrouter / opencode / opencode-go / mistral / google / nvidia
  natively, so a reachable real endpoint keeps the built-in routing and
  emits a **minimal id merge** (fact-table base URL — identical to the
  built-in, so the built-in dialect and auth carry over — plus the models.dev
  ∪ catwalk id list as bare records; pi replaces matching built-in ids and
  adds the rest, the built-in lineup is never pruned); an unreachable one
  emits a **reroute-only** override (`baseUrl` = `<peerBase>/<providerId>`, **no**
  `apiKey` — the proxy forwards pi's own built-in auth untouched, **no**
  `api`/`compat` — pi's built-in provider definition supplies the dialect;
  the gen-lib `providerReroute` (folded from the former lib/pi-models.mjs, docs/d039)).
- Override model list, by source priority:
  1. the peer route's live `/models` listing (bare provider-native ids),
     scoped by `PEER_MODEL_FILTERS`;
  2. when the route proved usable but could not list (401/403 without a key,
     or an unexpected answer), the vendored models.dev catalog (same filters);
  3. when the vendored catalog is unreadable or has no usable slice, Charm's
     catwalk catalog (same filters; docs/d028) — it covers only
     openrouter / opencode-zen / opencode-go / gemini, so nvidia and mistral
     fall through to "no list".
- `catalogOnly` (google, and any future provider whose listing the probe
  cannot authenticate): google's `/v1beta/models` reads an api-key parameter,
  not the bearer header the probe sends, so the probe verdict is a permanent
  misleading 403 "credential-gated" — and the peer cascade cannot prove a
  google route either (it proves routes via the same unauthenticatable
  listing), so google could never reroute in the first place. The row emits
  the minimal catalog override straight from the models.dev google slice
  (the `?type=all` payload the refresh pins), no probes at all, and the
  catwalk union is skipped — models.dev is the sole lineup source.
- `PEER_MODEL_FILTERS` are the fleet's usable slices — the llama-swap era
  encoded them on the **serving** side; with per-provider routing the client
  scopes its own override:
  - `openrouter`: the `:free` slice.
  - `mistral`: chat-capable only (`mistral-embed`, `voxtral-*-tts` dropped).
  - `google`: a MODALITY allowlist over the models.dev records, not a name
    denylist: pi drives text chat (its own input schema is text+image), so a
    model stays iff it takes text in and produces text out. One rule drops
    every non-chat category at once — imagen/veo/lyria/tts/live/omni/image
    output (their output modality is not `["text"]`) and the audio-only
    live-translate — plus one name check the records cannot express
    (models.dev labels the embedding endpoints out `["text"]`, so
    `/embedding/` is refused first). The two gemma entries are text-in
    text-out chat on the same API and pass; the pre-catalogOnly name regex
    (`^gemini-`) excluded them by accident. No record (the live-listing
    path, unreachable for a catalogOnly row) falls back to the old regex.

### `generate-cloud-providers.mjs` — full rows

Table-driven (`PROVIDER_SPECS`: one row = one emitted layer). All three serve
every model over a single OpenAI-compatible Chat Completions endpoint
(`api: "openai-completions"`), so one provider block covers all models per
provider — no per-model API divergence.

Every emitted block carries:

- `baseUrl`: the provider's `api` (direct) or `<peerBase>/<id>` (peer);
- `apiKey`: `"$<envKey>"` (auth presence gates model availability; read here
  only for the direct probe — pi resolves it at request time);
- `authHeader: true` (`Authorization: Bearer`);
- per-model `thinkingLevelMap` derived from models.dev `reasoning_options`
  effort values (mapped through `EFFORT_TO_PI`).

Provider-specific mirrors:

- **cline-pass** (`model-015`): `compat.supportsDeveloperRole: false` —
  ClinePass rejects the `developer` role pi-ai emits for reasoning models
  (both reference extensions force it off; without it reasoning models 400).
- **hyper** (`model-016`): provider-level compat is null (the vendor
  extension accepts the default role handling). Every model mirrors
  `charmbracelet/pi-hyper-provider` `src/models.ts`:
  `supportsStore: false`, `maxTokensField: "max_tokens"`,
  `thinkingFormat: "deepseek"`, `supportsReasoningEffort: <bool>` (true only
  when the model exposes a reasoning-effort enum). Effort-less reasoning
  models (`glm-5`, `kimi-k2-thinking`, …) get the extension's
  `ON_OFF_THINKING_LEVEL_MAP` (`off: "off"`, `max: "max"`, rest null — pi
  "max" is the single representative "on" state), which only makes sense with
  the deepseek format: "off" → thinking disabled, any other level → enabled,
  no effort value sent. A static `User-Agent` mirrors the extension's
  `pi-hyper-provider/<version>` (the versioned UA is extension-only).
- **inferx** (`model-017`): standard `@ai-sdk/openai-compatible` gateway, no
  developer-role quirk, no per-model wire-compat mirror, no effort enums —
  its reasoning models expose only a `toggle`, which pi's default on/off
  handling already covers. No `thinkingLevelMap` is emitted.

**Hyper facts cache** (`coding-agent/hyper-facts.mjs`, docs/d039): hyper is the one provider here
whose own live `/provider` catalog beats the models.dev snapshot per field
(live reasoning flags, attachment support, per-model cached-input/output
prices, effort enums) and pi has no built-in hyper, so the emitted layer is
the only metadata pi ever sees. Direct mode refreshes the cache and enriches
every model from it. Peer mode (where `hyper.charm.land` itself is
unreachable) first tries the same refresh over the multi-hop peer candidates,
then consumes the last good cache stale-tolerantly (docs/d034). Enrichment is a narrow per-field
whitelist (`reasoning`, `input`, costs incl. cached-in/out, limits,
`thinkingLevelMap`, `compat.supportsReasoningEffort`); display names stay
models.dev (more descriptive); the wire compat block and the route are never
touched. Matched records are rebuilt through `piModel()` so the effort →
map/compat derivation runs on live data.

**Known models.dev ↔ Hyper `/provider` drift** (verified 2026-09): a few
reasoning flags and image-input claims disagree (e.g. `minimax-m2.7` reasoning
true in the catalog, `can_reason` false live; several kimi/glm/qwen models
carry catalog image input that live `supports_attachments` denies), cache
prices sit in different catalog slots per model, and the live-only model
`deepseek-v4.1-flash` is absent. The generator stays catalog-driven (the
vendored catalog refreshes best-effort each run); install the vendor extension
for Hyper's own live view.

**Extension-only ClinePass features** models.json cannot replicate (use
`pi install git:github.com/jellydn/pi-clinepass-provider`): WorkOS device-code
OAuth reuse (`models.json oauth` only supports "radius"), Cline prompt-cache
`compat` + `before_provider_request` normalization, and the 403 subscription
error surface via a `message_end` handler.

### `generate-opencode.jsonc.mjs`

opencode's counterpart to the pi-native generator: same cascade, its provider
subset from the shared fact table (opencode / opencode-go / openrouter; no
cline-pass or hyper built-ins), opencode's output schema.

- opencode V1 config: the provider map lives under the top-level key
  `provider` (**singular**) — `providers` is a V2 key the V1 loader rejects.
- In peer mode the provider's base URL is `<peerBase>/<providerId>` and the
  model ids are the provider's own bare ids. Auth is the provider's **real**
  key env (forwarded untouched by the proxy) — the old `PEER_API_KEY`
  gateway-bearer scheme belonged to llama-swap key injection.
- Local GGUF: emits an openai-compatible provider for the models behind the
  `<base>/llama-swap` route (the local instance's `/v1` surface and model-id
  routing are unchanged; `<peerBase>/llama-swap/v1` is forwarded to the local
  `/v1/…`).

## Usage

All four generators share the same invocation shape: `node <script> [out]`,
writing next to the script by default (the `generate.sh` scratch dir on
container/host runs), honoring `DRY_RUN=1` (preview only) via
`lib/artifact.mjs`. `coding-agent/generate.sh` runs them in layer order and
then `merge-models-json.mjs`. Environment: `PEER_BASE_URLS` / `PEER_BASE_URL` (the peer base chain,
vault-sourced; docs/d034), `PEER_API_KEY` (local GGUF bearer), each provider's own key
env (direct and peer-route probes only), `MODELS_DEV_JSON` (catalog path
override), `PI_MODELS_JSON` (output override), `HYPER_FACTS_JSON` (cache path
override), `PEERS_ONLY` (skip the direct probes, every provider goes straight
to the peer path-route cascade — see the cascade section above).
