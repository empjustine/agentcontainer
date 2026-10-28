---
id: d092
type: decision
status: implemented
title: "d092 — synthetic.new joins the fleet as a first-class provider"
parent: coding-agent
depends-on: [d024, d027, d032, d033, d057, d064, d070]
references: [d037, d047, d063]
tags: [providers, support-tiers, coding-agent, llm-reverse-proxy, models-dev]
---

# d092 — synthetic.new joins the fleet as a first-class provider

**Status: implemented.**

## Problem

Synthetic (`https://api.synthetic.new/openai/v1`, `$SYNTHETIC_API_KEY`)
sat in BOTH vendored catalogs — the models.dev slice carries the full
per-model records (12 hf:-prefixed ids, effort enums, prices), and catwalk
carries live prices — but in no repo wiring: no fact-table row, no
`PROVIDER_SPECS` row, no run.sh key forwarding, no proxy allowlist entry.
The catalogs describing a provider nobody can route is exactly the
half-present state d032's checklist exists to prevent.

## Decision

Promote synthetic as a **first-class** (d064) fleet provider via d032's
checklist, which this addition touched as follows:

1. **Fact-table row** (`lib/cloud-providers.mjs`): `synthetic`,
   `SYNTHETIC_API_KEY`, full base `https://api.synthetic.new/openai/v1`
   (path suffix included, d027), tier `first-class` — the lineup is
   catalog-derived and the provider is a primary non-subscription
   reasoning source, so regressions are fix priorities with stale-preserve
   semantics.
2. **Full `PROVIDER_SPECS` row** (`coding-agent/generate-pi-coding-agent.mjs`)
   → layer `model-019-cloud-synthetic.json`. pi does NOT ship synthetic
   natively (it is absent from the proxy generator's extracted
   `PI_AI_PROVIDERS` registry too), so the layer is the sole provider
   definition (d037). The row is the inferx shape (d032 F7): a plain
   OpenAI-compatible gateway — `compat: null, modelCompat: null,
   onOffThinking: false` — because every reasoning model publishes an
   effort enum, so `buildThinkingLevelMap` covers them (docs/d033) and no
   ON_OFF fallback or wire-compat mirror applies.
3. **Key forwarding** (`coding-agent/run.sh`): `SYNTHETIC_API_KEY` added to
   `workload_env_allowlist` — d032 F6's silent-failure trap.
4. **Proxy route**: zero code — `llm-reverse-proxy/generate.mjs` reran and
   emitted the `api.synthetic.new` host-root allowlist row (d047
   deny-by-absence; F4).
5. **Doc sync** (F8): generator header merge-order diagram, `DESIGN.md`'s
   stage table, the proxy README's example excerpt, and the d070 committed
   verifier's artifact list (`tests/artifact-urls.test.mjs`).

Layer order: `model-019` merges after `model-018` (verboo), before the
reserved `model-020` drop-in slot — merge order is filename-lexical and
no earlier layer defines `synthetic`, so the block is purely additive.

## Not decided here

- The `hf:` model-id prefix is published verbatim (pi namespaces ids under
  the provider key); no `modelIdPrefix`/allowlist machinery (cline-pass's
  is its own API contract, d040) — the models.dev slice IS the lineup.
- `status: "deprecated"` catalog records are NOT filtered: no other full
  row filters on catalog status, and inventing a filter for one provider
  would be a per-provider divergence from the shared cascade.

## Consequences

- `models.json` gains the `synthetic` provider block (12 models,
  canonical order, d050); the committed proxy config gains one allowlist
  host row; every other committed artifact is byte-unchanged (d032 F9 —
  the opencode generator's hardcoded id set excludes the new row).
- A future models.dev refresh keeps the lineup alive with no repo edit
  (the catalog row is upstream-owned, d032 F1) — the one thing that would
  silently kill it is an upstream models.dev removal, which the
  next-generation probe cascade would surface as an empty lineup.
