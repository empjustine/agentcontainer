---
id: d230
type: module-design
status: active
title: "d230 — one Hub fetch owns repo manifests and model cards"
parent: llm-local-inference
depends-on: [d212, d213, d214]
references: [d072, hf-cache-upkeep]
tags: ["hf-cache", "tooling", "manifests", "cards"]
---

# d230 — one Hub fetch owns repo manifests and model cards

**Status: landed.** `10-fetch-hf-manifests.py` mirrors each in-scope repo's
README to `model-cards/<org>/<repo>.md` in the same pass that persists its tree
manifest; `fetch_model_cards.py` and its pipeline step are gone.

## Problem

Two tools made the same Hub round trip over the same closed repo set: one
listed the tree and audited `:quant` labels, the other fetched the README a
promotion reads before choosing a quant. Both needed `HfApi`, token auth, the
same scope file and a committed refresh, and each could fail while the other
succeeded. The split also put the card mirror outside the numbered chain
(d213), so a run that refreshed facts could leave the promotion's other fact
stale.

The language difference between the fetcher and the proposal aid (d212) was
never the reason these two could not merge: the aid is offline Node, and the
card mirror was Python Hub I/O with the same inputs as the manifest refresh.

## Decision

The repo-driven refresh in `10-fetch-hf-manifests.py` writes both facts. For
each repo in `lib/cache-scope.json` plus any served row whose scope line drifted
(d212), it resolves `main`, persists the tree, and downloads the root README at
that same commit into `model-cards/<org>/<repo>.md`. The tree drives the audit;
the README does not. `--offline` reads the committed copies and fetches nothing.
A card fetch error is reported and fails the tool, like an audit mismatch; a
repo with no root README is a fact, not a failure.

The proposal aid (`20-propose-entries.mjs`) stays offline and unchanged: the
judgment step remains a human's (d214). Cards never enter the generator.
`run_all.py` loses one step.

## Consequences

- One Hub pass per repo: manifest and card share auth, revision and failure
  reporting. The audit reuses the manifests the refresh loop already loaded,
  so a repo is listed once.
- The card path stays `model-cards/<org>/<repo>.md` — the id verbatim, matching
  the runbook and the derived model ids. Existing mirrors need no rename.
- A gated repo's card uses the same `HfApi`/`HF_TOKEN` as its tree instead of a
  second unauthenticated HTTP client.
- The card assertions moved from the retired tool's test into the fetcher's;
  one test owns both artifacts.

## Alternatives rejected

**Keeping the card mirror as a side task.** Two Hub clients over one repo set,
two failure paths and an order a human must remember — the cost d213's naming
rule was meant to remove, not preserve.

**Folding the card into `20-propose-entries.mjs`.** That tool is offline Node and
prints a fragment for a human; a network read there mixes a judgment step with
a fact fetch (d214).

**A single fetcher that also owns weights.** `40-download-models.py` reads
curated manifests and preflights free space; trees and cards are kilobytes,
weights are not (d212's accounting rule).
