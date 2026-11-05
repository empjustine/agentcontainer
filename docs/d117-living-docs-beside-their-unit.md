---
id: d117
type: architecture-design
status: active
title: "d117 — a living document lives beside the unit its parent edge names"
parent: architecture
depends-on: [d042]
references: [d112, d113]
tags: ["documentation", "spec-graph", "placement"]
---

# d117 — living docs live beside their unit

## Problem

`docs/` collected seven living documents that guide exactly one unit, and their
graph edges say so already: `coding-harness-persistence`, `scoped-models-and-proxy-overrides`
and `summarized-thinking` carry `parent: coding-agent`; `gguf-model-tooling`,
`gguf-vram-fit-estimates`, `hf-cache-upkeep` and `refresh-llm-local-inference-manifest`
carry `parent: llm-local-inference-cache`. Their files sat in `docs/` anyway.

Two laws in this repo then disagree, and the path is the one readers follow:

- d112's nesting standard says the document tree mirrors the code structure —
  a document sits beside the code unit it describes. These seven have the right
  edge and the wrong path, so the mirror is broken precisely where a reader
  navigates.
- d113 makes a folder a copy unit that works alone. A standalone
  `llm-local-inference/` checkout could build and run, but its own runbook
  (`hf-cache-upkeep.md`), its manifest refresh procedure and its generated
  tables would not be in it — the unit would ship code without the instructions
  that operate it.

The old justification was d042's **anchor constraint**: eight living docs are
named by path from d0XX bodies, so moving them meant editing history. That
constraint priced the move but never weighed the benefit, and since d072 a path
cited from a record may move as long as the record is updated with it. The
price is a handful of path edits; the benefit is that every unit checkout
carries its own documentation and `docs/` stops being a second home for
single-unit reference.

## Decision

**A living document's file lives beside the node its `parent` edge names.**

- `parent: <unit id>` → the doc sits in that unit's folder. Its name stays
  topical rather than being normalised to `DESIGN.md`: the folder already
  separates "what this is" (README) from "why it is shaped this way" (DESIGN),
  and a runbook or a generated-table doc is neither (`git/non-bare-issues.md`
  and `estige/CI.md` are the precedent).
- `parent: architecture` or `parent: goal` → the doc stays in `docs/`: it is
  cross-cutting by definition, because the parent edge already went through
  d112's scope test.
- **The decision log stays in `docs/` regardless of `parent`.** `docs/dNNN-*.md`
  is history, not guidance: the records are one chronologically indexed set that
  cites itself by number and path, and splitting them by topic would break the
  index and every cross-record path cite.
- `docs/archive/` stays, for the same reason (a retired document's subject no
  longer matters; its record does).

The test for a new doc is therefore one question, answered before the file is
written: **does it guide one unit?** If yes it belongs in that unit and its
`parent` names the unit; if it guides the whole repo it belongs in `docs/` and
its `parent` is `architecture`. The two facts must agree — and when they
disagree, **the edge wins**, because the edge carries the scope judgement while
the path carries only habit.

## The moves this record makes

| from                                        | to                                                  | why it is single-unit                                   |
| ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `docs/coding-harness-persistence.md`        | `coding-agent/coding-harness-persistence.md`        | the per-harness state dirs `coding-agent/run.sh` mounts |
| `docs/scoped-models-and-proxy-overrides.md` | `coding-agent/scoped-models-and-proxy-overrides.md` | the coding-agent container's generated config           |
| `docs/summarized-thinking.md`               | `coding-agent/summarized-thinking.md`               | one pi extension's design note                          |

One row has since moved a second time: `summarized-thinking.md` now sits in
`pi-summarized-thinking/`, beside the node that owns it, once docs/d141 gave that
package its own front door. The rule above is unchanged — the second move
applies it rather than departing from it.
| `docs/gguf-model-tooling.md` | `llm-local-inference/gguf-model-tooling.md` | this unit's manifest tooling |
| `docs/gguf-vram-fit-estimates.md` (+ `.data.json`) | `llm-local-inference/` | tables this unit's tooling generates |
| `docs/hf-cache-upkeep.md` | `llm-local-inference/hf-cache-upkeep.md` | this unit's cache upkeep runbook |
| `docs/refresh-llm-local-inference-manifest.md` | `llm-local-inference/refresh-llm-local-inference-manifest.md` | this unit's manifest refresh runbook |

Ids are unchanged: an id is an identity, not a filename
(`docs/spec-graph-standard.md`), and every stem stays equal to its id, so the
move costs no graph edge. Relative links inside the moved docs are rewritten
one level down (`docs/d0NN-…` → `../docs/d0NN-…`, `archive/…` →
`../docs/archive/…`), and every path cite in the tree is retargeted in the same
change.

What stays in `docs/` after this record: `requirements.md` and
`architecture.md` (the living tree's roots), `spec-graph-standard.md`
(the process contract), `container-tooling.md` (`workload-api` — consumed by
several units), `environments-and-variants.md`, the Termux and VM host docs,
the two reference-farm prior-art surveys, the credential-identity research, the
decision log, and `archive/`. Each of those either spans units or describes the
repo itself.

## Consequences

- A unit checkout is complete in prose as well as in code (d113): the runbook
  for a tool ships inside the folder that holds the tool.
- `docs/` becomes a _cross-cutting_ tree, so its index rows stop competing with
  unit READMEs for "where do I read about X".
- Every path cite in a d0XX body is maintained by hand (d072 permits it) — the
  cost is paid once per move and the alternative is a permanently two-homed
  documentation set.
- Reversible: a doc that turns out to serve two units moves back to `docs/` and
  its `parent` becomes `architecture`. The rule is not "unit folders own
  everything"; it is "the edge and the path say the same thing".
- The README index stays **type-first** in what it does describe (a pattern a
  type owns, not a folder's inventory), so a reader looking for a runbook still
  starts under the module-design pattern. It no longer carries a row per doc
  (see the amendment in [d042](d042-documentation-taxonomy.md)); where a moved
  doc _is_ named — the start-here path — the path simply changes.

## Alternatives rejected

- **Fix the edges instead of the paths** (retag the seven as
  `parent: architecture`). Cheapest, and it makes the graph lie in the other
  direction: a doc about one folder's runbook would claim repo-wide scope, and
  the tree's mirror of the code would stay broken.
- **Split the decision log by topic into unit folders too.** It would break the
  chronological index and every cross-record path cite, to gain nothing: a
  record's reader arrives by number, not by folder.
- **`docs/<unit>/` subfolders.** Keeps `docs/` as the one tree, but a standalone
  unit checkout still would not contain its own docs — exactly the d113 failure
  this record closes.
- **Rename every moved doc to `DESIGN.md`/`README.md`.** Forces a runbook to
  pretend to be a design doc; the topical name is what a reader searches for,
  and `git/` and `estige/` already establish that precedent.
