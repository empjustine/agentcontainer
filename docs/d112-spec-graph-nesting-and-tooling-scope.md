---
id: d112
type: architecture-design
status: active
title: "d112 — the spec-graph standard states what the tooling does, and the tree's nesting drift is closed"
parent: architecture
depends-on: [d111]
references: [spec-graph-standard, d042, d072]
tags: ["docs", "spec-graph", "nesting", "tooling"]
---

# d112 — the standard states the tooling's real scope, and the nesting drift is closed

## Problem

d111 adopted the five-type vocabulary and repaired the link graph, and
`spec_validate` has been green since. Green turned out to be a weaker claim than
the standard made it: the file said "the tooling checks the graph; this file
defines it", then described rules the tooling does not implement.

Probing the ThinkRail tooling directly (v0.3.0) showed `spec_validate` reports
exactly three things — duplicate ids, `parent`/`depends-on`/`references`/
`implements` values that resolve to no node, and parent cycles:

- `type: reference` with `status: implemented` validates clean — the five-type,
  five-status vocabulary is this file's rule, never the validator's.
- A spec with no `title:` validates clean, though `spec_create` refuses to write
  one without it.
- `covers: [definitely-not-an-id]` produces no finding — the field is written by
  the tools and never resolved.
- A record as `parent`, and a module-scoped record parked at `architecture`,
  both validate clean. Those are the two drifts the standard's own nesting
  section forbids, which is why it had to carry a hand-maintained snapshot.

And that snapshot was still outstanding. Taken in d111's pass, it listed 33
misplaced nodes, a missing `git` module node, and the instruction to delete the
subsection once the nesting checks came back clean. They had not: 13 records
hung off other records, 9 specs hung off the BRD instead of `architecture`, 10
module-scoped specs sat at the system level, `d026` was `architecture-design`
but nested under `lib`, and `termux-serving` hung off a reference doc. A
validator that cannot see any of it reports success on all of it.

Two smaller defects surfaced while measuring the tree: eight `docs/archive/`
specs had no `title:` (the one required field the validator ignores), and
`model-architecture-findings.md` never closed its frontmatter block, so its H1
parsed as a YAML comment and the block swallowed the body.

## Decision

**The standard describes the tooling as it is, and keeps only the rules a
human must enforce.** `docs/spec-graph-standard.md` gains a section naming the
validator's three reports and the five contract rules it is silent on; `title`
becomes required in the field table, `covers` is marked written-but-unresolved,
and the two node locations outside the docs tree (`.thinkrail/context/TASK-*`
task-specs, the single vendored `.agents/skills/SPEC.md`) are documented — with
the consequence that a second copy of the vendored file is an immediate
duplicate-id failure, because the tooling has no exclude list.

**`parent` follows the code unit, and `type` follows scope.** Apply the scope
test from the standard to every node, and the two decisions cannot disagree:
delete the module — does the decision still hold?

- still holds → `architecture-design`, parent `architecture`;
- void → `module-design`, parent that module's node.

A record that spans several modules is therefore `architecture-design`; one
confined to a single module is `module-design`, even if it was written as a
system-wide step in a sweep. Nothing types itself `module-design` and lives at
`architecture` any longer, except the archived investigations that have no
module left to hang from; nothing parents to a record.

**`git/` gets a node of its own** (`git/README.md` → `id: git`). The farm
tooling owns decisions — mirror maintenance, the Windows port, the search
surface — and the module node is what makes a subtree walk at `git` complete
instead of empty. Where a record's former parent was a record, the chain edge
moves to `depends-on`, which already carried the same information.

## What changed

- **Nesting**: 9 nodes moved to `architecture` — 7 that hung off the BRD
  (`d015 d023 d024 d025 d027 d072`, `environments`) plus `d026` (was under
  `lib`) and `termux-serving` (was under the `environments` doc); 9
  module-scoped records → `coding-agent` (`d022 d030 d035 d036 d040 d051 d056
  d057 d059`); `d031 d047 d080 d103` → `estige`; `d029` → `local-llm`; `d087`
  → `llm-local-inference`; `d062 d089` and `git-non-bare-issues` → `git`.
- **Retypes**, both directions, on the scope test: `d058` (simulation modes),
  `d060` (remaining flags) and `d063` (proxy-only routing) are repo-wide laws
  → `architecture-design`; `d062` (Windows mirror maintenance) and `d089`
  (maintenance passes) are confined to the farm → `module-design`.
- **Chain edges preserved**: `d039 d041 d051 → d023`, `d040 → d037`, `d056
  d083 → d041` added to `depends-on`; `termux-serving` keeps `environments` as
  a `references` edge.
- **Contract**: the field table now marks `title` required and `covers`
  unresolved, the "nothing else is mandatory" sentence no longer reads as
  permission to skip a title, and the `task-spec` row describes its real
  lifetime instead of claiming none exist.
- **Checks**: regrouped by name (contract checks / nesting checks) rather than
  by number, with a missing-`title` check added; no check is cited by number
  anywhere in the tree.
- **Repairs**: `title:` on the eight archive specs; `model-architecture-findings`
  given its closing `---`.
- **Snapshot deleted** from the standard once the nesting checks came back
  clean, per its own instruction — this record is where its history lives now.

## Alternatives rejected

**Fix the standard's prose and leave the drift.** The tree would then document a
shape it does not have, and the snapshot would have to be re-taken and
re-verified by hand on every pass — the exact maintenance cost the section
existed to avoid.

**Delete the snapshot without repointing anything.** The snapshot's own
condition is that the nesting checks come back clean; deleting it first turns
the only record of the drift into a lie in a file agents are told to trust.

**Make every module-scoped record `module-design` at its module by file paths**
(`docs/*.md` → `architecture`, everything else per folder). `docs/` is a file
layout, not the graph — several `docs/` files describe exactly one module
(`gguf-model-tooling` is `local-llm`, `coding-harness-persistence` is
`coding-agent`) and several folder-local files describe the whole system.

**Reach for `covers` instead of `references`.** The tooling writes it, no tool
reads it, and it has no edges in `spec_get`; a link nobody resolves is worse
than no link.

## Consequences

- A subtree walk at `coding-agent`, `estige`, `git`, `lib`, `local-llm` or
  `llm-local-inference` now returns the records that shaped that module. That
  is the only thing the `parent` edge is for.
- The tree has one root chain — `goal → architecture → 7 module nodes` — and one
  submodule (`estige-ci`). No record is a parent, so no subtree can omit a
  decision by hiding it under its predecessor.
- Five module-scoped archive investigations still sit at `architecture`. They
  have no module left to hang from (the folders were retired or renamed), and
  the standard says so rather than inventing an edge.
- `docs/spec-graph-standard.md` no longer claims a validator guarantee it does
  not have. What the tooling does not check, a reader (or the shell checks it
  carries) now does.
- Removing the snapshot rule means it cannot rot: the nesting rules are
  mechanical, and both automated checks print nothing when they hold.

## Verification record

- `spec_validate` → valid (no duplicate ids, no dangling links, no cycles)
  after every step.
- Census over 146 id-bearing files (`.thinkrail/` excluded as tool-owned,
  `.agents/skills/SPEC.md` and this record included): `architecture-design` ×50,
  `module-design` ×93, `submodule-design` ×2, `goal-and-requirements` ×1 —
  no off-standard value, and every file carries a `title:`.
- Status census over the same 146: `active` ×106, `draft` ×22, `done` ×10,
  `deprecated` ×8.
- Nesting checks: parents outside the code-unit roster → empty (the roster is
  `goal`, `architecture`, seven module nodes); records used as parents → empty;
  `module-design` parked at `architecture` → the five archived investigations
  only.
- Parent census: `architecture` ×59, `coding-agent` ×42, `estige` ×26,
  `llm-local-inference` ×5, `local-llm` ×5, `git` ×3, `lib` ×2, `goal` ×1
  (the `architecture` node itself) — plus this record at `architecture`.
