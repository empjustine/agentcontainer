---
id: d091
type: decision
status: accepted (documentation; staged — stage 1 gateway auth, stage 2 llama-swap bearer retirement)
title: "d091 — llm-reverse-proxy gateway auth (d073 mode B): the funnel front authenticates; llama-swap's bearer retires behind it"
parent: llm-reverse-proxy
depends-on: [d071, d073, d077, d078, d084, d085, d088, d090]
references: [d001, d027, d047, d050, d063, d070, d079]
tags: [gateway-auth, mode-b, reverse-proxy, llama-swap, secrets, pi]
---

# d091 — gateway auth (mode B): the funnel front authenticates; llama-swap's bearer retires behind it

## Problem

Three facts, one per layer:

1. **Mode A authenticates nothing.** d047's deny-by-absence is routing, not
   auth — and the funnel front is public internet. Today the only thing
   standing between the internet and the local GPU farm is llama-swap's own
   bearer (d027), enforced at the far end of the chain.
2. **That placement is crude where it hurts.** `llm-local-inference/run.sh`
   pulls the whole vault chain to forward one bearer into llama-swap's env;
   the same secret must also reach every client (coding-agent container env
   for pi's `apiKey`, the probe process during generation) — one credential,
   six homes, enforced by the least-configurable component in the chain, and
   the launcher carries the vault round-trip for this single purpose.
3. **Dropping it before something upstream authenticates is a trap.** The
   farm would become an internet resource gated by a path prefix — the
   camouflage 404 (VPN-R34) hides route *existence*, it does not
   *authenticate*. Rejected; the bearer stays until the proxy authenticates.

d073's mode B (authenticated generic relay, deferred to v3) has never been
specced. This record is that spec, plus the staged retirement the gateway
unlocks.

## Decision

### Stage 1 — the gateway (d073's mode B, realized on the funnel front)

- **Arming = credential**, the d084/d085 contract: `REVERSE_PROXY_KEYS`
  (JSON `{"<id>": "<token>"}`) / `REVERSE_PROXY_TOKEN` (single implicit
  "default" principal), env-only (VPN-R31/R32 pattern), never the config
  file. Absent env = unarmed = today's mode A, byte for byte.
- **The credential rides a dedicated header**, `X-Reverse-Proxy-Key:
  <token>` (bare token, no Bearer scheme). Scheme-orthogonal by design: it
  must not collide with the per-api auth schemes clients already send
  (`Authorization` for openai-*, `x-api-key` for anthropic-messages,
  `x-goog-api-key` for google), must not be an `X-Forwarded-*` header
  (stripped as anti-spoofing), and must work for **OAuth-only providers**
  that carry no `apiKey` env at all — no `Authorization`-based scheme can
  do that without clobbering.
- **The proxy strips the header on EVERY request, armed or not** — an
  unarmed proxy must never forward a gateway token upstream — then checks
  when armed. The check reuses d078's machinery shape: constant-time compare
  over a bounded principal set, no early exit (VPN-R33's timing posture).
- **Failure answers the same funnel 404 — never a 401.** VPN-R34's
  no-oracle property extends to the gateway: a wrong-key probe learns
  nothing it did not already know.
- **Dispatch order:** gateway check precedes allowlist dispatch. The tunnel
  namespace (`/vpn`, modes C–E) keeps VPN-R31's own bearer and is NOT
  gateway-gated — one credential per namespace, no coupling.

**Client contract** (models.json — pi first-class per
[d090](d090-llm-harness-support-tiers.md); the contract other tiers follow):

- pi already supports it (pi `models-configuration.md`): provider-level
  `headers`, values resolve like `apiKey` — `$NAME`/`${NAME}` env
  interpolation at request time (never cached), literal, or `!command`;
  `$$`/`$!` escape. Routing a built-in provider through a proxy by setting
  only `baseUrl` (and now `headers`) leaves its models and authentication
  unchanged — pi's built-in per-provider auth (env key or OAuth) rides
  untouched in its own scheme.
- `routedProvider` (cloud, pi-native; today `{ baseUrl, models }`
  with no `apiKey`) gains `"headers": { "X-Reverse-Proxy-Key":
  "$REVERSE_PROXY_TOKEN" }`.
- `providerEntry` (local llama-swap; today `apiKey:
  "$REVERSE_PROXY_API_KEY"`) keeps its `apiKey` through stage 1 and drops
  it at stage 2.
- `$VAR` only, never literals: `models.json` is a committed artifact
  (d050); interpolation keeps the token out of the tree. `baseUrl` stays a
  baked literal (d001 §2). The env name must not collide with pi's provider
  auto-detection (d001 §3) — `REVERSE_PROXY_TOKEN` does not.

### Stage 2 — llama-swap's bearer retires (may land one change later, under this decision; d071's shape)

- llama-swap drops `apiKeys` (`00-general.yaml`, `llama-swap-core.json`):
  the proxy is its only supported caller (d063 proxy-only routing), and the
  funnel leg — the reason the key existed — is now authenticated upstream.
- The direct surfaces narrow with it: the container publish becomes
  loopback-only (`127.0.0.1:8101:8080`; the container keeps `0.0.0.0`
  internally), and the tsnet serve face (d070's fact-table identity — the
  endpoint must keep existing, the proxy dials it) is governed by a tailnet
  ACL restricting it to the proxy's node identity. Ops-owned, like the
  vault; recorded here because the repo cannot own tailscaled.
- `llm-local-inference` becomes a **zero-secret serving unit**: run.sh's
  vault round-trip and env-allowlist entry go (HF_TOKEN already stays out of
  the container; host-side provisioning keeps its own separate chain).
- coding-agent: `providerEntry`'s `apiKey` goes, the gateway header stays;
  the probe (`route-probe.mjs`) presents the gateway header instead of the
  llama-swap bearer; `tests/check-workload.sh` fixtures follow.
- The vault keeps the retired `REVERSE_PROXY_API_KEY` set for outside
  compatibility; this repo reads only `REVERSE_PROXY_TOKEN` — no alias
  read, no warn, no migration window (d071's law).
- The naming question dissolves: the token **is** the reverse proxy's
  credential — no `LLAMA_SWAP_API_KEY`, and no hostname-keyed name (naming
  a credential after the machine re-couples a name to a location, the
  failure d088 retired for roles).

## Consequences

- **Secret spread, before → after:** one bearer in six homes (vault, two
  host chains, two container envs, probe) → one token in the exit node's env
  plus each client's env. The residue is inherent — every presenter needs the
  credential — but enforcement collapses to one place, with d078's
  rotation/revocation story available to it.
- llama-swap simplifies: its config loses the only `${env.*}` indirection;
  its launcher loses its only secret.
- Best-effort/superficial harnesses (d090): opencode needs its own
  headers-capability check before stage 1 works for it; mistral-vibe and
  crush simply have no generated surface — the proxy works for any HTTP
  client that can send one header.
- d079 (draft): its HTTP(S)_PROXY harness transport must account for the
  gateway header; its guard-rehoming predates this record.
- d027's "local face keeps its bearer" clause and d001's llama-swap-bearer
  contract are reversed by stage 2 — those records keep the names and
  decisions of the day; this record owns the change.

## Alternatives rejected

- **Drop the llama-swap bearer before mode B** (loopback publish + tailnet
  ACL only) — covers the direct surfaces, not the funnel leg; the farm
  becomes internet-reachable gated by a prefix. Rejected; this is the trap
  this record exists to close.
- **A row-bearer inside mode A** (authenticate just the llama-swap row at
  the proxy) — one authenticated row among ~36 passthrough rows is an
  asymmetry with its own review surface, and it pre-empts mode B for one
  row. Rejected.
- **Deliver the llama-swap key differently** (secret file, mount, command
  interpolation) — removes no holder; the env-allowlist chain is the repo's
  one secret path. Rejected.
- **One shared token for gateway + llama-swap during transition** — couples
  two components' credentials to save one vault edit; separate credentials
  stage cleanly and retire cleanly.

## Verification

- A generate with only `REVERSE_PROXY_TOKEN` set works; after stage 2, with
  only the retired `REVERSE_PROXY_API_KEY` set, the affected generators
  fail closed (d071 shape) — the repo reads no other spelling.
- Smoke test additions: armed proxy + valid header → byte-for-byte
  passthrough; wrong or missing header → the funnel 404, indistinguishable
  from an unknown host; the gateway header never appears in an upstream
  request (strip check holds armed AND unarmed); unarmed proxy behaves as
  mode A.
- Post-stage-2: `rg -i 'REVERSE_PROXY_API_KEY'` returns only rename-history
  mentions and this record; the proxy source shows the strip-before-check
  order and the 404-only failure path.
