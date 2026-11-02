---
id: d111
type: architecture-design
status: active
title: "d111 — adopting the spec-graph standard: five types, five statuses, a valid link graph"
parent: architecture
depends-on: [d042]
references: [d072, d101, spec-graph-standard]
tags: ["docs", "spec-graph", "taxonomy", "lifecycle"]
---

# d111 — adopting the spec-graph standard

## Problem

d042 gave this tree a documentation taxonomy — `requirements`, `reference`,
`design`, `research`, `decision` — and the tree followed it consistently. The
taxonomy was this repository's own invention. The tooling that reads these
files (the spec-graph validator, the workflow skills, anything that walks
`id` + `type` frontmatter) speaks a different, standard vocabulary: five
*nesting* types that say how a document relates to the code it describes, plus
a lifecycle `status`. Two vocabularies for one job means a reader has to hold
both, and the validator can only see the one it was written for.

The drift had already become structural. A validation pass over the tree
before this record found:

- **1 duplicate id** — `d090` claimed by two records;
- **44 dangling links** — `parent`/`depends-on`/`references` pointing at ids
  that do not exist, including 14 files still naming `llm-reverse-proxy` after
  d101 renamed that folder to `estige`;
- **14 decision records with no frontmatter at all** (d001, d003–d006, d009,
  d010, d012–d014, d018, d020, d021, d046) — invisible to the graph;
- **3 files whose `id:` disagreed with their own filename** (`d026`, `d028`,
  `container-tooling.md → id: lib`), so references were split between two
  spellings of the same node;
- **3 dangling edges in `.agents/skills/SPEC.md`**, pointing at package-level
  specs that exist in the workflow package, not in this workspace;
- **98 of 115 `status:` values off-standard** (`implemented` ×49, `draft`
  ×15, `accepted` ×8, `active` ×7, `findings` ×7, `stable` ×6, `proposed`
  ×3, `superseded` ×2, `archived` ×2 — many carrying long free-text
  qualifiers that made the value unparseable as a lifecycle state).

A bespoke vocabulary is not the problem by itself; a bespoke vocabulary *plus*
tooling that cannot read it is. The failure mode is silent: nothing breaks
until someone needs the graph, and then a third of the links resolve to
nothing.

## Decision

Adopt the spec-graph standard as the tree's vocabulary, and keep the file
layout exactly as it is.

**Types** — every spec is one of five, chosen by scope:

| type | scope |
| --- | --- |
| `goal-and-requirements` | what the system must do, normative (one document, `docs/requirements.md`) |
| `architecture-design` | a decision or description that spans the repository or crosses module boundaries |
| `module-design` | a decision or description confined to one runner folder (`coding-agent/`, `estige/`, `lib/`, …) |
| `submodule-design` | a directory-level subsystem inside a package (e.g. `estige/CI.md`) |
| `task-spec` | a single piece of work, with acceptance criteria — none exist in this tree today |

**Lifecycle** — `status:` is one of `draft`, `active`, `stale`, `done`,
`deprecated`, and nothing else. Detail that a legacy status used to carry
inline ("superseded by d084") moves into a `## Status` section of the record's
own body, where it can be read as prose and cannot break the parser.

**Layout stays.** Module docs remain `README.md` + `DESIGN.md`; no `SPEC.md`
renames, no `docs/reference/` or `docs/design/` subdirectories. d042's anchor
constraint (eight living docs referenced by path from d0XX bodies) and its
numbering constraint (no section numbers, no `§` cites) both still bind — they
are about *history and pointers*, not about the type vocabulary, and they were
not the part that drifted.

`docs/spec-graph-standard.md` restates the contract that binds from now on, so
the rules survive without the tooling that motivated them.

## What changed

- Graph repair: frontmatter written for the 14 bare records, the `d090`
  collision split into `d090` (tunnel env) + `d116` (harness tiers), ids
  restored to filename stems on d026/d028,
  `container-tooling` references repointed to `lib`, and `llm-reverse-proxy`
  edges repointed to `estige` across 14 files.
- Suffix retirement (later pass): the interim `b` handles this repair invented
  for the three colliding numbers — `d090b`, `d027b`, `d046b` — are gone. The
  id rule in `docs/spec-graph-standard.md` now settles a collision by moving
  the *least-cited* record to the next free number, so `d116` (harness tiers),
  `d114` (models.dev relay fallback) and `d115` (live-listing input schema)
  took the tail and the plain numbers went to the survivors. Renumbering is
  the churn the rule minimizes, not a free action: it is allowed only when two
  records already share a number.
- Type retype: `requirements` → `goal-and-requirements`; `reference` and
  `design` → `architecture-design` or `module-design` by scope; `research` →
  the same two types with `status: done`; `decision` → `architecture-design` /
  `module-design` per record, with `bugfix` kept as a tag on d040/d115/d051
  where the genre still matters.
- Status normalization: `implemented`/`accepted`/`adopted*`/`stable`/`current`
  → `active`, `proposed`/`deferred` → `draft`, `findings` → `done`,
  `superseded`/`archived` → `deprecated`. Qualifiers moved into body `##
  Status` sections, never dropped. Five records additionally carried a second,
  stale `status: … · relates-to: …` line in their body; those became Status
  prose and their `relates-to` ids moved into `references`.
- `.agents/skills/SPEC.md` lost its three edges into the absent package specs
  (the file vendors a package; the package's nodes are not this workspace's
  nodes).
- The vocabulary reached the places that described docs by the old taxonomy:
  `docs/requirements.md` (its scope bullet and FR-D1), the taxonomy pointer at
  the end of `docs/architecture.md`, `README.md`'s folder-layout comment and
  documentation index (regrouped into the five type sections), and
  `docs/archive/README.md` (its status column and reading note).
- `AGENTS.md` gained the pointer to `docs/spec-graph-standard.md` so an agent
  that never loads the ThinkRail skills still reads the contract.

## Alternatives rejected

**Keep d042's taxonomy and teach the tooling to read it.** The validator is a
generic consumer; every downstream reader would need a mapping table forever.
The mapping is one-way and cheap to do once — the reverse is a permanent tax.

**Migrate the layout too** (`DESIGN.md` → `SPEC.md`, specs for `lib/`, `git/`,
`tests/`, `pi-*/`). That is a much larger change with no bearing on graph
validity, and it collides with d042's anchor constraint. Type is metadata;
placement is a separate argument to have on its own merits.

**Delete the off-standard-status records or freeze them as-is.** Both lose
information: the records are live context, and the qualifiers that made their
statuses unparseable are exactly the supersession pointers a reader needs.

## Consequences

- One vocabulary. `grep '^type:'` and `grep '^status:'` are now complete
  answers to "what is this document and where is it in its life".
- Type is scope, not genre. "This was an investigation" is expressed by
  location (`docs/archive/`) and `status: done`, not by a fourth type.
- The decision log keeps its genre flavor as a `bugfix` tag rather than as a
  type — tags are additive and never compete with the nesting types.
- `docs/spec-graph-standard.md` is the normative statement; this record is the
  history of how the tree got there. A future drift shows up as a failing
  validation run, not as a quiet divergence.
- d042 stays active for its anchor and numbering constraints, with its
  taxonomy table kept as history.

## Verification record

- Before: `spec_validate` reported 1 duplicate id + 44 dangling links. After:
  `spec_validate` reports no issues.
- Type census over 134 spec files: `architecture-design` ×44, `module-design`
  ×87, `submodule-design` ×2, `goal-and-requirements` ×1 — no off-standard
  value, no file without a type.
- Status census over the same 134: `active` ×102, `draft` ×21, `done` ×7,
  `deprecated` ×4 — no off-standard value, no file without a status, and no
  `status:` line left anywhere in a record body.
- Frontmatter parse check across the tree: every `id:`-bearing file opens and
  closes its frontmatter block with `---` and parses as YAML (three records
  had colon-space statuses that silently broke parsing before this pass).
