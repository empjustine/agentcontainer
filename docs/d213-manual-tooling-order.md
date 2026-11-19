---
id: d213
type: architecture-design
status: active
title: "d213 — manual-intervention tooling is named in runbook order"
parent: architecture
depends-on: [d102, d113]
references: [d212, d214]
tags: ["tooling", "naming", "runbook"]
---

# d213 — manual-intervention tooling is named in runbook order

## Problem

A runbook tells a human to invoke tools in a sequence, and the tools' names carry
none of it: `download_models.py`, `generate.mjs`, `fetch_hf_manifests.py` and
`verify_cache.py` sort in an order unrelated to the flow they belong to. The
sequence lives only in the prose, so every reader re-derives it, every new tool
needs a table row to place it, and `ls` or a tab-completion offers an ordering
that is actively misleading.

The repository's own alternative to a table — grouping by verb, prefixing with a
noun — was tried implicitly and failed: the unit's tools grew verbs from different
vocabularies (`fetch`, `download`, `generate`, `verify`, `audit`) that do not
compose into a chain.

## Decision

**Any tool a runbook tells a human to invoke by hand carries a name whose
lexicographic order IS the runbook order.** A numeric prefix states the position
once, in the filesystem:

    10-fetch-hf-manifests.py     inventory -> repo manifests
    20-propose-entries.mjs       repo -> model entries (the promotion aid)
    generate.mjs              curation -> curated manifests + config.d
    40-download-models.py        provision the curated files
    50-verify-cache.py           checksums
    60-audit-snapshots.py        what the serving set no longer claims

The rule is scoped to manual intervention: a tool a human types mid-runbook,
where "what comes next" is the question being answered. Two kinds of tool are out
of scope and keep descriptive names:

- a pipeline driver a human runs as one command (`run_all.py`): its order is
  internal, the filesystem has no opinion to offer;
- a library (`lib/model-entries.mjs`, `lib/log.py`): never typed, imported.

A gap in the numbering is deliberate and permanent: the prefix states a position,
so inserting a step later takes the next free slot rather than renumbering
everything that follows.

## Consequences

- The rename landed with this record: `10-fetch-hf-manifests.py`,
  `20-propose-entries.mjs`, `30-generate.mjs`, `40-download-models.py`,
  `50-verify-cache.py`, `60-audit-snapshots.py`. It moved
  `knip.jsonc`, the README folder rows, every runbook command and the tests'
  entry names in one commit, because a half-rename leaves a runbook naming files
  that no longer exist.
- A tool a runbook documents but that sits OUTSIDE the chain keeps its
  descriptive name: the card mirrors (
  `fetch_model_cards.py`) and the upkeep sweep (`upkeep.py`) are
  side tasks, and a prefix would claim a position they do not have.
  no longer exist.
- The numeric prefix is a runbook fact, not an API: nothing imports these tools by
  module path (PEP 723 scripts and Node entries are executed by path), so the
  prefix cannot leak into a contract.
- A tool whose position is genuinely ambiguous is a sign the runbook has two flows;
  the fix is to split the doc, not to reuse a number.

## Alternatives rejected

**Sorting the runbook to the names.** Then the prose carries the order and the
directory listing still lies. The rule exists so the listing is the answer.

**A manifest or table of contents listing the order.** A second list to keep in
sync with the first, and the failure mode is silent: the table is right and the
names are not.

**Module layout with a package directory** (`python -m`). Not this repo's idiom
(PEP 723 scripts run by path, the copy-unit rule), and it does not solve ordering:
a package listing is alphabetical for the same reason.
