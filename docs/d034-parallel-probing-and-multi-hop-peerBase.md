---
id: d034
type: architecture-design
status: implemented
title: "d034 — parallel probing and multi-hop peerBase chains"
parent: architecture
depends-on:
  - lib
  - coding-agent
references:
  - d024
  - d027b
---

# d034 — Parallel probing and multi-hop peerBase chains

**Status:** implemented
**Date:** 2026-09-13
**Owner:** pi-coding-agent fleet

## Summary

Two changes to reduce unnecessary critical path generator latency:

1. **Parallel probing:** All provider reachability probes (direct and peer) fire concurrently via `Promise.allSettled` instead of sequentially.
2. **Multi-hop peerBase chains:** `PEER_BASE_URLS` (comma or newline delimited) lets generators try up to N reverse proxy deployments in sequence before declaring a provider route-less.

## Motivation

### Sequential probing latency

Before this change, each generator probed providers one at a time:

```
generate-cloud-pi-native-providers.mjs:
  probeDirect(openrouter)    → 8s
  probeDirect(opencode)      → 8s
  probeDirect(opencode-go)   → 8s
  probeDirect(mistral)       → 8s
  probeDirect(google)        → 8s
  probeDirect(nvidia)        → 8s
  Total: ~48s worst case (all unreachable)
```

Each probe is I/O-bound with an 8s timeout. Running them sequentially means N × 8s.

### Single peerBase

Before this change, `PEER_BASE_URL` was a single vault-sourced URL. If that proxy was down or misrouted, the provider was declared route-less immediately. There was no fallback chain.

## Changes

### 1. `lib/peer-probe.mjs` — `peerBaseUrls()`

```javascript
// New function alongside peerBaseUrl()
export function peerBaseUrls() {
  const raw = process.env.PEER_BASE_URLS || process.env.PEER_BASE_URL || "";
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}
```

- Reads `PEER_BASE_URLS` first, falls back to `PEER_BASE_URL` as a single-entry list.
- `peerBaseUrl()` now delegates to `peerBaseUrls()[0]` (backward compat).
- Supports comma and newline delimiters for vault-friendly multi-value injection.

### 2. `CLOUD_PEER_CANDIDATES` in all generators

```javascript
// Before:
const CLOUD_PEER_CANDIDATES = [peerBaseUrl()];

// After:
const CLOUD_PEER_CANDIDATES = peerBaseUrls();
```

`probePeerRoutes()` already accepted a `candidates[]` array and probed them sequentially. This change populates that array from the multi-hop chain.

`generate-local-llama-swap.mjs` intentionally stays on the single
`peerBaseUrl()`: there is exactly one serving host behind the `/llama-swap`
route, so a chain adds nothing there. `lib/hyper-facts.mjs` walks the same
multi-hop chain for its own peer fallback (`refreshHyperFacts`), since the
facts fetch is just another peer-route consumer.

### 3. Parallel probing in `generate-cloud-pi-native-providers.mjs`

```javascript
// Phase 1: parallel direct probes
const directResults = await Promise.allSettled(
  PI_NATIVE_CLOUD_IDS.map((id) =>
    probeDirect(
      CLOUD_PROVIDER_FACTS[id].baseUrl,
      bearerHeaders(process.env[CLOUD_PROVIDER_FACTS[id].apiKeyEnv]?.trim()),
    ).then(
      (r) => ({ id, ...r }),
      (err) => ({ id, result: "unreachable", error: String(err) }),
    ),
  ),
);

// Phase 2: parallel peer path-route probes
const peerResults = await Promise.allSettled(
  needsPeer.map((id) =>
    probePeerRoutes(
      CLOUD_PEER_CANDIDATES,
      id,
      bearerHeaders(process.env[CLOUD_PROVIDER_FACTS[id].apiKeyEnv]?.trim()),
    ).then((r) => (r ? { id, route: r } : { id, route: null })),
  ),
);
```

### 4. Parallel probing in `generate-cloud-alternative-providers.mjs`

```javascript
// Before:
for (const spec of PROVIDER_SPECS) {
  await emitProvider(spec);
}

// After:
await Promise.allSettled(PROVIDER_SPECS.map((spec) => emitProvider(spec)));
```

Each `emitProvider()` is self-contained (catalog load → direct probe → peer route → facts enrichment), making parallel execution safe.

### 5. Parallel probing in `generate-opencode.jsonc.mjs`

```javascript
// Phase 1: parallel cloud direct probes
const cloudResults = await Promise.allSettled(
  Object.entries(CLOUD_PROVIDERS).map(([id, cfg]) =>
    probeDirect(cfg.baseUrl, bearerHeaders(process.env[cfg.apiKeyEnv]?.trim()))
      .then((r) => ({ id, ...r })),
  ),
);

// Phase 2: parallel peer path-route probes
const peerResults = await Promise.allSettled(
  needsPeer.map((id) =>
    probePeerRoutes(
      CLOUD_PEER_CANDIDATES,
      id,
      bearerHeaders(process.env[CLOUD_PROVIDERS[id].apiKeyEnv]?.trim()),
    ).then((r) => (r ? { id, route: r } : { id, route: null })),
  ),
);

// LOCAL_SOURCE_CANDIDATES derived from CLOUD_PEER_CANDIDATES
const LOCAL_SOURCE_CANDIDATES = CLOUD_PEER_CANDIDATES.map((base) =>
  peerProviderUrl(base, "llama-swap"),
);
```

## Behavior with multi-hop proxy chains

With `PEER_BASE_URLS` set to four proxy deployments:

```
Proxy A: https://proxy-a.tailscale.net:8080
Proxy B: https://proxy-b.tailscale.net:8080
Proxy C: https://proxy-c.tailscale.net:8080
Proxy D: https://proxy-d.tailscale.net:8080
```

A provider like `openrouter` is probed:

```
1. Direct:  https://openrouter.ai/api/v1/models  → 403 (auth, keep built-in) ✓

OR

2. Direct:  timeout → unreachable
   Proxy A: https://proxy-a:8080/openrouter/models → 200 w/ models ✓

OR

3. Direct:  timeout → unreachable
   Proxy A: 404
   Proxy B: timeout
   Proxy C: 502
   Proxy D: 200 w/ models ✓

OR

4. Direct:  timeout → unreachable
   Proxy A: 404
   Proxy B: timeout
   Proxy C: 502
   Proxy D: 404
   → fall back to models.dev catalog
```

Each proxy probe has an 8s timeout. With 4 proxies, worst-case per-provider probe chain is ~32s (sequential within `probePeerRoutes`), but since all providers probe in parallel, the overall wall-clock time is ~32s (vs ~192s sequential).

## Latency impact

| Scenario | Before | After |
|----------|--------|-------|
| All providers reachable | ~8s (first probe answers) | ~8s (all fire, first answer wins) |
| All providers unreachable + no proxies | ~48s (6 × 8s direct) | ~8s (all direct probes fire concurrently) |
| All providers unreachable + 1 proxy | ~56s (6 × 8s direct + 6 × 8s peer) | ~16s (8s direct + 8s peer, both parallel) |
| All providers unreachable + 4 proxies | ~288s (6 × 8s × 6 probes) | ~40s (8s direct + 32s peer chain, both parallel) |

## Caveats

### Opencode / Opencode-Go overlap

Opencode (`opencode`) and opencode-go (`opencode-go`) share the same upstream (`opencode.ai/zen`) and same API key. When both are unreachable, parallel probing fires two redundant direct probes and two redundant peer probe chains. This is harmless — both resolve to the same provider — but adds ~2x the network chatter for that pair.

### OOM risk with many providers

`Promise.allSettled` fires all promises concurrently. Node.js handles this natively (no semaphore needed) since each probe is I/O-bound with a timeout. The event loop manages concurrency naturally. No OOM risk observed.

### Partial failures are expected

`Promise.allSettled` never rejects — it returns all results (fulfilled or rejected). A crashed probe or network partition on one provider doesn't affect others. Each probe's rejection handler converts the failure into the same `unreachable` shape and keeps the provider id, so a thrown probe still gets its peer path-route try (the earlier code pushed a literal `"unknown"` id and lost the provider).

The alternative-provider generator (`emitProvider`) runs one `Promise.allSettled` over its `PROVIDER_SPECS` rows, and logs each rejected row instead of letting `allSettled` hide a failed layer.

## Vault configuration

The vault (infisical `/inference` path) should export:

```
PEER_BASE_URLS=https://proxy-a.tailscale.net:8080,https://proxy-b.tailscale.net:8080,https://proxy-c.tailscale.net:8080,https://proxy-d.tailscale.net:8080
PEER_BASE_URL=https://proxy-a.tailscale.net:8080  # fallback for single-proxy setups
PEER_API_KEY=...
```

`PEER_BASE_URL` is retained for backward compat with single-proxy deployments.

## Files changed

- `lib/peer-probe.mjs` — added `peerBaseUrls()`, refactored `peerBaseUrl()` to delegate to it
- `lib/hyper-facts.mjs` — peer fallback walks every `peerBaseUrls()` candidate
- `coding-agent/gen-lib.mjs` — exported `peerBaseUrls`
- `coding-agent/generate-cloud-pi-native-providers.mjs` — parallelized direct + peer probes
- `coding-agent/generate-cloud-alternative-providers.mjs` — parallelized `emitProvider` loop
- `coding-agent/generate-opencode.jsonc.mjs` — parallelized cloud + local probes; derived `LOCAL_SOURCE_CANDIDATES` from `CLOUD_PEER_CANDIDATES`
- `coding-agent/generate.sh` — updated comment to mention `PEER_BASE_URLS`
