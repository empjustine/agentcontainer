---
id: spec-graph-standard
type: architecture-design
status: active
title: "The spec-graph standard: frontmatter contract, five types, five lifecycle statuses"
parent: architecture
depends-on: [d042]
references: [d111, d072]
tags: ["docs", "spec-graph", "contract", "taxonomy"]
---

# The spec-graph standard

## Why this file exists

Every markdown file in this tree that carries frontmatter is a node in a graph:
`id` names it, `type` says how it nests, `parent`/`depends-on`/`references`
tie it to its neighbours. Tooling walks that graph — the spec-graph validator,
the workflow skills, any agent asked "where is the decision about X".

The vocabulary is not this repository's invention (d111; the bespoke
requirements/reference/design taxonomy it replaces is d042's, kept there as
history). Writing the contract down here has one purpose: **a checkout with no
ThinkRail tooling — or an agent with none of its skills loaded — still knows
the shape a document must have.** The tooling checks the graph; this file
defines it. When the two disagree, this file is what a reader without the
tooling has, so keep it exact.

## The contract

A document is part of the graph when its file starts with a `---` frontmatter
block that carries **`id`** and **`type`**. Nothing else is mandatory, and a
markdown file without frontmatter is simply not a node (vendored model cards,
skill files).

| field | required | rule |
| --- | --- | --- |
| `id` | yes | Unique across the whole tree. Lowercase kebab-case (`gguf-model-tooling`) or a `dNNN` record handle (`d104`, `d027b`). **Stable** — never renumber, never reuse; every link in the tree points at it. |
| `type` | yes | One of the five types below. Nothing else ever. |
| `title` | recommended | One line, human sentence. |
| `status` | recommended | One of the five lifecycle values below. Nothing else ever. |
| `parent` | for living docs | One id — the tree edge. A **code unit** only: `goal`, `architecture`, a module node, a submodule node (see [Nesting](#nesting-the-expected-shape)). |
| `depends-on`, `references`, `implements`, `covers` | optional | Lists of **ids**, not paths: `[d073, d077]`. They must resolve to an `id` that exists. |
| `tags` | optional | Free-form list. Genre words live here, not in `type` (`bugfix`, `research`). |

Two hard rules that a graph walker cannot forgive:

- **Values containing `: ` must be quoted.** `status: accepted · the gate …` is
  valid YAML; `status: accepted: the gate …` is not — the value truncates at
  the second colon and the whole node silently leaves the graph. Quote it or,
  better, pick a standard status and move the sentence into the body.
- **An id is an identity, not a filename.** The stem usually equals the id
  (`docs/architecture.md` → `architecture`), but not always: the `docs/` root
  holds path-anchored docs whose ids are module names (`container-tooling.md`
  → `lib`), because d0XX bodies reference the *path*. Renaming a file does not
  change its id, and an id must never be silently re-spelled — retarget every
  reference instead.

## Nesting: the expected shape

`parent` is not a topic index and not an ordering of decisions: the standard
makes it a **mirror of the code structure** — a document sits beside the code
unit it describes, and a package's sub-directories hang below it, fractally.
That is the whole reason the edge earns its place: it is the only edge that
answers "what belongs to X", so an agent that opens `estige` can pull
everything about `estige` and its dependants, and a module's own docs are
reachable in one hop instead of by remembering their filenames.

```
goal                        goal-and-requirements — the graph root
└── architecture            architecture-design — the system map, plus every cross-cutting record
    ├── coding-agent        module-design — one node per module folder, id = folder name
    │   └── d0NN …          records and docs confined to coding-agent/
    ├── estige
    │   └── estige-ci       submodule-design — a subsystem inside the package (estige/CI.md)
    ├── git
    ├── lib                 (anchored at docs/container-tooling.md — d042's anchor constraint)
    ├── local-llm
    └── llm-local-inference
```

Three rules follow, and they are mechanical enough to apply without judgement:

- **The parent is a code unit.** Only `goal`, `architecture`, a module node
  (id = folder name) or a submodule node may be a parent. **A record is never a
  parent:** no code lives inside a decision, so nothing is "inside" one. When
  the real relation is "this record decided, that one followed", it belongs on
  `depends-on` — where every one of this tree's decision chains already is.
- **One node per code unit.** Each module folder owns exactly one spec whose id
  is the folder name (`coding-agent`, `estige`, `lib`, `git`, `local-llm`,
  `llm-local-inference`), and that node parents to `architecture` — it is the
  module's front door, not something inside the module. Every other spec about
  that folder parents to the node, wherever its *file* physically sits: `docs/`
  is a file layout, not the graph.
- **The parent's level matches the spec's `type`.** `architecture-design` →
  `architecture`; `module-design` → its module node; `submodule-design` → its
  package node; `goal-and-requirements` → no parent. A module-design record
  parked at `architecture` is the common drift here, and it is invisible to the
  validator: it makes the module's subtree quietly incomplete rather than
  illegal.

Depth is not a quality in itself. Two levels (`architecture → module → doc`) is
the whole tree here; what matters is that each document hangs off the unit whose
behavior it describes, not off the document that happens to precede it.

### What the tree has instead

A snapshot taken with d111's alignment pass (2026-11-01), over the 135 specs in
this repository (the vendored `.agents/skills/SPEC.md` belongs to the workflow
package and is excluded). It is recorded here because the drift is invisible to
the validator — every edge below resolves, so `spec_validate` is happy and only
a subtree walk shows the loss. **Once checks 5–7 come back clean — 5 and 6
print nothing, 7 prints only archived investigations — delete this subsection**:
it is a to-do, not history (d111 keeps the history).

| class | n | what it is |
| --- | --- | --- |
| nests as the rules expect | 101 | the root pair (`goal`, then `architecture`), 5 module nodes, 60 specs under their module node, 34 system-wide docs at `architecture` — 24 cross-cutting reference docs and 10 archived investigations, which legitimately have no module left to hang from |
| **A — a record as parent** | 13 | decision chains encoded as containment: `d039 d041 d051 d056 d083 d087 → d023/d041/d083`; `d040 → d037`; `d062 d089 → d044`; `d063`, then `d064 → d063`; `d080 → d047`; `d103 → d073` |
| **B — parked under `goal`** | 9 | 8 records (`d015 d022 d023 d024 d025 d027 d035 d072`) and `environments` hang off the BRD, skipping the `architecture` level |
| **C — module scope at `architecture`** | 10 | 9 records that describe one module (`d029 d030 d031 d036 d047 d057 d058 d059 d060`) plus `git-non-bare-issues` |
| **E — a level inversion** | 1 | `d026` is `architecture-design` but parents to `lib` |
| **F — a doc under a doc** | 1 | `termux-serving` parents to `environments`, which is a reference doc, not a code unit |

Two absences the table cannot show: **`git/` has no node at all** (its only
spec, `git-non-bare-issues`, is one of the ten in class C, and the mirror
records `d062`/`d089` have no module to land under), and the module nodes are
carried by different *files* from folder to folder — `README.md` for `estige`,
`DESIGN.md` for `coding-agent`/`local-llm`/`llm-local-inference`, and
`docs/container-tooling.md` for `lib`. That inconsistency is harmless (R2 asks
for one node per unit, not one filename); the missing `git` node is not.

Class A is the drift that actually costs an agent something, because the chain
edges already carry the same information on `depends-on`: nothing is lost by
re-pointing the `parent`, and a subtree rooted at `coding-agent` or `estige`
then stops silently omitting the records that shaped it.

## Types

`type` answers **scope**, not genre: how far the document's authority reaches.

| type | scope | in this tree |
| --- | --- | --- |
| `goal-and-requirements` | what the system must do — normative, one document | `docs/requirements.md` (id `goal`, the root of the living tree) |
| `architecture-design` | spans the repository or crosses module boundaries: the map, the shared rules, prior art, system-wide decisions | `docs/architecture.md`, `docs/environments-and-variants.md`, prior-art and audit docs, the d0XX records that change the layout or a shared contract |
| `module-design` | confined to one runner folder or one module (`coding-agent/`, `estige/`, `lib/`, `git/`, `local-llm/`, `llm-local-inference/`) | each module's `README.md` + `DESIGN.md`, the module-scoped decision records |
| `submodule-design` | a directory-level subsystem inside a package | `estige/CI.md` |
| `task-spec` | one piece of work with acceptance criteria | none yet — one-off work stays in the chat plan |

Choosing between the first two is the only judgement call: **would the decision
still hold if the module were deleted?** Yes → `architecture-design`. No →
`module-design`. The d0XX log is not a type: records are typed by that same
scope test, and the `d0XX` filename prefix is what marks them as history.

## Lifecycle

`status` is the record's position in its life, and it is separate from `type`.

| status | meaning |
| --- | --- |
| `draft` | proposed, not in force; nothing in the tree has to obey it yet |
| `active` | in force — the code and docs are expected to match it |
| `stale` | still in force but known to lag the tree; needs a keeper |
| `done` | the work it describes is complete, or the investigation is finished |
| `deprecated` | superseded or retired; kept as history, pointed at by its successor |

Rules that keep the value parseable:

- **One word.** Anything the record needs to say beyond the lifecycle word goes
  in a `## Status` section at the top of the body — "superseded by d084",
  "phase 1 landed, phase 2 deferred", "enforced at each generator change". That
  prose is where the qualifier belongs: it is readable, and it cannot break a
  parser.
- **No synonyms.** If you are reaching for one of these, use the standard value
  and let the body carry the nuance:

  | tempting | standard |
  | --- | --- |
  | `implemented`, `accepted`, `adopted`, `adopted-in-part`, `stable`, `current` | `active` |
  | `proposed`, `deferred` | `draft` |
  | `findings` | `done` |
  | `superseded`, `archived`, `partially-archived` | `deprecated` |

- **A status is not a decision.** Superseding a record is done by writing a new
  record that says so and pointing the old one at it (d072: records stay
  mechanically accurate, never rewritten wholesale); the old record's `status`
  only ever becomes `deprecated`.

## Where specs live in this tree

| location | what it is | type |
| --- | --- | --- |
| `docs/requirements.md` | the BRD, root of the living tree | `goal-and-requirements` |
| `docs/*.md` | system-wide reference, prior art, module docs that are referenced by path from d0XX bodies | `architecture-design` / `module-design` |
| `docs/dNNN-*.md` | the decision log (history) | `architecture-design` / `module-design` by scope |
| `docs/archive/` | investigations that finished, plus retired operational docs | same two types, `status: done` / `deprecated` |
| `<module>/README.md` + `DESIGN.md` | one module: what it is and why it is shaped that way | `module-design` |
| `<module>/<subsystem>.md` | a subsystem inside a package | `submodule-design` |

Deliberately **not** the standard layout, and not drift to fix (d111's
rejected alternative): module docs are `README.md` + `DESIGN.md`, not
`SPEC.md`, and there is no `docs/reference/` or `docs/design/` subdirectory.
Two constraints from d042 bind the placement and outrank tidiness:

- the **anchor constraint** — eight living docs are referenced by path from
  d0XX bodies, so they stay at `docs/` root;
- the **numbering constraint** — no numbered sections and no `§` cites in
  records; use named headings.

## Adding a document

1. Pick the type by scope, then the `status` it actually has (usually `active`
   for reference, `draft` for a proposal).
2. Write the frontmatter: `id`, `type`, `status`, `title`, `parent`, and links
   as **ids**. The `parent` is the code unit the document belongs to — the
   module it describes, or `architecture` when it spans modules — never the
   record it happens to follow from (that is `depends-on`).
3. Give it a home per the table above, and add a row to the README
   documentation index **in its type section** — the index is grouped by type
   and must not drift from the graph.
4. If it changes a boundary, contract, or invariant, update the owning spec in
   the same change.

## Changing a document

- Superseding a decision → new record + `status: deprecated` on the old one +
  a body `## Status` line naming the successor.
- Finishing an investigation → `status: done`; move it to `docs/archive/` if
  nothing points at its path.
- Renaming a file → keep the `id`, retarget every reference (grep the id, not
  the path), and leave the old spelling out of the tree entirely.
- Retiring a module → `status: deprecated` on its docs; do not delete them
  while history points at them.
- Adding a record under an existing one → no: a record joins its module node
  (or `architecture`) and takes `depends-on` for the record it answers.

## Checking the graph without the tooling

The ThinkRail validator (`spec_validate`) does this properly when it is
available. Without it, these four checks over the tree catch the failures that
actually happen — an off-standard value, a duplicated id, and a link that
resolves to nothing:

```sh
SPECS=(-r --include='*.md' --exclude-dir=.git --exclude-dir=.thinkrail --exclude-dir=node_modules .)

# 1. the types in use — every line must be one of the five
grep -rh '^type: '   "${SPECS[@]}" | sed 's/^type: *//'   | sort | uniq -c

# 2. the statuses in use — every line must be one of the five
grep -rh '^status: ' "${SPECS[@]}" | sed 's/^status: *//' | sort | uniq -c

# 3. duplicate ids — must print nothing
grep -rh '^id: ' "${SPECS[@]}" | sed 's/^id: *//; s/"//g' | sort | uniq -d

# 4. link targets that resolve to no id — must print nothing
comm -23 \
  <(grep -rh -E '^(parent|depends-on|references|implements|covers):' "${SPECS[@]}" \
      | sed 's/^[a-z-]*: *//; s/[][]//g; s/"//g' | tr ',' '\n' | tr -s ' ' '\n' \
      | grep -v '^$' | sort -u) \
  <(grep -rh '^id: ' "${SPECS[@]}" | sed 's/^id: *//; s/"//g' | grep -v '^$' | sort -u)

# 5. parents that are not a code unit — keep this roster equal to the module nodes
comm -23 \
  <(grep -rh '^parent: ' "${SPECS[@]}" | sed 's/^parent: *//; s/"//g' | sort -u) \
  <(printf '%s\n' goal architecture coding-agent estige lib git local-llm llm-local-inference \
      | sort)

# 6. a record used as a parent — must print nothing
grep -rl '^parent: d' "${SPECS[@]}"
```

A check that prints something is a finding, not a warning: fix the value, the
id, or the link before adding anything on top of it. Checks 5 and 6 cover the
nesting rules; **check 7 is the one no script can make** —

```sh
# 7. module-design specs parked at the system level (read the list, judge each)
grep -rl '^type: module-design' "${SPECS[@]}" \
  | xargs grep -l '^parent: architecture' \
  | xargs grep -L -E '^(id: (coding-agent|estige|lib|git|local-llm|llm-local-inference))$'
```

Output there is not automatically wrong — an archived investigation, or a
record that genuinely spans several modules, legitimately sits at
`architecture`. The question to ask of each line is the one from the snapshot:
*which folder's behavior does this describe?*
