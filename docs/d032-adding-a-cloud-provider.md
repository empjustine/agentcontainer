---
id: d032
type: decision
status: implemented
title: "Adding a cloud provider — the flow and its surprises (worked example: inferx)"
parent: architecture
depends-on:
  - d024
  - d027
references:
  - d022
  - d028
  - environments
tags:
  - coding-agent
  - llm-reverse-proxy
  - generators
  - models-dev
---

# d032 — Adding a cloud provider: the flow and its surprises

Worked example: **InferX** (`https://model.inferx.net/endpoints/v1`, key
`$INFERX_API_KEY`), added as alternative-provider layer `model-017` and proxy
route `/inferx`. This doc records what the addition actually touched — and,
more usefully, the places it *surprisingly* did and did not need to touch, so
the next provider is a checklist instead of an archaeology dig.

## The two sources of truth a new provider lives in

| Source | Owns | Consumers |
|---|---|---|
| vendored models.dev catalog (`lib/models.dev.api.json`) | model lineup, capabilities, prices, `api` endpoint, `env` key name | `generate-cloud-alternative-providers.mjs` (client layer, one file per `PROVIDER_SPECS` row) |
| cloud provider fact table (`lib/cloud-providers.mjs`) | peer id, label, `apiKeyEnv`, real `baseUrl` | `llm-reverse-proxy/generate-config.mjs` (routes), `generate-cloud-pi-native-providers.mjs` (pi-native subset), `generate-opencode.jsonc.mjs` (opencode subset), `lib/hyper-facts.mjs` (`.hyper` only) |

A provider pi does NOT ship natively (d022 semantics: the alternative layer is
the authoritative full block) therefore needs **one row in each source** plus
the merge-order/doc updates. That is the entire flow:

1. **Catalog row** — must already exist upstream at models.dev (see finding
   F1); no repo edit. Provides `api`, `env`, and every model record.
2. **`PROVIDER_SPECS` row** in `generate-cloud-alternative-providers.mjs`
   (id, name, `model-0XX` filename, `envKey`, compat trio). For a plain
   OpenAI-compatible gateway this is `compat: null, modelCompat: null,
   onOffThinking: false` — see F7.
3. **Fact-table row** in `lib/cloud-providers.mjs` (id, label, `apiKeyEnv`,
   `baseUrl`). Rerun `llm-reverse-proxy/generate-config.mjs` → the
   `<peerBase>/<id>` route exists; zero proxy code (F4).
4. **Key forwarding** — add the key var to the allowlist loop in
   `coding-agent/run.sh` (F6).
5. **Doc sync** — `merge-models-json.mjs` header table + merge-order diagram,
   `coding-agent/SPEC.md`, `coding-agent/generate.sh` prose,
   `llm-reverse-proxy/README.md` example (F8).

## Surprising findings

### F1 — a provider models.dev does not know cannot ride this flow at all

The vendored catalog is **regenerated wholesale** by
`lib/refresh-models-dev.mjs` (direct `https://models.dev/api.json`, relay
fallback per d027-models-dev-relay-fallback) and replaces
`lib/models.dev.api.json` atomically on every best-effort refresh. A
hand-added catalog row is therefore **transient** — silently gone after the
next refresh. The alternative-provider generator's `loadProvider()` throws on
a missing catalog row, so an upstream-unknown provider fails the layer rather
than emitting an empty one. InferX worked only because models.dev already
listed it. Upstream contribution (or a new facts-cache module like
`lib/hyper-facts.mjs`, the one sanctioned non-models.dev enrichment source) is
the only durable path for a provider absent from models.dev.

### F2 — the fact table is NOT the client-side source of truth

`generate-cloud-alternative-providers.mjs` reads provider facts (endpoint,
key env) from the **catalog**, not from `lib/cloud-providers.mjs`. The
`baseUrl`/`apiKeyEnv` pair therefore exists in **both** files for every
OpenAI-compatible provider, kept in sync by convention only. The only drift
check in the repo compares the fact table against the *deployed proxy config*
(`generate-config.mjs`'s summary) — never fact table vs catalog. Today they
agree for all seven catalog-syncable rows (openrouter, opencode, opencode-go,
cline-pass, hyper, inferx, nvidia); a catalog `api` change would have to be
mirrored into the fact table by hand. A cheap follow-up: a lint that diffs
`CLOUD_PROVIDERS` against the catalog's `api`/`env` for every row the catalog
knows.

### F3 — "drift" against the catalog is sometimes by design

Two fact-table rows have **no** catalog `api` to drift from: `mistral` and
`google` are SDK-native in models.dev (`npm: "@ai-sdk/mistral"`,
`@ai-sdk/google`) — the catalog deliberately omits `api` because the SDK
carries the endpoint, and both speak non-OpenAI wire dialects. The fact table
is the *only* place their base URLs exist. Related: the catalog's `env` for
google lists three names (`GOOGLE_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`); the fact table picks
`GEMINI_API_KEY` because that is what `coding-agent/run.sh` forwards. Any
naive "sync check" per F2 must whitelist both patterns, not flag them.

### F4 — the proxy needs zero code; the route is a data row

`llm-reverse-proxy/main.go` is a fully generic config-driven StripPrefix
reverse proxy — a new provider's route exists the moment
`generate-config.mjs` reruns with the new fact-table row. Nothing in the
binary, the smoke test (own throwaway config), or `peer-probe.mjs` is
provider-aware. Verified end-to-end: the freshly generated `/inferx` route
forwarded the upstream's 401 body byte-for-byte.

### F5 — route paths: the base includes the path suffix

The fact-table `baseUrl` is the provider's FULL real base (d027), path
suffixes included — `…/endpoints/v1`, `…/api/v1`, `…/zen/go/v1`. The proxy
strips only `/<providerId>`, so the client path after the prefix must **omit
the version segment**: `<peerBase>/inferx/models`, NOT
`<peerBase>/inferx/v1/models` (the latter 404s — the first manual probe
attempt made exactly this mistake). The generators get this right because
`probePeerRoutes` probes `<peerBase>/<id>/models` against the same
full-base convention.

### F6 — the key must clear a THIRD allowlist: `coding-agent/run.sh`

A provider's key env var name appears in **four** convention-linked places:
catalog `env`, fact-table `apiKeyEnv`, the generator spec's `envKey`, and the
hardcoded forwarding loop in `coding-agent/run.sh`. The vault loader
(`lib/environment.sh`) injects the whole vault round-trip unfiltered — the
filter is only in run.sh. Missing the run.sh row is silent: the layer
references `$INFERX_API_KEY`, the probe passes (it runs host-side, where the
vault set the var), and pi inside the container still never sees the key.
This was initially missed for inferx; fixed by adding it to the loop.

### F7 — a plain gateway needs no per-model machinery at all

models.dev `reasoning_options` can be `{"type": "toggle"}` (no effort enum) —
InferX's reasoning models are all toggle-shaped. The effort-enum machinery
(`EFFORT_TO_PI`, `buildThinkingLevelMap`, the hyper ON_OFF fallback) then
correctly produces *nothing*: no `thinkingLevelMap`, no compat overrides, pi's
default on/off thinking handling covers the model. Do not assume a new
provider needs a compat block or a thinking map — the cline-pass
(`supportsDeveloperRole: false`) and hyper (per-model wire-compat mirror +
deepseek thinking format) rows are the exceptions, not the template.

### F8 — layer numbering is a cross-file contract documented in four places

The `model-0XX` zero-padded prefix IS the merge order
(`merge-models-json.mjs` merges in lexical filename order). Gaps are fine
(010, 012, 015, 016, 017, …); the next free slot after the last alternative
layer is the choice point. But the numbering is restated in prose in
`merge-models-json.mjs`'s header table and diagram, `coding-agent/generate.sh`
comments, and `coding-agent/SPEC.md` — all four need the same edit or the
docs drift from the contract.

### F9 — adding a fact-table row changes nothing client-side by itself

Every fact-table consumer subsets the table explicitly:
`PI_NATIVE_CLOUD_IDS` (pi-native generator), a hardcoded id list (opencode
generator), `.hyper` (hyper-facts). A new row therefore cannot leak into any
client config — verified by regenerating `model-012-cloud-pi-native.json` and
`opencode.jsonc` after the inferx row landed: both byte-identical. The flip
side: the fact-table row alone provides only the proxy route; client support
is always an explicit opt-in (the `PROVIDER_SPECS` row, F2's split).

## Verification record (inferx, 2026-09)

- `generate-cloud-alternative-providers.mjs`: inferx direct probe → 401
  (`auth` outcome = reachable, F5's network-path rule) → `model-017` emitted,
  12 catalog models.
- Proxy: route loaded (`/inferx/ → https://model.inferx.net/endpoints/v1`);
  `GET /inferx/models` → 401 with InferX's own `no tenant context` body;
  `POST /inferx/chat/completions` → 401 (passthrough intact).
- `probePeerRoutes` against the running proxy → `http://…/inferx` — peer-mode
  fallback for the generator works with no generator change (F4/F5).
- Merge: `inferx` appears in the merged models.json alongside cline-pass and
  hyper; pi-native and opencode layers unchanged (F9).
