---
id: d071
type: decision
status: implemented
title: "d071 — retire the 'peer' term: REVERSE_PROXY_BASE_URLS and its vocabulary"
parent: coding-agent
depends-on: [d027, d047, d063]
references: [d022, d024, d033, d034, d060, d070]
tags: [terminology, generators, reverse-proxy, pi, opencode, docs]
---

# d071 — retire "peer" for the reverse-proxy vocabulary

**Status: implemented.** The reverse-proxy base and the machinery around it get
names that say *reverse proxy*. "Peer" survives only for the local llama-swap
farm provider concept. The paired bearer rename (`PEER_API_KEY` →
`REVERSE_PROXY_API_KEY`) landed one change later, under the same decision.

## Problem

"Peer" accumulated three senses in this repo:

1. **The tailnet host** that runs the funnel/llm-reverse-proxy — the
   original meaning (d022/d027).
2. **The reverse-proxy base and client-route machinery** named after it:
   `PEER_BASE_URL(S)`, `peerBaseUrl(s)`, `peerProviderUrl`,
   `probePeerRoutes`, `CLOUD_PEER_CANDIDATES`, `peerProvider`,
   `peerIds`/`peerBounded`, the `peer-probe.mjs` module itself, plus the
   log strings and doc prose that echo them.
3. **The local llama-swap farm**, loosely "the peer provider".

Sense 2 is machinery of a named component (`llm-reverse-proxy/`) and nothing
"peer" about it once that component is spoken of directly. Worse, it crowds
out sense 3 — the only one worth keeping — and misleads: a "peer" suggests an
equal node, while the thing is a reverse-proxy base whose path segment is a
capability (see d070, which moves that capability out of sight entirely).

## Decision

1. **The env surface becomes `REVERSE_PROXY_BASE_URLS` — the one name
   this repo reads.** It holds the comma/newline-delimited base candidates;
   a single base is a single-entry list, so there is no singular fallback
   and no second spelling. Name rationale:
   - not `PROXY_BASE_URL(S)` — that sits beside the forward-proxy family
     (`http_proxy`/`HTTPS_PROXY`, which `useEnvProxy()` in the probe module
     honors on every fetch) and invites exactly the wrong reading;
   - not `RELAY_BASE_URL(S)` — "relay" already names the metadata-relay
     chain (`relayCandidates`, `MODELS_DEV_RELAY_URL`, d063 §5);
   - `REVERSE_PROXY_*` matches the component's own name and cannot be
     misread.
2. **The vault keeps the old names set; nothing here reads them.** For
   compatibility with anything outside this repo, infisical's `/inference`
   path sets the retired `PEER_BASE_URL(S)` alongside
   `REVERSE_PROXY_BASE_URLS` — but this repo reads ONLY the new plural, from
   day one: no alias read, no warn, no migration window inside the tree
   (a generate under only the old names fails closed on the existing
   missing-base guard). This is not a new ambient config knob (d060): same
   single vault-sourced value, one spelling. The paired bearer rename
   (`PEER_API_KEY` → `REVERSE_PROXY_API_KEY` — the one rename that also
   touches `llm-local-inference/`'s generated llama-swap `apiKeys`) landed
   one change later, under the same decision and the same shape: the repo
   reads only the new name from its landing change — no alias read, no warn,
   no migration window — and the vault keeps the retired `PEER_API_KEY` set
   for outside compatibility.
3. **Code identifiers and the module rename** (mechanical, one change):
   `peerBaseUrl(s)` → `reverseProxyBaseUrl(s)`, `peerProviderUrl` →
   `providerRouteUrl`, `probePeerRoutes` → `probeRoutes`,
   `PeerRouteResult` → `RouteResult`, `CLOUD_PEER_CANDIDATES` →
   `REVERSE_PROXY_BASE_CANDIDATES`, opencode's `peerProvider` →
   `routedProvider`, `peerIds`/`peerBounded` → `routeIds`/`routeBounded`,
   `peer-probe.mjs` → `route-probe.mjs` (the module's post-d063 contract is
   route probing and route building — probes decide lineups, never
   routes).
4. **Live docs are rewritten; historical records are not.** In scope:
   README rows, `architecture.md`, both `DESIGN.md` files,
   `environments-and-peer-variants.md` (renamed
   `environments-and-variants.md`), code comments and fileoverview headers,
   log/error strings, `tests/check-workload.sh`'s `workload_env` lists.
   Out of scope: the bodies of d022/d027/d033/d034/d047/d063 and
   `docs/archive/` — a decision record keeps the names of the day;
   misleading README index rows point at this record instead. d063 stays
   authoritative for the routing *rules*; this record owns the *vocabulary*.
5. **The kept carve-out:** "peer" remains only for the llama-swap farm
   provider concept ("the llama-swap peer provider"). Honest etymology for
   the record: that usage also came from sense 1 — what is actually meant is
   the local GGUF farm served to the fleet.

## Consequences

- The rename is mechanical and reviewable on its own; [d070](d070-canonical-upstream-urls-and-install-time-routing.md)
  depends on this vocabulary and should land after it, so the behavioral
  change never ships under names already marked for retirement.
- External state: the vault keeps the retired `PEER_BASE_URL(S)` keys set
  for compatibility outside this repo; nothing in the tree reads them, so
  an operator script that only sets the old names fails loudly at the
  generators' fail-closed guard (ops, recorded here because the repo
  cannot own the vault).
- Searchability: "peer" in git history and the retained decision records
  keeps its trail — new prose does not add to it.

## Verification

- `rg -i '\bpeer\b'` outside the historical records returns only this
  record's own old-name listings, README index rows that point here,
  rename-history mentions ("was `peer-probe.mjs`"), proper names of retired
  artifacts (folders/layers/runners/archived docs —
  `openai-completions-peer/`, `peer-cloud.yaml`, `peer-variant-work.md`,
  upstream's `internal/router/peer.go`), the llama-swap carve-out, and
  non-vocabulary English (LICENSE's GPL text, the prior-art notes).
- A generate run with only `REVERSE_PROXY_BASE_URLS` set works; with only
  the old names set it fails closed with the missing-base error — the repo
  reads no other base spelling.

## Alternatives rejected

- **`PROXY_BASE_URL(S)`** — forward-proxy collision, decision 1.
- **`RELAY_BASE_URL(S)`** — metadata-relay collision, decision 1.
- **`ROUTER_BASE_URL(S)`** — "router" is comment-slang for the v2 host-form
  route (d047), never the component's name.
- **Rename the vault key first, then the repo** — every checkout breaks
  between the two; the alias window is the other order and degrades
  cleanly.
- **Rewrite the historical records' bodies** — falsifies the record and
  breaks every link that quotes the old text; the README row pointers
  carry the cross-reference instead.
