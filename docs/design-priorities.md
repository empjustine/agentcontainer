---
id: design-priorities
type: architecture-design
status: active
title: "Design priorities: untangled, local, direct, observable, vetted, terse"
parent: architecture
depends-on: [d039, d072, d113, d118]
references: [writing-style, d045, d106, d138]
tags: ["code", "documentation", "priorities", "contract"]
---

# Design priorities

Six properties decide which of two working shapes a change takes. They bind
code and documentation alike: `AGENTS.md` carries the short test, and this
document carries the statements, the fault each removes, and the records that
applied them. The prose contract and the comment rule are not restated here —
they belong to `docs/writing-style.md` and `AGENTS.md`.

A change that trades one property against another names the trade in its
decision record.

## Untangled flows

Execution flow, data flow, and read flow stay parallel: a reader follows one
without holding another in mind. Documentation tangles the same way a call
graph does — a paragraph whose point arrives only after two other documents
are read is a knot, and every future reader pays it.

## Local placement

Related things sit together, so one change touches one place and a reader does
not jump. The copy unit is this property at folder scale (docs/d113): a unit's
code, tests, pruned `lib/` copy and docs leave the tree whole. A fact stated
in three files is three edits and three chances to disagree.

## Direct code

The call site states the intent: no indirection that exists to shorten a line,
and no library, helper, or utility with one caller. d039 folded the
single-consumer `lib/` modules because a module whose only job was to feed one
script is pure indirection; d118 gives the `pi-*` extensions no `lib/` for the
same reason, and d138 counts three lines of indirection that shorten one
command as a net loss. A helper kept for a second caller that never arrives
costs a reader a hop and pays nothing back.

## Maintainable and observable

A failure surfaces at the step that owns it (NFR-2), and the system's state
reads from its logs and records without a debugging session. Silent fallbacks,
implicit regeneration, and state reachable only by reading five files make
maintenance and observability expensive at once, so a change avoids those
shapes. The tree's applications are structured logging (docs/d045), the
tunnel's own observability (docs/d106), and d072's maintainability audit.

## Vetted dependencies

An unvetted package stays out of the tree, and a dependency that proves
necessary must be among the few and the most trusted: a dependency is a trust
claim and a maintenance claim at once. The tree's shape already follows the
property — one pinned toolchain table (docs/d139), one npm lock (docs/d107),
and `lib/` copies owned outright rather than vendored (docs/d113).

## Terse text

Code and documentation take the shorter of two texts that say the same thing:
cut before adding, and let a reader reach the point in one pass.
`docs/writing-style.md` owns the prose half as a procedure — the
skeleton-then-cut pass — while the priority here is the standing bias toward
the short form.
