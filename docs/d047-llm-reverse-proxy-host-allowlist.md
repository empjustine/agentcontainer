---
id: d047
type: architecture-design
status: implemented
title: "d047 — llm-reverse-proxy v2: route by host allowlist, not provider slug"
parent: architecture
depends-on: [llm-reverse-proxy, lib, coding-agent, d038]
references: [d027, d038, d031, d040, d045]
tags: ["serving", "proxy", "routing", "host-allowlist"]
---

# d047 — llm-reverse-proxy v2: route by host allowlist, not provider slug

**Status:** implemented (main.go host mode + the `allowHosts` table in
`generate.mjs` + host-form `peerProviderUrl` in coding-agent/peer-probe.mjs
+ the v2 smoke section — 46 checks green)

## Problem

The current `llm-reverse-proxy` (docs/d027, d038) routes by **provider
slug**: `/<providerId>` → that provider's full real base URL. The deployed
table is the union of the pi-ai built-in registry, the models.dev catalog,
and catwalk — ~228 routes today, 200 distinct upstream hosts. Three failure
classes fall out of that design:

1. **The allowlist is inverted.** Every provider *slug* the three catalogs
   know is routable; only unknown *prefixes* are denied (a bare
   `404 page not found`). The proxy therefore forwards byte-for-byte to any
   host a catalog row names — including 164 hosts (of 200) this fleet would
   never touch, and any future catalog row the operator has not reviewed.
   That is a **host-level denylist with the wrong polarity**: the funnel
   edge accepts traffic to hosts the operator never intended to reach.

2. **Schema poisoning hit the fleet through a slug-routed listing.** The
   WSL2 `models.json` failure (docs/d046b; the
   `providers.openrouter.models.<0|5|10>.input.2 must be equal to constant`
   errors) was not a routing bug per se — it was a *live-listing content*
   bug: `piModel()` emitted `architecture.input_modalities`
   (`["text","image","video"]` …) verbatim, and strict consumers (cline)
   rejected the whole file. But the *surface* that delivered the bad
   listing was the slug-route probe (`<peerBase>/openrouter/models`). The
   fix landed in `coding-agent/gen-lib.mjs` (a `toInput()` guard). Host
   routing does not change which *listing data* flows, but it narrows what
   a probe can ever reach to the hosts the fleet actually defaults to, so a
   stray catalog row can never become a routable endpoint.

3. **Client divergence is per-host, not per-slug.** pi, opencode, and the
   vendor extensions disagree on how to address the *same* vendor
   (opencode speaks four dialects against two bases of `opencode.ai`;
   `open.bigmodel.cn` is zai *and* zhipu with three different path
   layouts; `api.minimax.io` is minimax and minimax-coding-plan at
   `/anthropic` vs `/anthropic/v1`). A slug-keyed table forces one URL per
   slug (the proxy strips the slug and single-joins), so every such
   divergence needs a second slug row and the clients must pick the right
   slug — the divergence is *encoded in the route namespace* instead of
   being handled by the client's own base URL.

A **host allowlist** (route by `Host`/upstream hostname, deny everything
else) is the v2 shape: only the hosts the operator's own stack defaults to
are reachable through the funnel edge; every other host — catalog-listed or
not — answers the funnel's plain `404 page not found` and costs the same
single non-distinctive body.

## Decision

### v2 routing: host-based, generated exactly like the slug table

Replace the deployed `llm-reverse-proxy.json` shape:

```jsonc
// v1 (today)
{ "listen": "0.0.0.0:8080",
  "providers": {
    "anthropic":       "https://api.anthropic.com",
    "cline-pass":      "https://api.cline.bot/api/v1",
    "llama-swap":      "http://127.0.0.1:8101",
    "models.dev":      "https://models.dev",
    "catwalk":         "https://catwalk.charm.land",
    "...":             "..."
  } }
```

```jsonc
// v2 (proposed)
{ "listen": "0.0.0.0:8080",
  "allowHosts": {
    "api.anthropic.com":   "https://api.anthropic.com",
    "api.cline.bot":       "https://api.cline.bot",      // HOST ROOT, not the base
    "opencode.ai":         "https://opencode.ai",        // one row for zen AND go
    "llama-swap":         "http://127.0.0.1:8101",     // loopback learner, named not host-keyed
    "models.dev":          "https://models.dev",
    "catwalk.charm.land":  "https://catwalk.charm.land",
    "...":                 "..."                        // the 36-row owner set
  } }
```

Semantics:

- A request is allowed iff the **upstream host it names** is in
  `allowHosts`: the first path segment is the destination host (a DNS name),
  or — the one exception — the stable logical route name `llama-swap` for
  the loopback learner (whose key is NOT `127.0.0.1:8101`; `peerProviderUrl`
  emits the same name). Everything after it is single-joined onto the
  configured **host root** (`scheme://host`). The value is deliberately NOT
  the full base URL: base PATHS belong to the client, which is what keeps
  multi-base hosts (`opencode.ai`'s zen vs zen/go, minimax's `/anthropic`
  variants) routable under ONE row — an allowlist value per host could only
  hold one of their bases (see `llm-reverse-proxy/DESIGN.md` § routing
  convention).
- Anything else — `/<unknown-host>/…`, `/<slug-like-unknown>/…`, `/`, a
  bare path — answers the identical funnel-style `404 page not found`
  (text/plain, nosniff, no URN, no provider enumeration; the anti-oracle
  contract is unchanged, docs/d027 § THE 404 POLICY).
- The **loopback learner** (the local llama-swap) is emitted as a
  first-class allowlisted entry under the stable route name `llama-swap`,
  value `http://127.0.0.1:8101` — the one row whose key is not its upstream
  host, kept as the hand-added convenience the catwalks will never carry
  (docs/d038's "hand-added entries" clause, now route-shaped).

The allowlist is the *defaults of the owner's stack* — pi-ai's routable
rows + the `lib/cloud-providers.mjs` fact table (the hand-added
cline-pass/hyper/inferx rows) + the llama-swap loopback + the two metadata
passthroughs — **36 allowlist rows** (verified: the generated table is
exactly 36; one is the `llama-swap` alias, the rest are hosts).
models.dev/catwalk rows do NOT contribute hosts: their bulk is exactly what
deny-by-absence must refuse (the v1 inverted-allowlist problem above). They
are still parsed, but only to log how many distinct hosts they would have
named (denied-by-absence visibility — a surprise there is a prompt to add a
deliberate allowlist row, never an automatic one).

Slugs that resolve to the same host (opencode/opencode-go/opencode-zen →
`opencode.ai`) collapse into one allowed host. The `smoke-test.sh` 404
camouflage checks gained a per-host negative (14 v2 checks; 46 total): every
non-allowlisted host, v1 slug form and garbage answers the identical
plain-text 404 and leaks no route table.

### Client divergence is handled per-client, not per-slug

The v2 proxy only ever needs to know the **host**; each client keeps its
own base-URL mapping (pi's built-ins, opencode's `npm`/`api` view, the
vendor extensions' `createProvider`), and each client's wire dialect and
path layout ride the byte-for-byte forwarding unchanged (that is the whole
point of the raw passthrough, docs/d027). The multi-slug hosts that needed
separate v1 rows — `opencode.ai`, `open.bigmodel.cn`, `api.minimax.io`,
`api.fireworks.ai`, `api.kimi.com`, `ai-gateway.vercel.sh`,
`api.together.xyz`, `api.cohere.com`, `api.perplexity.ai` — need **one**
allowlisted host each. The proxy removes the last reason the *route
namespace* had to encode per-client path prefixes; it is the client's own
base URL that decides, e.g., `api.minimax.io/anthropic` vs
`api.minimax.io/anthropic/v1`.

### 404 policy and RFC 9457 internals are unchanged

- The anti-oracle 404 (single non-distinctive body, no fingerprint) stays
  the answer for `/<unknown-host>/…` exactly as for `/<unknown-slug>/…`
  today.
- RFC 9457 problem details remain only for INTERNAL failures once the host
  IS allowlisted (DNS/TCP/TLS/upstream-disconnect on a configured upstream)
  — same taxonomy, same `Bad Gateway` 502s, same `details` dumps docs/d045.
- The proxy still performs **no credential handling, no model routing,
  byte-for-byte path forwarding**; `main.go`'s changes are confined to the
  config shape (`providers:` → `allowHosts:`) and the first-segment
  interpretation (`/<providerId>` → `/<host>`). The `stripPrefix` +
  `SetURL` mechanics (httputil.ReverseProxy rewrite) are reused verbatim,
  keyed by host instead of slug.

### Why host routing also hardens the schema-poisoning class

The WSL2 failure delivered bad *data* through a slug-route probe. v2 does
not filter listing payloads (it cannot — it never sees bodies), but it
removes the *reachability* half of the attack surface: a probe (or a client)
can only ever reach the hosts the operator allowlists. A catalog row for a
never-reviewed host no longer creates a routable endpoint at the funnel the
moment the catalog refreshes; adding a host is a deliberate allowlist edit,
reviewable in the same generated-diff as today's table. (The content bug
itself remains a coding-agent generator concern — fixed in
`coding-agent/gen-lib.mjs` with the `toInput()` guard that ships with this
record; see the bugfix record below.)

## Source-of-truth table

The allowlist derivation stays fully generated, exactly like d038:

| Source | Row type today (slug) | Row type in v2 (host) | Priority |
|---|---|---|---|
| pi-ai built-in registry (`llm-reverse-proxy/generate.mjs` `PI_AI_PROVIDERS; 31 routable) | `/<providerId>` | one host per winning URL | 1 (wins) |
| models.dev catalog + `AI_SDK_PACKAGE_ENDPOINTS` npm fallback | `/<providerId>` | one host per winning URL | 2 |
| catwalk (`lib/catwalk-facts.json`, `api_endpoint`) | `/<providerId>` | one host per winning URL | 3 |
| hand-added facts (`lib/cloud-providers.mjs` cline-pass/hyper/inferx) + `llama-swap` loopback + `models.dev`/`catwalk` passthroughs | hand-added rows | hand-added hosts | — |
| **operator overrides** | `providers:` hand edits | `allowHosts` hand edits (same file, same review) | — |

The drift checks (dead route warn for fact-table members missing from the
deployed table; deployed-vs-fact-table drift warn — d038's "Unchanged
contracts") are keyed by host in v2: a fact-table host missing from
`allowHosts` warns, a deployed host not in the fact table warns.

## Deployment

- **Rollout (as shipped):** v2 ONLY — `main.go` reads `allowHosts`
  exclusively (a `providers` key is ignored/unrecognized), and the
  generator emits `allowHosts` exclusively. No v1 compatibility window: a
  rolled host gets the new binary and the new config in the same tree
  pull, and any host still speaking `/<providerId>` slug addressing must
  regenerate its artifacts (the generators all emit host-form
  peerProviderUrl baseUrls in the same commit).
- **Migration check:** with the v2 config, `smoke-test.sh` must still pass
  its 32 checks (the local/refused/nxdomain/expired/… upstreams are all
  allowlisted hosts in the smoke config), plus a new negative: a request to
  a non-allowlisted host (e.g. `received.host.badssl.com`) answers the
  identical plain-text 404 body and leaks no hosts.
- **Generator-first:** the generator flips to v2 shape in the same commit
  as `main.go`; a stale v1-generated config on a rolled host still serves
  (v1 compatible), and the next `./generate.sh` replaces it — same
  safety as d027's generator-first migration.

## Consequences

- The deployed table shrinks from ~228 slug rows to 36 host rows; every
  diff is a host the operator actually defaults to, and every host that
  vanishes from the allowlist answers 404 — **deny-by-absence**, the
  polarity docs/d038 built by accident and v2 makes explicit.
- The route namespace stops encoding per-client path prefixes; clients
  address `<peerBase>/<host><full-upstream-base-path>`.
  `peerProviderUrl(peerBase, id)` in `lib/peer-probe.mjs` derives exactly
  that from the fact table (the same `baseUrl` the allowlist is generated
  from) — the generators' emitted `baseUrl` becomes
  `<peerBase>/api.cline.bot/api/v1` for cline-pass,
  `<peerBase>/llama-swap` for llama-swap, instead of
  `<peerBase>/<slug>`.
- The `models.dev` relay path (docs/d027b — `MODELS_DEV_RELAY_URL`,
  default `http://127.0.0.1:8080/models.dev/api.json`) becomes
  `http://127.0.0.1:8080/models.dev/api.json` under the same rule: the
  **host** `models.dev` is allowlisted, the path is intact.
- The 404-camouflage surface *grows*: unknown hosts now answer 404 rather
  than being routable — a strict improvement for the anti-oracle contract
  (docs/d027's funnel edge).
- The owner's allowlist is `lib/cloud-providers.mjs` + the fact table +
  the hand-added hosts; a *new* provider the operator adopts is a one-line
  host allowlist edit (plus its fact-table row) — no slug-namespace
  ceremony.

## Alternatives considered

- **Keep slug routing; prune the table to the owner set.** Same allowlist
  intent, but slugs keep double-encoding the client divergence (the `zai`
  vs `zhipu` vs `zai-coding-cn` problem stays), and a slug row still says
  nothing about *which host* it unlocks. Host routing is the minimal
  primitive the slug table was approximating.
- **Host header routing (SNI/VirtualHost).** The funnel already terminates
  at one peer base; letting clients set arbitrary `Host:` headers would
  hand the anti-oracle body a per-host oracle and breaks the loopback
  learners. The path-host form keeps one front and one 404.
