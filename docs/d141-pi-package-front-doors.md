---
id: d141
type: architecture-design
status: draft
title: "d141 — every pi-* package is a module node: the extension family gets per-folder front doors"
parent: architecture
depends-on: [d100, d117, d118]
references: [d096, d097, d125, d042, d113]
tags: [docs, spec-graph, nesting, pi-extensions]
---

# d141 — every `pi-*` package is a module node

## Problem

Seven `pi-*` package folders existed with no node in the graph, and that was a
decision rather than an oversight: the standard's Rulings said a node-less folder
is legal and named these packages as the example ("installed by path, documented
in prose"), and d125's Placement section decided the same for the newest one.

The decision priced the family's prose and never weighed the graph. Each folder
owns a real contract — an `index.ts` the pi host loads, in four of them a
generator plus committed artifacts and a `--check` drift gate, a test suite, and
an `AGENTS.md` of folder rules — and none of it was reachable by the one edge
that answers "what belongs to this unit". Asked what governs `pi-verboo`, the
graph returned the family record (d100) and stopped: right about the shape, wrong
about the folder. The `Provenance` sections d100 made a family contract sat in
seven READMEs that no query could land on.

The bill showed up in the one folder that has a design note. `summarized-thinking`
was parented to `coding-agent` — not because the note describes the container
runner, but because `pi-summarized-thinking/` had no node to hang it from. d117's
file/edge agreement could only be satisfied by filing one extension's design note
under a different unit.

## Decision

**Every `pi-*` package is a module node, and its `README.md` is the front door:**
`type: module-design`, `parent: architecture`, `id` = its folder name — the shape
`estige/README.md` and `git/README.md` already use, and the file the standard
already lets a unit choose. Nothing else in those folders becomes a node:
`AGENTS.md` stays folder rules (operational prose for an agent editing the
folder), `TODO.md` / `PENDING.md` / `FINDINGS.md` stay prose. One spec per
genuine boundary, not per file.

- **The family's edges move onto the leaves.** Each front door carries
  `references: [d100, d118]` and `depends-on` the record that owns its shape —
  d096 for the catalog-carrying folders (`pi-synthetic`, `pi-hyper`,
  `pi-verboo`, `pi-cline-pass`), d097 for the two watchdogs (`pi-mistral`,
  `pi-opencode`). d100's split, which used to be prose in seven READMEs, is now
  a machine-readable edge per folder.
- **`pi-summarized-thinking` is `draft`**, because the package has no `index.ts`
  yet; its design note moved into the folder and parents to that node, so d117
  holds without the `coding-agent` fiction. d125 — the decision log for that one
  extension — moves with it, from `parent: coding-agent` to this node, since the
  scope test sends a single-extension record to the single extension. Its
  Placement section is superseded by this record and says so in its `## Status`;
  every other d125 decision stands, and the record stays the place a build must
  not re-litigate. The shape records (d096, d097) keep `parent: coding-agent`:
  each states a rule the family applies to several folders, so their scope is not
  one package.
- **The `pi-*` packages are siblings of `coding-agent`, not its submodules.**
  d118 says the pi host loads them — the container runner does not — so a parent
  edge into `coding-agent` would claim a dependency the code does not have. The
  family relationship is `references` to d100; the load path is d118's subject.

## Consequences

- "What belongs to `pi-verboo`" is one hop, and the seven folders stop being the
  one place in the tree where a unit's contract is only in prose.
- `docs/spec-graph-standard.md` is amended in four places: the nesting rules name
  the family, the node-less-folder ruling keeps its principle and loses its
  example, the `module-design` row of the Types table names a `pi-*` README, and
  the hand-maintained legal-parent roster in the no-tooling grep fallback gains
  the seven ids. The gate itself needed no code change — it derives the roster
  from `type` + `parent`, which is exactly the ruling d140 wrote for this case.
- Seven package READMEs now carry frontmatter, so an edit that renames a folder
  or retypes the node has to keep `id`/`parent` true. The `module-node` check
  enforces the mechanical half (`id` = folder name); the scope judgement stays
  reading work.
- Nothing was added for the folders' own sub-documents. d096, d097 and d100
  already own the shapes and the family rules; a per-folder decision record would
  be a fourth voice on a subject that has three.

## Alternatives rejected

- **Leave the family node-less** — the status quo, and the cheapest option. It
  keeps seven units out of reach of the "what belongs to X" edge, and it had
  already forced one design note to be misfiled to satisfy d117.
- **One node for the family** (`pi-extensions/`, or folding them under d100) — a
  parent edge names a code unit, and no such folder exists; d100 _is_ the family
  document, and a record can never parent. The seven packages are genuinely
  separate: separate manifests, separate tests, separate copy units (d113).
- **Make the `pi-*` folders submodules of `coding-agent`** — reads plausible and
  is wrong: the container runner does not load the extensions, the pi host does
  (d118). The edge would record a dependency that does not exist.
- **Give `AGENTS.md` the front door instead of `README.md`** — `AGENTS.md` is
  rules for an agent editing the folder, not a statement of what the package is
  for. The front door belongs to the file a human reads first.

## Verification status

The mechanical half is verified; nothing here observes runtime behaviour, and
none was expected to. `./node-run.sh docs/spec-check.mjs` is clean with the seven
new nodes in place: each passes `module-node` (id = folder) and `parent-level`,
and `summarized-thinking` passes `placement` in its new folder, which is the
check that only goes green once the file move and the reparent agree. The six
built packages' `README.md` bodies were already written; the change added
frontmatter and no new prose.

**Unconfirmed:** whether a per-folder node earns its keep in practice. The
argument here is structural (the graph had no answer at all), and the first
session that asks the graph about one of these folders is the evidence, not this
record.
