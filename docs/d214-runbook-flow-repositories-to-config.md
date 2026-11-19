---
id: d214
type: module-design
status: active
title: "d214 — the runbook follows repositories to models to generated configuration"
parent: llm-local-inference
depends-on: [d212]
references: [d197, d200, d210, hf-cache-upkeep, refresh-llm-local-inference-manifest]
tags: ["runbook", "cache", "curation"]
---

# d214 — the runbook follows repositories to models to generated configuration

## Problem

The unit's runbook (`refresh-llm-local-inference-manifest.md`) was written when the
model manifest was the first fact: it opened at "what changed in the cache", treated
the repo manifests as an input to generation, and left the step from a repository to
its entries implicit. The implemented chain runs the other way — the inventory names
the repos, their manifests say what they ship, the model manifest is the OUTPUT of a
promotion decision, and `config.d` plus `lib/curated/` are derived from it.

Doc order and system order disagreed. The cost showed up as invisible gaps: the
repository-to-entries step existed only as a tool nobody's runbook opened with, and
while reshaping the doc its Step 1 heading and a sentence the authority reversal had
just invalidated both survived a rewrite unnoticed.

## Decision

The runbook's steps follow the data, one step per artifact transition, each named
with the position d213 gives its tool:

1. **Inventory to repo manifests.** `lib/cache-scope.json` names the world;
   `10-fetch-hf-manifests.py` refreshes what those repos ship. Nothing outside the
   inventory is refreshed, audited or provisioned.
2. **Repository to model entries (the promotion).** `20-propose-entries.mjs` derives the
   servable quants from the repo manifest and prints a `models` fragment in the
   model manifest's own formatting. A human decides — which quant, which window,
   which family macro — and pastes it. The tool stops at the fragment; the model
   manifest is authoritative and the scope line is bookkeeping (d212).
3. **Curation.** `generate.mjs` applies the display rules, resolves each entry's
   projector and shards, and writes `lib/curated/<org>--<repo>.json` plus the
   `config.d` rendering from the same in-memory set.
4. **Provisioning.** `40-download-models.py` fetches exactly the curated files, after a
   free-space preflight.
5. **Verification.** `50-verify-cache.py` checksums the present served repos.
6. **Upkeep, audit and prune.** `upkeep.py` refreshes and drops detached
   revisions; `60-audit-snapshots.py` reports what the manifest does not
   declare; `70-prune-cache.py` erases it and any file that failed its
   checksum (d218).

A step that is judgement rather than programming is written as judgement. Step 2 is
the only place a human decides what is served; every other step is mechanical and
repeatable, which is what lets `run_all.py` run them in the same order with no human
in it — step 2 is deliberately absent from the driver.

## Consequences

- The runbook's Step 0 is the repository-to-model step, Step 3 is the human half of
  the promotion, and "regenerate" is curation rather than a separate chore.
- `run_all.py`'s order is the automatic subset of the same list (manifests first,
  because curation resolves files from them), so the doc and the driver cannot drift
  without the difference being an omission in one of them.
- A new artifact in the chain means a new numbered step and a new prefix, not an
  appendix: the doc's shape is the flow's shape.

## Alternatives rejected

**Keeping the doc manifest-first.** The reader must invert the chain mentally, and
every step's inputs are stated after its outputs.

**Making the promotion automatic** (a tool that merges entries into the manifest).
Rejected: the quant, window and macro choice is a serving decision, and a tool that
guesses it writes a catalog nobody chose. The fragment plus a human paste keeps the
decision where it belongs, at the cost of one copy-paste per promotion.
