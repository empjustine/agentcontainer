---
id: d246
type: architecture-design
status: active
title: "d246 — a folder named `stage` is local scratch, and the gates do not read it"
parent: architecture
depends-on: [d245]
references: [d113, d122, d243]
tags: ["gates", "paths", "ignore", "scratch", "hygiene"]
---

# d246 — a folder named `stage` is local scratch

What a `stage` folder is, why the gate is blind to it, and what has to be true
before the files in one leave the tree.

## Problem

Work in progress that is not part of the build still sat inside the working
tree, and the gate read it. Measured on the checkout that prompted this record:

- `ruff check .` reported **47 errors**, every one of them inside
  `datalakehouse/stage/organizar-clippings-bookmarks/` — unaudited personal
  scripts, not the unit's python.
- `oxfmt --check '**/*.md'` walked the same folder (1466 files counted against a
  1459-file tracked tree), so a half-written note could turn the formatter red
  without a single tracked edit.
- the shellcheck and shfmt `find` legs visited `stage/*.sh`.
- and a `.pnpm-store` left over from before a folder rename made `biome` fail on
  broken symlinks (d243 records the incident), which is the same failure mode in
  a different disguise: a disposable directory inside the tree whose state the
  gate treats as a verdict about the code.

The gate answers one question — is the tracked tree healthy — and a dump awaiting
cold storage is not part of that question.

## Decision

**R1 — A folder named `stage` is scratch by definition.** Never tracked, never an
input to a build, never a source of truth. The name is the whole contract, which
is what lets every gate recognise it without a per-tool registry.

**R2 — The gates skip it by name, through the one ignore file where possible.**
`.gitignore` carries `stage/`, which `git status`, `oxfmt` and `ruff` already
honour; the shellcheck and shfmt `find` legs prune `*/stage` explicitly because
`find` takes no ignore file. Nothing else needs a rule: `biome`, `knip` and `tsc`
read languages a scratch dump is not written in, and the spec gate reports it
clean (a markdown file without frontmatter is not a graph node).

**R3 — Knowledge leaves the folder before the files do.** The folder is a waiting
room, not a filing cabinet: an idea that only exists inside `stage` is lost to the
cold-storage move, so it lands in the tree first — `datalakehouse/elt/` for the
landing zone, `docs/reader-gotchas.md` for the reader facts — and the folder keeps
only what is being discarded or parked.

**R4 — A store the gates need is disposable, not scratch.** `node_modules/`,
`.venv/` and `.pnpm-store/` are ignored and rebuilt on demand, and deleting one is
always safe; a _stale_ one can still make a leg fail (`biome` on a broken
symlink), so the remedy is the cleanup unit, not an ignore rule.

## Consequences

- `git status` is clean while work is parked, and `./lint.sh` / `./test.sh` return
  the same verdict whether or not a dump is present.
- The formatter's file count is the tracked tree again, so a green formatter leg
  means what it says.
- A `stage` folder is deleted without ceremony once its contents are cold-stored;
  nothing in the tree points into one.
- The one hazard is the name itself: a _legitimate_ tracked folder called `stage`
  would now be invisible to three gates. None exists, and picking a different name
  for scratch costs nothing if one ever wants to.

## Alternatives rejected

- **Track the dump.** It does not meet the gates (47 ruff findings), it is not a
  build input, and a repo is not a filing cabinet for personal scripts.
- **Exclude it only in `lint.sh`.** Each tool would need its own list, `git
  status` would keep showing the folder, and the next tool added would need the
  same edit — a registry instead of a convention.
- **Keep the tools' gitignore opt-outs** (`ruff --no-respect-gitignore`,
  `oxfmt --ignore-path` overrides). That is the same registry from the other
  direction: the ignore file stops being the single answer.
- **Reformat the dump so the gate passes.** It fixes the symptom in the scratch
  folder, spends effort on files that are about to leave, and still leaves the
  formatter's count and the shellcheck walk coupled to it.

## Verification status

- `ruff check .` with the dump present: 47 errors before, 0 after (it honours
  `.gitignore`).
- `oxfmt@0.79.0 --check '**/*.md'`: 1466 files before (the dump included),
  the tracked tree after; every file canonical.
- the shellcheck and shfmt `find` legs: `stage/*.sh` listed before, pruned after
  (`find … -path '*/stage' -prune` returned no matches under `stage`).
- `node docs/spec-check.mjs`: clean with the dump present, before and after.
- `git status`: the two `stage` directories no longer appear as untracked.
