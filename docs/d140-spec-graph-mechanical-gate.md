---
id: d140
type: architecture-design
status: active
title: "d140 — the spec graph gets a mechanical gate, and the contract's open points get rulings"
parent: architecture
depends-on: [d042, d111, d112]
references: [spec-graph-standard, d117, d072]
tags: [docs, spec-graph, gates, tooling, audit]
---

# d140 — the spec graph gets a mechanical gate

## Problem

`docs/spec-graph-standard.md` states the whole contract — five types, five
statuses, `title`, id spelling, the nesting rules — while the validator behind
it checks three things (duplicate ids, dangling links, parent cycles). The gap
was documented, and then it was walked into anyway:

- seven records (d113, d118–d123) carried `type: decision` and
  `status: implemented` — two values the standard explicitly bans — through
  every green run, because nothing mechanical looked at `type:`/`status:` at all;
- `docs/d069` parented a doc to `workload-api`, an `architecture-design` doc,
  which the validator resolves happily (the id exists) and the contract forbids;
- `docs/d046` was a `module-design` parked at `architecture` — the standard's own
  "common drift" example, still invisible;
- and the standard's hand-maintained nesting roster had gone stale, flagging
  legitimate submodule parents as illegal while missing nothing it was meant to
  catch, because it was a `printf` list, not a rule.

Reading the file end to end with no ThinkRail tooling also surfaced four points
the contract answered only by implication: whether `status` is required (the
table said "recommended"), which file in a unit carries the module node
(`README.md` or `DESIGN.md` — the tree uses both), whether a node may hang off
nothing ("for living docs" left the archive and node-less folders undefined),
and how a record that decides two things at two scopes should be typed.

## Decision

**`./docs/spec-check.mjs` is the executable half of the standard, and `./lint.sh`
gates on it.** It needs node and nothing else — no network, no YAML package, no
ThinkRail tooling — and it decides every rule the contract states that a machine
can decide: the closed vocabularies, the required fields, id spelling and
uniqueness, edge resolution, the nesting and level rules, the d117 file/edge
agreement, the parent cycle, and the unquoted-`: ` truncation trap that silently
drops a node out of the graph.

Four properties make it the right shape rather than a nicer grep:

- **The rules live in the standard, the codes in the tool.** Each finding prints
  as `path: [code] sentence`, and the code table sits in
  `docs/spec-graph-standard.md`'s _Mechanical enforcement_ section, so the file a
  reader finds without the tooling is the file that says what green means.
- **The tree is one of its own test cases.**
  `docs/tests/spec-check.test.mjs` pins one fixture per finding code _and_
  asserts the committed tree is clean, so a rule that quietly stops matching is
  caught by the sweep that runs the gate.
- **The exemption list is the short, documented one.** Records live in `docs/`
  whatever their `parent` says; archived `module-design` may park at
  `architecture` only when `status` is `done`/`deprecated`; the root and the one
  vendored spec have no parent. Three exemptions, all named in the standard.
- **It stops where judgement starts.** Whether a `type` is the right scope call,
  whether a record's prose is still true, whether a `## Status` qualifier is
  honest — those stay reading work, and the tool says so.

The audit's rulings are now part of the contract (the standard's _Rulings_
section): `status` is required; the legal-parent roster is **derived** from the
graph (roots, module front doors, submodule nodes) rather than listed; a module
node is identified by `type` + `parent` + `id` = folder name at the folder root,
not by filename; a half node (`id` without `type`, or the reverse) is a finding;
`parent` is required except for the root and the vendored spec; a node-less
folder is legal; `covers` stays unenforced, matching the validator; and a record
deciding two things at two scopes is typed by the **higher** scope.

The eight nodes the audit found off-contract were repaired in the same change:
the seven records above by scope (`architecture-design` for the cross-unit ones,
`module-design` for d119/d120/d121, all `status: active` — d123's scope also
moved its `parent` to `architecture`), and `d046`/`d069` by scope too.

## Alternatives rejected

- **Extend the ThinkRail tooling.** This repo's contract has to hold in a
  checkout that has none of it — that is the standard's stated reason to exist.
  A rule only the tool checks is a rule a copied folder loses.
- **Keep the prose checklist and audit more carefully.** The checklist was
  correct and the drift still happened; "read the standard before you land
  docs" is not a gate, it is a hope, and it had already been written down.
- **A YAML dependency to parse frontmatter.** The frontmatter this repo writes is
  a flat `key: value` map plus flow lists; a parser dependency for that would
  outweigh the checker, and the one genuinely YAML-shaped trap (an unquoted
  `": "`) is textual.
- **A `spec-graph/` copy unit.** A checker copied out of this tree is a checker
  with no tree to check. It lives beside the standard it enforces (`docs/`),
  which is also where its subject — and its tests — belong.
- **Warn instead of fail.** A warning nobody reads is how `type: decision`
  survived a week of green runs.

## Consequences

- Any docs change now fails `./lint.sh` if it breaks the contract, in the same
  run as the code gates.
- The gate is the third consumer of the `*.test.mjs` glob `test.sh` runs (with
  `coding-agent/` and the `pi-*` tests) and the first test suite under `docs/`.
- The audit ruling on half nodes and on `parent` presence is stricter than the
  validator: a node the tooling indexes can still fail this gate.
- Renumbering guidance is unchanged (d072/d111): the gate refuses a
  letter-suffixed record handle, it never renumbers one.

## Verification status

- `./docs/spec-check.mjs` on this tree: clean (was 16 findings before the
  repair, then 18 after the parent rule landed and the tree was fixed).
- `./node-run.sh --test docs/tests/*.test.mjs`: 19/19 pass.
- `./lint.sh`: the `spec graph` leg plus every pre-existing leg green.
- The repair changed frontmatter only — no record body was rewritten (d072).

## Amendment — checked against the tooling itself

The rulings above were derived by reading the contract. They were then checked
against the running ThinkRail tools with throwaway nodes (created, queried, and
deleted in the same session), and several of the standard's claims turned out
to be wrong, loose, or silent where they needed to be exact. What follows is what
was measured, so the next reader does not re-derive it.

- **Confirmed silent**, matching the rulings: `spec_validate` accepts an unknown
  `type`, an unknown or absent `status`, an absent `title`, and a `Bad_ID`
  spelling, and it does not resolve `covers` — a probe carrying
  `covers: [ghost]` produced no finding, and `spec_get` listed no such edge.
  Duplicate ids, a dangling `parent` and dangling `depends-on` / `implements`
  were all reported: the standard's "exactly three failures" holds.
- **Corrected — the index has an exclude list.** The standard said the tools
  index "every id-bearing file in the checkout". They do not: `node_modules/` is
  skipped (an id-bearing file there answered no query), while `.venv/`,
  `__pycache__/`, `.ruff_cache/` and `.thinkrail/context/` are all indexed —
  gitignored or not. The false claim was load-bearing, since it justified "keep
  exactly one copy of the vendored spec"; the corrected version still does, with
  `node_modules/` as the single hole.
- **Corrected — `spec_create` scaffolds less than the table implies.** It writes
  `id` and `type` and nothing else: its `title` argument is required by the tool
  schema, but an empty string produces no `title:` field at all, and `status` and
  `parent` are never written. A node straight from the tool therefore fails the
  gate three times over. The standard's title row and its "Adding a document"
  step now say so instead of promising that `spec_create` "will not write a spec
  without one".
- **Corrected — two smaller disagreements.** The `parent` exemption is the whole
  `.agents/` subtree, not the one vendored file: that is what the gate checks, and
  the reason an edge would dangle (the package ships elsewhere) applies to every
  node in it. And the no-tooling `grep` fallback was missing `--exclude-dir=.venv`,
  so it read a tree the gate skips and could report findings the gate never
  would; it now names the same skip set.
- **Named, not fixed — the gate's blind spot.** The tools index `.venv/` and
  `.thinkrail/`, and the gate skips both, so a spec-shaped file in either is a
  node ThinkRail resolves and `./lint.sh` never sees. Widening the gate was
  rejected: `.venv/` is disposable, and gating it would let a rebuilt
  environment change the verdict. The standard states the blind spot instead,
  and the gate's suite now pins the skip list so it cannot widen unnoticed.
- **Also recorded in the standard, not the tooling:** the tooling's own required
  fields are `id`, `type` and `title`, with `status` and `parent` optional. The
  gate's stricter set is this repository's rule, and the standard now says so
  where it used to leave the reader to infer which authority was speaking.
