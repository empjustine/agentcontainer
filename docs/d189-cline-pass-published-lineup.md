---
id: d189
type: module-design
status: active
title: "d189 — the ClinePass lineup is the published table, and nothing else"
parent: coding-agent
depends-on: [coding-agent, d040]
references: [d040, d057, d063]
tags: ["coding-agent", "cline-pass", "lineup", "provider"]
---

# d189 — the ClinePass lineup is the published table, and nothing else

## Status

Amends d040: its union-and-floor reconciliation and its committed fallback
list are retired. d040 still owns the parts this record leaves alone — why the
prefix is a billing fact, why the provider's own listing is never a source
(its `liveSync: false` boundary), and why this provider is curated at all.

## Problem

d040's contract had two sources reconciled by an overlap floor, plus a
committed fallback list, and each of the three parts failed in a different
direction. Measured on 2026-11-14, against a docs table of 15 ids:

- **The union published dead ids.** models.dev keeps rows the gateway has
  already retired, and the floor only measured `|docs ∩ catalog| / |docs|`; ids
  the catalog carried alone entered the union unexamined. Six retired ids were
  still published: `deepseek-v4-flash`, `glm-5.2`, `kimi-k2.6`,
  `kimi-k2.7-code`, `mimo-v2.5`, `mimo-v2.5-pro`.
- **The catalog filter dropped live ones.** A published id with no models.dev
  record found nothing to emit, so three ids the table names disappeared from
  the artifacts: `deepseek-v4.1-flash-1017`, `kimi-k3.1-pro`,
  `minimax-m3.1-flash`.
- **The fallback made availability a remembered claim.** The committed list
  republished a stale lineup whenever a source did not answer, and it had to
  be hand-transcribed in two files on every rotation. The margin was gone as
  well: 12 of the 15 docs ids matched the slice, exactly the 0.800 floor, so
  one more docs-only model would have reinstated the stale list with a
  warning.

## Decision

One direction between the two sources, in both shapers
(`coding-agent/generate-pi-coding-agent.mjs` and `pi-cline-pass/sources.mjs` +
`merge.mjs`):

- **The docs table is the lineup.** Cline's published `## Models` table names
  the ids; nothing else adds one. A table id the catalog has no record for
  still publishes, with the table's display name and pi's schema defaults for
  the fields the catalog did not supply.
- **models.dev is metadata.** It prices and describes those ids. An id only
  the catalog carries is a retired id and never publishes.
- **The table also owns the display name**, because models.dev has published a
  row's raw id in that field.
- **No committed lineup, no agreement floor.** Neither shaper holds a model id
  list; both read the table on every run.
- **No source, no provider.** Both reads throw, and a run that cannot read
  either source writes nothing (the writers are atomic). The mirror farm is
  not consulted for this file either: a mirror clone is a remembered table.
  `CLINE_PASS_MDX` remains the way to pin a table on a host that carries one.

The committed extension seed (`pi-cline-pass/models.js`) went later: docs/d190
retired it, so the extension registers no lineup and `refreshModels` is the
only source here too. `models.json` stays as the drift gate's subject.

## Consequences

- An offline host publishes no cline-pass models. That is the intended answer,
  not a regression: the sources are the provider's published catalog, and a
  lineup nobody can check is a lineup pi should not offer.
- A rotation costs one regenerated artifact set. The table edit plus
  `./npm-run.sh pi-cline-pass generate` is the whole change; there is no
  constant to keep in step, in this folder or the fleet's.
- A retired id leaves the artifacts on the run after the table stops naming
  it, without waiting for models.dev to prune its slice.
- The three docs-only ids publish with pi's defaults (128k context, 16k
  output) until the catalog catches up, because nothing else publishes those
  numbers.

## Alternatives rejected

- **Keep the union and add a deprecation prune.** It needs an authority on
  "retired", and models.dev does not publish one: its slice is the lagging
  source in both directions.
- **Wire `@cline/llms` as the metadata source for the docs-only ids.** Still the
  best candidate named in `pi-cline-pass/README.md`, still absent: it ships its
  catalog inside a minified bundle, so reading it is format-fragile parsing in
  exchange for three rows pi's defaults already cover.
- **Keep the committed list as an offline fallback.** It is the failure mode
  this record exists to remove; the seed covers the one legitimate use
  (registering models before the first refresh) without pretending to be a
  source.

## Amendment: the table is the only read

The second read retired as well: both shapers read the docs table first and
make no models.dev request after a successful parse, and the fleet's row
carries `lineupOnly` so the artifact side follows the same rule.
`fetchCatalogSlice` keeps no production caller.

The reason is what the second read was buying. Its price column is a reference
rate — Cline's own page states the tabulated per-million rates are not what a
subscriber pays, and that the quota over them is "2-5x" and otherwise
undefined — so a published `cost` was a number pi's footer reports as money
nobody spends. Its remaining fields disagreed with the vendor's own
`@cline/llms` package on most rows of this table: context window on 7 of 15,
output limit on 7 of 15, the effort enum on 6 of 15. And it could never supply
a lineup under this record's own rule, so it was metadata on paper and a live
dependency in practice: an unreadable catalog cost the provider its whole
catalog, not one field.

The "three docs-only ids publish with pi's defaults" consequence above is every
row's case now, and the committed artifacts carry the schema's numbers, not the
source's. `coding-agent/model-015-cloud-cline-pass.json` and its merged
`models.json` still hold the pre-amendment rows until the fleet generator runs
through `./environment.sh` (a key-less run blanks the gated layers instead, and
`freshness.sh` does not gate that folder — d191).
