# AGENTS.md — working rules for this repository

Instructions for coding agents (pi and others) operating in this repo.
`docs/architecture.md` treats this file as repo-owned infrastructure, like
`biome.json`.

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
`docs/` and link it from `README.md`'s documentation index.

`docs/architecture.md` describes the standalone rule (folders + `../lib` are
the copy unit), and `README.md` indexes the rest.

## Other repo invariants

- **`lib/` is shared infrastructure**, owned by the repo and never copied
  into a runner folder. Data reads out of `lib/` are allowed; reaching into a
  sibling runner is not (`docs/architecture.md`).
- **Environment/secrets are an explicit chain step**: `./lib/environment.sh
  <script>` does the one vault round-trip, then `exec`s the target. Consumers
  read plain env and never load secrets (`lib/environment.sh`).
- Keep `README.md`'s folder layout and documentation index in sync when
  adding, moving, or retiring files/folders.
