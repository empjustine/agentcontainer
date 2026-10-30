---
id: d097
type: decision
status: implemented
title: "d097 — the pi-opencode-go extension: for a provider pi builds in, the extension is a catalog freshness watchdog, not a catalog"
parent: coding-agent
depends-on: [d048, d070, d074, d096]
references: [d028-superseded, d032, d039, d064, d092]
tags: ["providers", "pi", "extensions", "coding-agent", "opencode"]
---

# d097 — the pi-opencode-go extension

## Problem

Three findings converged while building this folder:

1. **pi 1.4.0 builds opencode-go IN.** `@earendil-works/pi-ai` ships
   `data/opencode-go.json` with 29 models across all four api dialects
   (openai-completions, openai-responses, anthropic-messages,
   google-generative-ai), each row carrying its own family `baseUrl`, the
   OpenCode `x-opencode-session`-injecting stream wrappers, and
   `OPENCODE_API_KEY` env auth. That is the complete d048 per-row table,
   implemented in the host — the original mission of this extension (carry
   the mixed-surface catalog where pi had none) was already accomplished by
   pi itself.
2. **The first implementation here nonetheless carried a backup catalog** —
   a committed `models.js` seed (37 rows shaped from the live listing ∪
   models.dev) plus a `models.json` pi-shaped layer. For a built-in
   provider that is pure liability: pi's composer
   (`core/provider-composer.js applyExtension`) REPLACES the whole provider
   catalog when an extension returns a model list — a returned row inherits
   only `api`/`baseUrl` from its built-in twin, not names, limits, prices
   or thinking maps. A committed copy can therefore only be a downgrade
   today and a stale one tomorrow (the built-in catalog moves with pi
   releases; ours would only move with a `generate.sh` rerun).
3. **What no built-in snapshot can know is whether its lineup is still
   live.** A 29-row catalog in the host is still a catalog frozen at pi's
   build time; the one honest signal is upstream's `/models` listing.

## Decision

For providers pi builds in, the extension observes the catalog and never
carries it — **no model data, no seed, no committed artifacts, no
generator**. The folder is one file, `index.ts`, registering
`registerProvider("opencode-go", { refreshModels })` and nothing else:

- **listing reachable → `return undefined`** — pi's built-in rows stand,
  because they are the better data;
- **listing fails (network allowed, not aborted) → THROW.** Throwing IS the
  catalog warning: pi's refresh pipeline records the error per provider
  (`ModelsRefreshResult.errors`) and the model selector surfaces "Could not
  refresh opencode-go; showing cached models." — with the built-in rows
  untouched;
- **`allowNetwork=false`** (offline init) or within the 4-hour refresh
  interval → `return undefined` silently: pi already knows it is offline,
  and a warning every model-selector open would be noise. `force` bypasses
  the interval.

Deliberately absent: `models`, `api`, `baseUrl`, `apiKey`,
`authHeader`, `headers` (each would override the built-in provider), and
any `../lib` import — a copied package must stand alone, so the upstream
URL is a constant pinned by the tests against the fact table
(`lib/cloud-providers.mjs`, docs/d070).

The contrast case is `docs/d096`: synthetic is NOT built into pi, so
`pi-synthetic/` DOES carry its own generated catalog. The rule recorded
here is about SUBSTITUTION, not contribution: **a built-in provider's
extension must not substitute its own model data for pi's** — no backup
catalog, no silent fallback when the live lineup cannot be fetched (warn
instead, and pi's rows stand). Contributing data the host does not have
is right whenever it can only ENRICH what pi ships; the obstacle today
is mechanical, not principled — pi's composer turns any returned model
list into a wholesale replacement, so enrichment amounts to freshness
signalling until an additive hook lands (see Open seams). Such a hook
would flip this extension from signalling to contributing, not
invalidate the rule.

## Consequences

- `pi-opencode-go/` is `index.ts` + `package.json` (+ docs): no
  `generate.sh`, no `--check`, no ignore entries in `biome.jsonc`, no
  generator files in `tsconfig.json`.
- The d048 research (mixed surface, per-family bases, the resolver gaps)
  stands unchanged in `docs/d048` and is now answered by the host's own
  data — during implementation it was verified row by row against pi-ai's
  built-in catalog.
- `tests/pi-opencode-go.test.mjs` pins the RULES, not any lineup: the
  config carries only `refreshModels`; no model data exists in the folder;
  the listing URL matches the fact table; every failure path leaves pi's
  defaults in place; all fetches are injected (no network in `node --test`).
- The fleet layer (`model-012`) is unchanged; our extension composes over
  whatever the user's models.json stack produces, since it never touches
  models. The two layers share the provider id and must not both add
  `baseUrl` to it — ours does not.

## Open seams

- pi has no additive extension hook today: returning any model list
  REPLACES the catalog, which is why the success path contributes nothing.
  If a merge-style hook ever lands (add rows without replacing), the
  watchdog could contribute fresh listing ids alongside the built-in rows.
- The fleet's own `resolveOpencodeGoApi` (single historical go.mdx path,
  google deliberately unmapped) still degrades silently on current
  mirrors; migrating `model-012` to the tested dual-path resolver — or to
  pi's built-in per-model api — remains deferred.
