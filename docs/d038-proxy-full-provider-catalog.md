---
id: d038
type: architecture-design
status: implemented
title: "d038 — llm-reverse-proxy routes the full three-source provider catalog"
parent: architecture
references:
  - d027
  - d024
  - d033
  - d028
depends-on:
  - llm-reverse-proxy
---

# d038 — llm-reverse-proxy routes the full three-source provider catalog

**Status:** implemented

## Problem

The deployed `llm-reverse-proxy.json` routes only the nine providers in
`lib/cloud-providers.mjs` plus three static passthroughs. Everything else the
three client ecosystems support — pi-coding-agent's (pi-ai) built-in
providers, the ai-sdk/models.dev catalog (opencode's source), and crush's
catwalk catalog — is unrouted: any of those clients riding the peer can only
reach nine endpoints.

## Decision

The routing table becomes the **union of three sources, keyed by provider
name**, merged with an explicit priority:

1. **pi-ai** — vendored `lib/pi-ai-providers.mjs`, extracted from the
   installed pi's built-in provider registry. Only providers with a stable,
   account-independent HTTPS base URL are routable. Deliberately skipped
   (documented in the table): SigV4/per-region endpoints
   (amazon-bedrock), per-project endpoints (google-vertex), per-resource /
   per-account endpoints (azure, azure-openai-responses, cloudflare
   gateways), subscription OAuth gateways without a public stable base
   (openai-codex, github-copilot, radius), and the faux test provider.
2. **models.dev (ai-sdk)** — the vendored + best-effort refreshed
   `lib/models.dev.api.json`; a provider's `api` field IS its base URL.
   Records without `api` fall back to a vendored ai-sdk-package → endpoint
   map (only packages with a canonical public endpoint); account-scoped
   packages (azure, bedrock, vertex, watsonx, sap, …) are skipped.
3. **catwalk (crush)** — the vendored + refreshable `lib/catwalk-facts.json`;
   each provider carries `api_endpoint`.

**Clash rules (as decided):**

- Same provider **name** in several sources ⇒ the higher-priority source's
  endpoint wins: **pi-ai > models.dev > catwalk**. Every override is logged
  (which source won, what it replaced) so priority decisions are visible.
- Different **names** for the same vendor ⇒ both names are served
  (e.g. pi's `together` and models.dev's `togetherai`, catwalk's
  `opencode-zen` and pi's `opencode`, catwalk's `moonshot` and pi's
  `moonshotai` each get their own route at their own endpoint). The route
  namespace is per-source-name, and clients use their own names.

Current run: ~220 routes (31 pi-ai, ~196 models.dev + npm fallback, ~34
catwalk), 8 priority overrules logged, ~24 skipped rows — each skip is a
documented reason (env-placeholder, per-account, per-region, or an unmapped
npm package), never a silent omission.

## Unchanged contracts

- The proxy remains a dumb faithful forwarder: no credential handling, no
  model routing, byte-for-byte path joining (docs/d027).
- `lib/cloud-providers.mjs` stays the drift reference for its nine ids — a
  deployed entry that differs from the fact table still warns (its ids now
  typically resolve through pi-ai/models.dev rows, which must agree).
- The local `llama-swap` peer entry and the `models.dev`/`catwalk` metadata
  passthroughs stay in the table, appended after the catalog-derived routes.

## Why vendored tables instead of generation-time scraping

Same lifecycle as every other catalog in this repo (docs/d027b, d033):
vendored copy is the floor, a best-effort refresher keeps it current, and a
failed refresh never touches the last good copy. Scraping pi's binary or the
ai-sdk packages' source at generation time would make the routing table
non-reviewable and version-dependent for no accuracy gain — the sets move
slowly and a stale row is a warn, not a wrong route.

## Files

- **d039 folded both tables into `generate-config.mjs`** (sole consumer);
  the paths below describe their authoring location.
- `lib/pi-ai-providers.mjs` — NEW vendored pi-ai fact table (extracted from
  the installed pi 0.85.1 registry)
- `lib/ai-sdk-package-endpoints.mjs` — NEW vendored npm-package → endpoint
  map for models.dev records without `api`
- `llm-reverse-proxy/generate-config.mjs` — builds the union table with the
  priority merge + per-source diagnostics
- `llm-reverse-proxy/llm-reverse-proxy.json` — regenerated
