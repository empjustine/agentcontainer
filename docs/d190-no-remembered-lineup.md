---
id: d190
type: module-design
status: active
title: "d190 — a pi provider extension registers no model list; refreshModels is the only lineup"
parent: coding-agent
depends-on: [coding-agent, d096, d189]
references: [d021, d033, d057, d063, d064, d065, d096, d100, d122, d189]
tags: ["providers", "pi", "extensions", "coding-agent", "lineup", "generation"]
---

# d190 — no remembered lineup

## Status

Amends d096, d189, d064, d065 and the generator records they sit on. Two
sides, one rule:

- **runtime**: the committed seed (`models.js`) is retired in pi-hyper-provider,
  pi-synthetic-provider, pi-verboo-provider and pi-cline-pass-provider, and none of them registers a
  `models: [...]` field;
- **generation**: the fleet layers for those providers take their lineup from
  the provider's own source instead of the models.dev slice, and d064's
  stale-preserve (the carried-forward previous lineup, cloud or local) is
  retired.

d096 still owns the single-fetch shape, d189 the cline-pass docs-table
contract, d122 the freshness gate. This record owns what a failure of the
provider source leaves behind — at runtime and in the committed layers.

## Problem

Each of the four folders carried the same three-part shape:

- a generated `models.js` seed, committed beside `models.json`;
- a `models: [...SEED]` field on the `registerProvider` call;
- a `withSeed()` / `fromStore()` fallback so `refreshModels` returned the seed
  when the provider did not answer.

That is a remembered lineup wearing three different names, and every part of
it is wrong in the same direction. **A list on the registration is a claim
about the provider, made on the day of generation and kept forever.** pi shows
it before any refresh runs, so a retired model is offered to the user with its
old prices and old limits until somebody regenerates. And the fallback
converted the one honest signal — _this provider did not answer_ — into a
successful-looking lineup, so an outage or a rotated key read as a healthy
provider with a suspiciously quiet catalog.

`pi-cline-pass-provider` made the same mistake in its strongest form: a committed list
republished ids the provider had already retired, which is the failure d189
measured. The seeds also carried their own maintenance — a second artifact to
write, a second agreement test between seed and manifest, and a
hand-transcribed table of alias ids in pi-synthetic-provider — and all of it existed to
keep the fallback alive.

## Decision

**A provider extension in this tree registers a route, a key and a
`refreshModels`; it registers no lineup.** The rules:

- **No `models: [...]` on the registration.** Nothing is offered before
  `refreshModels` answers.
- **No committed seed, and no generator artifact for one.** `models.json`
  stays, and its only readers are the freshness gate (docs/d122) and the
  fleet-parity check; it records what the last successful generation saw and
  feeds no runtime path.
- **A failed refresh returns `undefined`, never a remembered list.** The
  provider is then simply unavailable, which is the truth: if its own endpoint
  cannot be read, it is not a working provider today. A lineup that survives
  the failure is a claim nobody can verify (docs/d021 retired the stale-copy
  rule for the same reason).
- **No side tables.** A table that only existed to make the seed usable — the
  alias map `SYNTHETIC_ALIASES` fed — goes with it. A display name comes from
  the one function that already renders it (`displayNameFor`), never from a
  parallel table that can disagree with it.

`pi-mistral` and `pi-opencode` already had this shape: they are watchdogs over
pi's own built-in catalog and register no list of their own. The four folders
above now match them, which leaves the tree with one rule instead of two.

### The generator side carries no remembered lineup either

The same failure appears one layer down, where the fleet artifacts are built,
and it retires d064's stale-preserve in both of its forms:

- **The catalog is not a lineup.** For a row whose provider answers for
  itself — `hyper` (/provider) and `synthetic` (its public listing) — the
  source decides WHICH ids publish and models.dev only prices them
  (`lineupFromFacts`). The models.dev slice used to publish as well, so a
  retired `hf:` id stayed in `model-019` until the catalog caught up.
- **A failed facts refresh publishes nothing.** The last good cache is a
  remembered lineup, so the refresh's ANSWER decides; a row that cannot
  answer writes an empty layer (d063 already writes that shape), which is the
  one output a review can tell apart from "the provider serves these".
- **The local farm answers for itself or not at all.** `previousLocalProvider`
  — the carried-forward `llama-swap` block in `generate-pi-coding-agent.mjs`
  and the `local` entry in `generate-opencode.mjs` — is gone, and an
  unreachable funnel now writes an empty block instead of leaving the file
  alone (leaving it alone let the merge republish the old lineup).

What stays is the committed artifact itself: the layers and `models.json` are
the freshness gate's subject (docs/d122) and the review surface, so a
regeneration's diff still states what the run saw. They are a record of a run,
not an input to the next one.

## Consequences

- **Generation loses a runtime reader.** `generate.mjs` writes one artifact, so
  `seedSource()`/`renderArtifacts()` are gone and `--check` compares one path.
  A generator answering "what does this provider serve" and a runtime asking
  the provider the same question no longer disagree by construction.
- **The freshness gate is what keeps a stale artifact visible.** It is the only
  reason `models.json` stays committed; `generate --check` failing on a
  provider rotation is the signal, not a defect.
- **A first-run outage is an outage.** A session with no network, or against a
  dead upstream, shows no models for that provider until a refresh succeeds;
  the alternative was showing models that may no longer exist.
  `allowNetwork: false` therefore returns `undefined`, which is what the
  suites assert.
- **The four suites assert the absence** — `"models" in config === false` and
  `refreshModels({ allowNetwork: false }) === undefined` — instead of asserting
  seed agreement.

## Alternatives rejected

- **Keep the seed but mark it stale.** pi cannot render "possibly retired" on a
  model row, so the marking would live in a comment while the row itself still
  offered the retired id.
- **Keep the seed only for `allowNetwork: false`.** That is the same remembered
  claim with a narrower trigger, and it makes the offline path disagree with
  the online one in a way no test can pin to a date.
- **Regenerate the seed on every release.** It still freezes the lineup at
  build time, and it still brings back the second artifact and its agreement
  test.

## References

- d096 — the pi-synthetic-provider single-fetch shape this record keeps.
- d189 — the cline-pass lineup contract; its committed fallback list was the
  first of these seeds to go.
- d122 — the freshness gate, the only reader `models.json` keeps.
- d021 — the retired stale-copy rule.
- d064 — the support tiers this record amends: its first-class contract used to
  promise the stale-preserve.
- d063 — the "still written, empty" layer shape a failed source now uses.
- d065 — the opencode overlay whose carried-forward `local` entry went with it.
- d191 — the sibling rule for the catalogs themselves: a committed
  models.dev mirror or fact cache is the same remembered data one level down.
- d033, d057 — the two facts-listing roles (enrich, and be the whole lineup) this
  record unifies into one: the source decides, the catalog prices.

## Amendment: the unit artifact retires with its generator

The four extension folders no longer commit a `models.json`. The What stays is
the committed artifact itself paragraph above kept it as the gate's subject;
once every folder's data was a live read and the `coding-agent` layer was the
only committed form of the same rows, that artifact had no reader, no runtime
path and — with the generator gone — no writer, so it was stale by construction
and `--check` compared a file against itself.

What changed:

- `generate.mjs`, `models.json` and the manifest projection (`toPiModel`) are
  deleted in `pi-cline-pass-provider`, `pi-hyper-provider`, `pi-synthetic-provider` and `pi-verboo-provider`. The
  `"generate"` script survives as `echo '{"msg":"nothing to generate in
  <unit>"}'`, so a unit's entrypoint table keeps its shape (docs/d113) and
  `./npm-run.sh <unit> generate` answers instead of failing.
- `freshness.sh` counts a stub unit as skipped rather than checked, and asks for
  no credential it would not use (docs/d122).
- The contract-tier warning only the generator made (`warnOnMissingTiers`) moves
  to `refreshModels` in `pi-synthetic-provider`, the one remaining surface that sees a
  listing.
- The fleet's `model-*.json` layers are unchanged: they are now the only
  committed rows of these providers, and no unit keeps a second copy to drift
  from them.
