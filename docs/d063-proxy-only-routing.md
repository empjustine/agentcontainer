---
id: d063
type: decision
status: implemented
title: "d063 — proxy-only routing: every emitted URL is a reverse-proxy URL; the direct fallbacks are deleted"
parent: d033
depends-on: [d027, d033, d047, d060]
references: [d022, d024, d034, d037, d041, d045, d056, d060, d064]
tags: [generators, routing, reverse-proxy, compliance, pi, opencode, cascade]
---

# d063 — proxy-only routing (direct fallbacks deleted)

**Status:** implemented

## Problem

The rule this change implements: **outside of `./llm-reverse-proxy/`
environments, only reverse-proxy URLs may be used.** A future compliance
change will eliminate every non-reverse-proxy environment outright; the code
today still contains direct fallbacks that would break under it — so they are
removed now, preemptively, while their behavior is still a choice rather than
an incident.

The generators were built by [d033](d033-generator-cascade.md) as a
*direct-first cascade*: probe the provider's real endpoint; reachable ⇒ keep
(or omit in opencode's case) the built-in DIRECT routing; unreachable ⇒
reroute through the peer. Every layer of that design re-introduces a direct
URL the moment conditions change:

- **pi override-only rows** (`emitMinimalCatalogOverride`) wrote
  `providerReroute(CLOUD_PROVIDER_FACTS[id].baseUrl, …)` — the provider's
  REAL endpoint — whenever no probe argued for rerouting. That is a direct
  URL sitting in a committed artifact, one merge away from pi's live config.
- **pi full rows** (`emitFull`) routed DIRECT whenever the cloud answered a
  probe — the committed `model-015/016/017/018` layers embed
  `api.cline.bot`, `hyper.charm.land` etc. for exactly this reason.
- **opencode** omitted a provider entirely when its endpoint was reachable,
  which hands routing to opencode's BUILT-IN direct definition — a direct
  URL no artifact even shows, so `git diff` cannot catch it.
- **Reachability probes** (`probeDirect`) gated all of the above, and
  `PEERS_ONLY=1` was the ambient-env knob that disabled the gate per host
  (the exact shape d060's "ambient env stops being a config surface"
  retires).
- **Refresh chains**: `refresh-models-dev.mjs` fetched
  `https://models.dev/api.json` DIRECT first, `catwalk-facts.mjs` fetched
  `catwalk.charm.land` direct, and `provider-facts.mjs` tried the
  provider's own endpoint before any peer route.

The compliance target makes each of these a defect regardless of how well
they worked: a probe that "succeeds" is precisely the condition under which
the artifact ships a direct URL.

## Decision

### 1. The route is no longer a decision

Every provider entry the generators emit — pi `models.json` layers and
opencode `opencode.jsonc` alike — carries a reverse-proxy URL and nothing
else: `peerProviderUrl(peerBase, id)` over the vault-sourced
`PEER_BASE_URL(S)` candidates (host-form routes, [d047](d047-llm-reverse-proxy-host-allowlist.md);
the LOCAL llama-swap face keeps its `/llama-swap/` logical-name route).
When several peer-base candidates exist, the first candidate whose route
PROVES usable wins; when none proves usable (proxy down, funnel 502 — the
state this repo observed while applying this record), the FIRST candidate is
still emitted: the URL is proxy-only either way, and availability must not
be able to flip the artifact back to a direct endpoint.

Superseded in part: [d033](d033-generator-cascade.md)'s probe-gated reroute
decision ("reachable ⇒ built-in/direct stays"). Its cascade SHAPE (live
listing → catalog slice) and its per-layer emission semantics remain.

### 2. Probes decide the lineup, never the route

`probePeerRoutes`/`probeCandidates` survive with a narrowed contract:

- route answers a listing ⇒ lineup from the live listing (bounded by what
  the route serves);
- route answers 401/403 (or anything else that is not a dead route) ⇒ the
  route still PROVES itself — "reachable ≠ authenticated", the canonical
  rule the peer-probe header still owns — and the lineup falls to the
  catalog slice;
- route dead (404/502/504/timeout) ⇒ loud warn, lineup falls to the catalog
  slice or the facts cache, URL still emitted (see §1).

A dead proxy therefore degrades to a stale lineup at a correct URL — never
to a direct URL.

### 3. A provider is never omitted

Omission is how a direct URL gets back in without appearing in any diff:
pi falls back to its built-in direct provider, opencode to its own. So every
cascade branch now EMITS:

- `emitMinimalCatalogOverride(spec, providers, routeUrl)` reroutes at the
  proxy URL, and when neither models.dev nor catwalk yields a single id it
  emits the reroute with `models: []` plus a loud warn instead of returning
  without an entry;
- every full row writes its layer file each run (empty lineup ⇒ `models: []`
  + warn, never "no layer written"), so a stale committed layer with a
  direct URL cannot survive a successful regeneration;
- the opencode generator emits `opencode`, `opencode-go` and `openrouter`
  unconditionally; its lineup cascade is route listing → models.dev catalog
  slice (filtered by the same access filters + the [d049](d049-input-modality-allowlists.md)
  modality gate) → empty models map + warn. The catalog slice was the missing
  middle rung — the old code had no offline lineup source at all;
- `generateCloudProviders` fails the whole cloud stage when any spec
  rejects (previously: warn, "layer left untouched" — i.e. keep the
  committed direct layer).

### 4. Fail closed

- No `PEER_BASE_URL`/`PEER_BASE_URLS` ⇒ `generateCloudProviders` throws
  before probing anything. This replaces `peersOnly()`/`PEERS_ONLY=1`
  entirely: "no peer base configured" used to mean "hosts that need no
  peers", and under the compliance rule it means a misconfigured run.
- The pi generator exits non-zero when the cloud stage fails (its in-process
  `runStage` isolation is kept for the local/default-model stages only), and
  `generate.mjs` treats BOTH generator children (pi at its models.json
  stage, opencode at its config stage) as fatal — previously each failure
  warn-and-continued into an install of the committed (direct) artifact.
- The models.json install guard flips: 0 providers installed is now a fatal
  error (the old wording — "an empty provider map is a VALID outcome of the
  cascade" — encoded the direct-reachable world this record deletes).
- Catalog/facts/catwalk REFRESH failures remain warns: a stale vendored
  catalog or facts cache is a file, not a wire URL — using it keeps the
  artifact proxy-compliant. An unreadable catalog, by contrast, fails a full
  row outright (no lineup ⇒ no layer ⇒ fatal), because deny-by-empty for a
  first-class provider is an outage, not a fallback.
- Escape hatch for hosts that cannot load the vault: `SKIP_GEN=1` installs
  the committed (post-regeneration, proxy-only) artifact without running any
  generator.

### 5. Refresh chains become relay-only

One shared helper — `relayCandidates(host, pathAndQuery, envOverride)` in
`peer-probe.mjs` (both consumers already import it) — builds each chain:

- env override set non-empty ⇒ that URL only (operator's override);
- env override set empty ⇒ no relay (stale copy only);
- env unset ⇒ the LOCAL reverse proxy's own listen address
  (`http://127.0.0.1:8080/<host><path>` — the llm-reverse-proxy passthrough,
  itself a reverse-proxy URL and therefore in-scope), then the peer-base
  host-form routes `<peerBase>/<host><path>`.

Applied to: models.dev (`MODELS_DEV_RELAY_URL` keeps its name and its
set-empty-to-disable semantics; the default gains `?type=all`, the payload
contract its validation was written against), catwalk (no new env — an
explicit `url`/CLI argument stays the operator override), and
provider-facts (the DIRECT leg is deleted; the peer leg now sends the
provider's `Authorization: Bearer` when the key is present — it addresses
the reverse proxy, so the credentialed request goes where the key belongs —
and keeps the TLS fail-closed check).

### 6. Deleted surface

`probeDirect`, the `ProbeResult` typedef, `peersOnly()`/`PEERS_ONLY`,
the `skipDirect` option, `suppressedProbe` (its SuppressedError
compositions only ever described direct-probe demotions),
`emitFullAt`'s `directMode` parameter, the direct liveSync path,
`enrichWithLiveListing` and `spec.liveSync`. After §3 there is no branch
left that could take them — leaving them would be a landing site for the
next direct URL.

## Consequences

- **Regeneration is part of applying this record.** The committed
  `models.json`/`model-*.json` layers still embed the direct baseUrls the
  old cascade emitted; they become proxy-only only when the generators run
  once with `PEER_BASE_URL` set and the diff is reviewed. Until that run
  succeeds, `SKIP_GEN` keeps installing the old artifact.
- **Committed layers are staged into the scratch dir** before generation
  (new: `generate.mjs` copies `model-*.json` in). This is the stale-preserve
  that model-010 (LOCAL llama-swap, first-class per [d064](d064-provider-support-tiers.md))
  needs when its probe fails — the local stage's "output left untouched"
  previously left the file out of the MERGE too, silently dropping
  llama-swap from the installed `models.json`. Cloud layers get no such
  leeway: they are rewritten every successful run (§3) or the run fails (§4).
- **d034's direct-probe parallelism** dies with `probeDirect`; route probes
  remain `Promise.allSettled`-parallel. **d045's `probeDirect`/
  `suppressedProbe` examples** describe the retired path — its
  structured-error contract still governs route probes, but the demotion
  records no longer exist.
- **Boundaries deliberately retained:**
  - `llm-reverse-proxy/` keeps its direct upstreams — it IS the proxy; the
    rule binds everything OUTSIDE it.
  - `CLOUD_PROBE_CANARY` (direct models.dev) stays: only `build.mjs`
    consumes it, as the proxy image's own build-time egress canary — a
    property of the proxy image, not a generator config surface.
  - pi/opencode BUILT-IN direct definitions for providers outside the fleet
    fact table remain out there; our code and artifacts never emit them.
- **`PEERS_ONLY` leaves the docs trail** in d056/d058/d060 as history: the
  knob configured which probes fire, and with §1–§2 there is nothing left
  for it to configure.
- **Fail-closed costs a hard dependency on the vault chain.** Generating on
  a host without `PEER_BASE_URL` now fails loudly instead of quietly
  producing a direct-routed config — intended: silence was the bug.

## Verification

- `./check-types.sh` (tsc strict) and `./lint.sh`; `node --test` — only
  the two pre-existing failures at HEAD (`tests/lib-staging.test.mjs` JSON
  parse, `gen-lib.mjs(251)` TS2322) remain.
- Regeneration diff: every `baseUrl`/`baseURL` across `models.json`,
  `model-012`, `model-015..018` and `opencode.jsonc` resolves to
  `<peerBase>/…`; lineups come from catalog/facts (the funnel answered 502
  throughout, so this exercises exactly the degraded branch §2 describes).
- Unset `PEER_BASE_URL` ⇒ `generate.mjs` exits non-zero with the guard
  error and installs nothing.

## Alternatives rejected

- **Keep direct-first behind an env gate** — that IS `PEERS_ONLY`, the
  ambient-env config d060 retires, and it leaves the direct branch reachable
  by default.
- **Emit only when the route proves usable** — a 502-ing proxy would then
  push artifacts back toward built-in direct routing; availability must not
  be able to select a non-compliant URL (§1).
- **Hardcode the proxy URLs into the committed artifacts and drop the
  generation-time derivation** — the artifact carries the URL as output, but
  the peer base is vault state; baking it in turns the next funnel rotation
  into a hand-edit across four files (d024's one-source-of-truth rule).
- **Warn-and-continue on cloud-stage failure** (the old per-spec contract) —
  "continue" meant "install the committed direct artifact", i.e. the failure
  mode silently produced the forbidden state.
