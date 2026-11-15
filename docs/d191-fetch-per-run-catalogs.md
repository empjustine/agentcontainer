---
id: d191
type: module-design
status: active
title: "d191 — the catalogs are fetched per run: no committed catalog, no fact cache"
parent: coding-agent
depends-on: [coding-agent, d086, d122]
references: [d021, d023, d032, d033, d057, d086, d096, d122, d189, d190]
tags: ["coding-agent", "catalog", "models.dev", "facts", "generation", "staleness"]
---

# d191 — the catalogs are fetched per run

## Status

Amends d021, d023, d039, d057 and d086. d190 removed the remembered LINEUP (a
registered model list, a seed, a carried-forward layer); this record removes the
remembered CATALOG behind it — the vendored models.dev mirror and four fact
caches — and the machinery that only existed to keep them. d122 still owns the
freshness gate, now over generated artifacts alone.

## Problem

Five committed JSON documents held upstream catalogs, every one refreshed by
copying over itself and every one read by the next run:

| file                      | what it held                           |
| ------------------------- | -------------------------------------- |
| `lib/models.dev.api.json` | the whole models.dev catalog (~8.4 MB) |
| `lib/catwalk-facts.json`  | Charm's multi-provider catwalk listing |
| `hyper-facts.json`        | hyper's `/provider` records            |
| `synthetic-facts.json`    | synthetic's `/models` records          |
| `verboo-facts.json`       | verboo's `/models` records             |

They were defended as a stale-tolerance contract: a failed fetch "degrades to
the last good copy" and generation continues (d021, d086). That reads as
resilience and behaves as a remembered catalog — the same failure d189 and d190
removed one layer up, because a fetch that did not answer is the one honest
signal that the provider is not serving. The drift was measurable, not
theoretical: the committed mirror carried 235 providers against the live 330,
the hyper layer 26 ids against 19 live, the synthetic layer 8 against 11.

Two more costs followed the files. `lib/fact-table.mjs` existed only to make a
committed cache diff reviewable — canonical ordering, a hash short-circuit so
an unchanged refresh writes nothing, a `_meta` provenance block, a
`fetchedAt` that means "when the content moved". With nothing committed,
there is no diff to keep quiet and no reader of `fetchedAt`. And
`catalog-facts.mjs` carried a read/write pair per source plus a CLI whose
whole job was refreshing files that no longer exist.

## Decision

**Every catalog read is a fetch in the same run.** The rules:

- **No committed catalog and no cache file.** The models.dev payload is written
  into the run's own output dir (`$PI_LAYER_DIR`, deleted with the run) only
  because the generators are spawned processes and need a path; the facts
  catalogs are handed over in memory. Nothing a later run reads is written.
  The file's name in that dir is the whole contract — no env var names it, so
  `MODELS_DEV_JSON` and `modelsDevCatalogPath()` are retired with the caches
  they used to point at. A manual generator run simply has no catalog.
- **A failed catalog fetch aborts the run.** models.dev is where every row's
  prices, limits and display names come from, so a run without it would publish
  layers that claim what it never saw — fail closed, like a failed provider row
  (d063). `refresh-models-dev.mjs` takes its out path as a required
  argument, and a run without a catalog has no way to fall back.
- **A provider listing that cannot be fetched publishes nothing.** The row goes
  empty, the reason is logged, and no cache stands in (d190's rule, unchanged by
  where the data came from).
- **The churn recipe goes with the files.** `lib/fact-table.mjs`, the
  `publishFactCache`/`canonicalizeFactsCache` pair, the cache canonicity
  guard, the `<ID>_FACTS_JSON`/`CATWALK_FACTS_JSON` overrides and the
  `catalog-facts.mjs` CLI are deleted. `canonicalizeProviderCatalog` stays:
  a layer's model ORDER follows the catalog's, and the fetched payload is
  canonicalized on the way into the run dir so two runs on the same facts
  produce the same artifact (d050).
- **What stays committed is what a reviewer reads.** `models.json`, the
  `model-*.json` layers and each pi extension's `models.json` are OUTPUTS of a
  run under d122's freshness gate. A generated artifact states what one run
  saw; it is not an input to the next one.

## Consequences

- **Generation needs the network.** A host that cannot reach models.dev or the
  provider listings cannot generate — by design: it also cannot see the data
  the artifacts describe. The offline story is the reviewed snapshot, not a
  regenerated one.
- **`./freshness.sh` keeps its scope.** The pi-* extension artifacts are still
  compared against their upstreams; the coding-agent layers stay outside that
  gate for the reason recorded there, and the catalog is no longer a fixture the
  gate could compare.
- **The diff of a run is the whole truth.** A provider that vanished is a
  vanished row, not a row preserved by a cache that happened to agree with it.
- **Deleting the mirror deletes the trap.** d021's "skip providers, do not
  abort" rule described a fallback whose existence invited a stale catalog to be
  published; with no fallback, the choice it governed is gone.

## Alternatives rejected

- **Keep the catalog and gate it by age.** An age threshold still publishes a
  catalog nobody verified today, and the failure mode it prevents — no catalog
  at all — is the one that should stop the run.
- **Keep the fact caches as offline fixtures for tests.** The tests build their
  own records; a fixture that mirrors production would drift silently and
  reintroduce exactly the file this record deletes.
- **Fetch per provider instead of the whole catalog.** models.dev publishes one
  document; splitting it into 330 fetches trades one request for many and
  invents a partial-catalog state (no prices for the rows that failed) that
  nothing else in the pipeline expects.

## References

- d190 — the lineup half of this rule; this record covers the catalog half.
- d189 — the cline-pass docs-table contract, whose lineup also comes from a
  live read.
- d086 — the churn recipe this record retires; its capability-URL gate stands.
- d021 — the "unreadable catalog skips providers" rule, retired here.
- d122 — the freshness gate over generated artifacts.
- d050 — the deterministic-artifact rule the fetched payload still obeys.
- d063 — fail-closed generation.
