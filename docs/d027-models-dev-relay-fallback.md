---
id: d027-models-dev-relay-fallback
type: decision
status: accepted
title: d027 — models.dev catalog fetch chain (direct → relay → stale copy)
parent: architecture
depends-on:
  - lib
  - d023-generators-dedup
  - d025-shared-model-data-to-lib
tags:
  - serving
  - llm-reverse-proxy
  - coding-agent
---

## Context

`lib/models.dev.api.json` (the vendored models.dev catalog, `docs/d023`/`d025`)
is refreshed best-effort from `https://models.dev/api.json` before each
generation run; on any failure the stale vendored copy is kept and generation
proceeds. With cloud relay now served by `llm-reverse-proxy` (the raw
passthrough proxy) instead of llama-swap peers, the question was raised:
should the catalog be fetched *through the relay* (a `models.dev` virtual
provider, `http://<host>:8080/models.dev/api.json`) so the stale-snapshot
machinery could go away — on the argument that "if the relay is unreachable,
everything is toast anyway"?

## Findings

1. **The consumer set shrank before this decision.** After the
   local-inference pruning, `llm-local-inference` reads the catalog zero
   times (its peer generators are gone). The only consumer family left is
   `coding-agent`: host-side generation refresh + read
   (`generate-cloud-alternative-providers.mjs`), and the container-side
   refresh mounted at `/opt/lib`.
2. **"Relay down ⇒ everything toast" is true at request time, not at
   generation time.** The catalog fetch happens in the step that *produces*
   the runtime configuration. Coupling it to relay liveness would create a
   boot-order dependency (proxy must be up before generation) and turn a
   generation-time transient (proxy restarting, host booting, tailscale
   blip) into a hard generation failure — the worst place for one, since
   generation is how you fix things.
3. **Neither fetch site actually needs the relay for reachability.**
   Host-side generation has direct egress; the pi container reaches providers
   directly with its own keys by design (that is the whole
   no-credential-handling contract of the relay). So routing via the relay
   buys no new reachability — only a stable internal URL and an observable
   chokepoint in the proxy logs.
4. **Coding-agent generation is already network-dependent** (its provider
   probes do live reachability checks), so a hard network requirement at
   generation is not unprecedented — but each probe failure *skips* a
   provider; the catalog feed is broader than any one probe.
5. **The snapshot machinery is small.** The entire "stale copy" handling is
   one ~180-line script (`refresh-models-dev.mjs`: atomic tmp+rename,
   validated payload, never clobbers on failure) plus env gating. A relay
   URL would replace one HTTP endpoint with another, not delete the file
   handling.

## Decisions taken

- **Three-source fetch chain** in `refresh-models-dev.mjs`
  (`MODELS_DEV_RELAY_URL`, default `http://127.0.0.1:8080/models.dev/api.json`,
  empty disables the hop):
  1. **direct** — `https://models.dev/api.json` (normal case);
  2. **relay** — the `llm-reverse-proxy` passthrough, for hosts/containers
     where direct egress to models.dev is blocked or broken but the local
     relay is up. The relay forwards byte-for-byte, so the response passes
     through the *identical* validation (required providers present, ≥ 100
     providers, JSON shape) before the atomic rename;
  3. **stale copy** — last resort, unchanged contract: any failure above
     leaves `lib/models.dev.api.json` intact and generation proceeds with
     the last good copy.
- **`models.dev` virtual provider added** to
  `llm-reverse-proxy/llm-reverse-proxy.example.json`
  (`"models.dev": "https://models.dev"`) and to the smoke test
  (`passthrough-models-dev`: the relayed `/api.json` must parse as a catalog
  with ≥ 100 providers). Public endpoint, no keys — the trivial case for a
  passthrough proxy, and a useful single observable egress point for catalog
  traffic.
- **Generation keeps its network independence**: the chain *ends* at the
  stale copy; no source is load-bearing. Verified end-to-end: direct fetch
  OK (213 providers); with direct egress forced to fail (dead
  `HTTPS_PROXY`, `NO_PROXY=127.0.0.1` keeping the relay hop reachable) the
  relay hop answers and the catalog still refreshes.

## Decisions avoided (and why)

- **Not making generation *depend* on the relay** (the original proposal's
  strong form). Finding 2: it inverts a dependency — the fetch is a
  setup-time concern, the relay a runtime one; the failure mode gets worse,
  not simpler.
- **Not deleting the vendored snapshot / "live fetch only"** (the honest
  version of the simplification the relay was meant to enable). It *would*
  delete real machinery (catalog file, refresh script, `MODELS_DEV_*` env
  gating), but trades away pinned lineups (reviewable git diffs of model-id
  changes) and the shared-table invariant of `docs/d023`/`d025`. Deferred to
  the `coding-agent` rework (where all remaining consumers live) — if that
  rework accepts live-fetch-only, this relay hop and the snapshot both die
  together and this note becomes historical.
- **Not routing the container-side refresh through the relay by default**
  (`MODELS_DEV_RELAY_URL` defaults to a *host-local* URL). Container-side
  callers must set the env explicitly; a wrong default that silently never
  answers would just be dead code with extra steps.

## Consequences

- `refresh-models-dev.mjs` gained one `fetchCatalog` hop and two log lines;
  validation and the atomic-rename contract are unchanged.
- The relay provider list (`llm-reverse-proxy.json`) is now also serving
  non-LLM traffic — fine by design ("passes all calls as-is"), but provider
  slugs are no longer implicitly LLM-only.
- If the coding-agent rework later adopts live-fetch-only, remove: the
  `RELAY_URL` block, the vendored `lib/models.dev.api.json`, the
  `MODELS_DEV_*` env docs, and this note's *taken* section (keep *avoided*).
