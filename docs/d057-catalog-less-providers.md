---
id: d057
type: module-design
status: active
title: "d057 — a provider models.dev does not carry: its own listing as the lineup (worked example: verboo)"
parent: coding-agent
depends-on: [d021, d023, d024, d032, d033]
references: [d047, d049, d050, environments]
tags: [coding-agent, llm-reverse-proxy, generators, models-dev]
---

# d057 — A provider models.dev does not carry

**Status:** implemented — the cache half is superseded by
[d191](d191-fetch-per-run-catalogs.md): the listing is fetched per run, nothing
is committed, and a provider that cannot answer publishes nothing.

## Problem

d032 F1 states the rule for adding a provider: the models.dev catalog is
fetched wholesale per run (docs/d191), so a hand-added catalog row could not
survive, and `loadProvider()` throws on a provider the catalog does not
know — a catalog-less provider could not emit a layer at all. Every full
provider in the repo (cline-pass, hyper, inferx) happened to be in the
catalog.

**Verboo** (`https://code.verboo.ai/router/v1`, `$VERBOO_API_KEY`) is the first
one that is not — not in models.dev, not in catwalk, not a pi-native
provider, and no vendor extension to crib a model table from. Its listing is
also the opposite of hyper's: rich in _capability_ (`context_window`, a
`vision` flag, an effort enum) and silent on _money_ (no prices, no output
limit).

## Decision

Two provider classes now exist in the full mode, distinguished by ONE new
spec flag rather than a second code path:

|                      | catalog has the provider | `catalogOptional`          |
| -------------------- | ------------------------ | -------------------------- |
| endpoint             | catalog `api`            | **fact-table `baseUrl`**   |
| lineup               | `provider.models`        | the provider's own listing |
| listing role         | enrichment (hyper)       | the only source (verboo)   |
| direct-mode liveSync | yes                      | skipped (see below)        |

- `catalogOptional: true` → `loadProvider()` returns an **empty** lineup and
  the fact-table base URL instead of throwing. The fact table is also what
  `peerProviderUrl` builds the peer route from, so direct and peer routing
  cannot disagree (d047).
- **d190 amended the first column.** A provider's own listing no longer only
  enriches: its answer decides WHICH ids publish (hyper, synthetic), and a
  source that cannot answer publishes nothing rather than a remembered list.
  `catalogOptional` still marks the row the catalog cannot describe at all.
- `facts: {path, listKey}` + `factsMapper` → the provider's own listing,
  fetched per run by `coding-agent/catalog-facts.mjs` and handed over in
  memory (docs/d191: no cache file, no `<ID>_FACTS_JSON`, fail-closed TLS).
  The `listKey` is the endpoint's own list member — hyper answers `models`,
  verboo answers `data` — and the row is the one place it is stated; a reader
  with its own hardcoded key silently empties the provider (docs/d086 has the
  verboo failure).
- With an empty catalog lineup the provider's listing IS the lineup, and the
  liveSync pass is **skipped**: it exists to reconcile the catalog against a
  listing, and running it here would prune the listing's metadata down to bare
  ids.

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

## A key is required to publish the layer

The committed `verboo-facts.json` this section used to defend is deleted
(docs/d191). A generation without `VERBOO_API_KEY`, or against a host that
cannot reach the listing, writes an **empty** verboo layer and says so — the
row's lineup is unverifiable otherwise, and a captured `GET /router/v1/models`
from some earlier day is exactly the remembered lineup d190 removed. Peer-mode
generation needs the key like every other key-gated row.

## Consequences

- The fetch is parameterized by the row (`path`, `listKey`, mapper) rather
  than per provider: hyper, synthetic and verboo share one code path with three
  mappers.
- `coding-agent/generate.mjs` no longer discovers anything by a naming rule:
  there are no cache files to discover (docs/d191).
- the canonicity guard (`coding-agent/tests/committed-manifests.test.mjs`, d113) covers
  `model-018-cloud-verboo.json` like
  every other committed layer.
- `refresh-models-dev.mjs`'s `REQUIRED_PROVIDERS` deliberately does NOT list
  catalog-less providers: it validates what the generators read from the
  catalog.
- The rest of the provider checklist is unchanged from d032: fact-table row
  (proxy route, zero proxy code), `coding-agent/run.sh`'s key allowlist (the
  silent one), layer numbering + header/table/doc sync, committed manifests.
