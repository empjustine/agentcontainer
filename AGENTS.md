# AGENTS.md — working rules for this repository

Instructions for coding agents (pi and others) operating in this repo.
`docs/architecture.md` treats this file as repo-owned infrastructure, like
`biome.jsonc`.

## Comments: explain WHY, never HOW

This codebase is deliberately **comment-verbose — but only about intent**.
Comments exist to record what the code cannot say for itself:

- **WHY** the code exists, why this approach and not the obvious one
- history / decision context (what drifted, what bug forced the shape)
- invariants, contracts, gotchas, and non-obvious consequences
- pointers to the design doc or ADR that owns the full rationale

Comments must **not** restate the HOW. If a comment narrates what the next
lines do, delete the comment and make the code say it instead, by choosing
**correct, unambiguous names** for functions, types, classes, and variables.

```js
// BAD — HOW, restates the code
// loop over providers, read key from env, then push the object
for (const provider of providers) { ... }

// GOOD — WHY, names carry the mechanics
// Every consumer must derive the key env from this one table so a base-url
// change is a single edit (docs/d024).
for (const provider of providers) { ... }
```

The test: if renaming the function/variable could absorb the comment, the
comment is a naming failure, not documentation. Fix the name.
A long HOW explanation embedded in a code header is a signal that the content
belongs in `docs/`, with a short pointer left in the code.

### Prefer metadata over prose comments

A comment that only restates machine-readable facts should become that
metadata instead — tooling (editor hovers, `tsc`, IDE navigation) can then
surface it, and it cannot drift out of sync with the signature:

- **Parameter/type invariants → JSDoc.** What a value must be, what it means,
  or what a caller may rely on belongs in `@param`, `@property`, `@returns`,
  `@typedef`, or a `@type` annotation — not a `//` beside the argument.
  A comment above a constant that describes its shape/contract becomes the
  constant's JSDoc (e.g. `@type {readonly string[]}` plus the invariant).
- **Whole-file behavior → `@fileoverview`.** What the file is for, its
  contract, usage, and env surface belong in the ESM `@fileoverview` block at
  the top, not scattered across a plain header comment.
- **Trivial HOW is deleted, not rewritten.** If the shape of the code (or the
  adjacent `@fileoverview`/doc) already says it, remove the comment. Do not
  replace one redundant comment with another.

WHY comments (intent, history, gotchas, doc pointers) stay — they are the
reason this repo is comment-verbose. The rule is only that a comment must not
be a worse rendering of metadata the code can carry itself.

## Design docs are the home for HOW

`docs/` (especially the numbered `d0XX-*.md` decision records) owns the full
mechanics: data flow, file formats, refactor history, worked examples. Code
comments should stay short and point at the owning doc (`docs/dNNN`) rather
than duplicate it. When a code comment grows into a design essay, move it to
`docs/` and refer to it from the owning spec (`docs/dNNN` in a body, or the
`references` edge in frontmatter) — `README.md`'s documentation index states
the *patterns* and does not list documents.

`docs/architecture.md` describes the whole-folder stand-alone rule, and
`README.md` carries the type patterns plus a short reading path.

## Decision records: no number indexing

`docs/d0XX-*.md` records must not number their sections (`## 1. Problem`)
and must not cite sections by number — neither internally (`§2`, "see §5")
nor into other records (`d079 §2.4`). Use named headings (`## Problem`,
`## Decision`, `## Consequences`, `## Alternatives rejected`) and
reference content by name ("see the Verification status", "d042's anchor
constraint").

Numbers rot silently: a heading rename or reorder breaks every number
pointer to it, and a section-number cite crossing records turns one record's
renumbering into edits across the whole tree. Named headings survive
reordering — at most one prose reference needs updating — and read without
the reader counting sections.

This binds new records and new text only. Existing records keep their
historical numbering: never rewrite them wholesale for this (the decision
log's curated-history rule, d072). When extending a numbered record, add
named headings and named references; do not add new `§` anywhere.
`docs/d042-documentation-taxonomy.md` carries the full constraint.

## Doc frontmatter: the spec-graph standard

Every markdown file here whose frontmatter carries `id` + `type` is a node in
the spec graph, and its shape is fixed by **`docs/spec-graph-standard.md`**:
five types (`goal-and-requirements`, `architecture-design`, `module-design`,
`submodule-design`, `task-spec`), five statuses (`draft`, `active`, `stale`,
`done`, `deprecated`), ids as link targets, and a qualifier in a body
`## Status` section rather than inside the status value.

That file is the repository-owned copy of the contract on purpose: an agent
without the ThinkRail tooling or its workflow skills must still be able to
keep the graph valid, so read it before adding, retyping, or retitling a doc,
and run the checks it lists when a docs change touches more than one file. The
tooling (and d111, the record that adopted the standard) is the faster path
when it is available; it is not a prerequisite.

## Other repo invariants

- **A folder is a copy unit** (docs/d113): each unit carries its own pruned
  `lib/` copy of the shared kernels it uses, so it can be copied out whole.
  Reaching into a sibling unit is not allowed (`docs/architecture.md`). Tests
  live in `<unit>/tests/` and read only their own folder; the repo-wide sweep
  (`test.sh`) runs them all but contributes none.
- **Environment/secrets are an explicit chain step**: the repo-root
  `./environment.sh <script>` does the one vault round-trip, then `exec`s the
  target. Consumers read plain env and never load secrets; there is exactly
  one loader and no unit owns it (`./environment.sh`).
- `README.md` is an orientation map, not a manifest, and **neither of its
  tables enumerates files**: keep folder-layout rows honest when folders are
  added, moved, or retired, and keep the documentation index to *patterns*
  (the five `type`s + a short reading path). Do not add a doc's row — its
  frontmatter (`id`/`type`/`status`/`parent`/links) is the searchable map.
  This is a churn rule, not tidiness: the old 130-row index was three quarters
  of README and was edited on nearly every doc landing.

## pi codemode quirk

When a harness error appends a stray `</function></tool_call>` trailer to codemode
script output, suffix the script source with a trailing `//` and no trailing
newline — the trailer disappears. Keep that suffix in mind for every
codemode call in this repo until the harness fix lands.

