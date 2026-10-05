---
id: d057
type: architecture-design
status: implemented
title: "d057 — a provider models.dev does not carry: the facts cache as the lineup (worked example: verboo)"
parent: architecture
depends-on: [d021, d023, d024, d032, d033]
references: [d047, d049, d050, environments]
tags: [coding-agent, llm-reverse-proxy, generators, models-dev]
---

# d057 — A provider models.dev does not carry

**Status:** implemented

## Problem

d032 F1 states the rule for adding a provider: the vendored
`lib/models.dev.api.json` is **regenerated wholesale** by
`coding-agent/refresh-models-dev.mjs`, so a hand-added catalog row is
transient, and `loadProvider()` throws on a provider the catalog does not
know — a catalog-less provider could not emit a layer at all. Every full
provider in the repo (cline-pass, hyper, inferx) happened to be in the
catalog.

**Verboo** (`https://code.verboo.ai/router/v1`, `$VERBOO_API_KEY`) is the first
one that is not — not in models.dev, not in catwalk, not a pi-native
provider, and no vendor extension to crib a model table from. Its listing is
also the opposite of hyper's: rich in *capability* (`context_window`, a
`vision` flag, an effort enum) and silent on *money* (no prices, no output
limit).

## Decision

Two provider classes now exist in the full mode, distinguished by ONE new
spec flag rather than a second code path:

| | catalog has the provider | `catalogOptional` |
|---|---|---|
| endpoint | catalog `api` | **fact-table `baseUrl`** |
| lineup | `provider.models` | the facts cache, in both modes |
| facts cache role | enrichment (hyper) | the only source (verboo) |
| direct-mode liveSync | yes | skipped (see below) |

- `catalogOptional: true` → `loadProvider()` returns an **empty** lineup and
  the fact-table base URL instead of throwing. The fact table is also what
  `peerProviderUrl` builds the peer route from, so direct and peer routing
  cannot disagree (d047).
- `facts: {path, listKey}` + `factsMapper` → the provider's own facts
  endpoint, refreshed and cached by `coding-agent/provider-facts.mjs`
  (generalized from the hyper-only `hyper-facts.mjs`; `<id>-facts.json`,
  `<ID>_FACTS_JSON`, same tmp+rename / stale-tolerant / fail-closed-TLS
  contract).
- With an empty catalog lineup the facts cache IS the lineup, and the liveSync
  pass is **skipped**: it exists to reconcile the catalog against a listing,
  and running it here would prune the cache's metadata down to bare ids.

### The mapper, not the defaults, decides what is fact

Both mappers emit models.dev-shaped records so `catalogPiModel()` does all
pi-shaped derivation (context, input projection, effort enum →
`thinkingLevelMap`, compat) — one implementation, two record shapes. Three
places refuse to guess:

- **Prices are absent, not zero.** The verboo mapper emits `cost: null`, the
  marker `toCost()` turns into an **omitted** `cost` block. models.dev records
  (and hyper's `/provider`) always carry prices, so `toCost(undefined)`'s
  10/50/1/20 placeholder would have been a fabricated fact in a committed
  artifact.
- **`limit.output` stays unset** → pi's conservative 16384 request cap.
  Inventing `context_window`-sized `max_tokens` against a 1M-context model
  would send a value the upstream may reject.
- **`default_effort` is dropped**: pi's `thinkingLevelMap` maps pi levels to
  wire values, it does not carry a default.

### Known gap (deliberate, not an oversight)

Only `qwen3.8-27b` advertises a disable value (`"none"` → pi `off`). The
other four reasoning models publish effort enums with no disable value, so
their map has `off: null` and pi offers no way to turn thinking off.
Synthesizing one would mean inventing a wire value the listing never
advertises (a 400 risk), so the gap stands until verb oo publishes one.

## The committed cache is load-bearing

A catalog-less provider's layer is reproducible **without a key**: the seeded
`coding-agent/verboo-facts.json` (a captured `GET /router/v1/models`) is read
stale-tolerantly when the live fetch 401s, exactly as hyper's cache is.
That makes peer-mode generation — where the provider's own host is
unreachable — possible at all, and it is why the cache is a committed
artifact rather than a leftover.

## Consequences

- `hyper-facts.mjs` is gone, replaced by the parameterized
  `provider-facts.mjs`; hyper's committed `hyper-facts.json` and
  `HYPER_FACTS_JSON` keep working unchanged (the naming convention is
  `<id>-facts.json`).
- `coding-agent/generate.mjs` discovers caches by that naming rule instead of
  listing them per provider.
- `tests/canonical-json.test.mjs` guards `model-018-cloud-verboo.json` like
  every other committed layer.
- `refresh-models-dev.mjs`'s `REQUIRED_PROVIDERS` deliberately does NOT list
  catalog-less providers: it validates what the generators read from the
  catalog.
- The rest of the provider checklist is unchanged from d032: fact-table row
  (proxy route, zero proxy code), `coding-agent/run.sh`'s key allowlist (the
  silent one), layer numbering + header/table/doc sync, committed manifests.