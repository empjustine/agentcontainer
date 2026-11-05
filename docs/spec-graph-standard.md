---
id: spec-graph-standard
type: architecture-design
status: active
title: "The spec-graph standard: frontmatter contract, five types, five lifecycle statuses"
parent: architecture
depends-on: [d042]
references: [d111, d072, d112]
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
the shape a document must have.** The tooling does not check the whole
contract: `spec_validate` reports duplicate ids, dangling links and parent
cycles, and nothing else. The vocabulary, `title`, and the nesting rules are
this file's job (see [What the tooling checks, and what it does
not](#what-the-tooling-checks-and-what-it-does-not)). When the two disagree,
this file is what a reader without the tooling has, so keep it exact.

## The contract

A document is part of the graph when its file starts with a `---` frontmatter
block that carries **`id`** and **`type`**. Nothing else makes a file a node,
and a markdown file whose frontmatter lacks either field is simply not one —
`llm-local-inference/model-cards/*.md` are notes, not specs. Being a node is not the same
as meeting the contract below, and the validator only sees part of it.

| field                                    | required        | rule                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                     | yes             | Unique across the whole tree. Lowercase kebab-case (`gguf-model-tooling`) or a `dNNN` record handle (`d104`, `d114`). **Stable** — never renumber, never reuse; every link in the tree points at it. A bare `dNNN` only: no suffixed variants, ever (see [Colliding numbers](#colliding-numbers)). |
| `type`                                   | yes             | One of the five types below. Nothing else ever.                                                                                                                                                                                                                                                    |
| `title`                                  | yes             | One line, human sentence. The ThinkRail contract requires it (`spec_create` will not write a spec without one) even though `spec_validate` stays silent when it is missing.                                                                                                                        |
| `status`                                 | recommended     | One of the five lifecycle values below. Nothing else ever.                                                                                                                                                                                                                                         |
| `parent`                                 | for living docs | One id — the tree edge. A **code unit** only: `goal`, `architecture`, a module node, a submodule node (see [Nesting](#nesting-the-expected-shape)).                                                                                                                                                |
| `depends-on`, `references`, `implements` | optional        | Lists of **ids**, not paths: `[d073, d077]`. The validator reports every value here that resolves to no id.                                                                                                                                                                                        |
| `covers`                                 | optional        | A list of ids the tooling writes but **never resolves**: a `covers` value pointing at nothing is silent drift (`spec_get` lists no such edge). Unused in this tree — prefer `references` for the edge you actually mean.                                                                           |
| `tags`                                   | optional        | Free-form list. Genre words live here, not in `type` (`bugfix`, `research`).                                                                                                                                                                                                                       |

Two hard rules that a graph walker cannot forgive:

- **Values containing `: ` must be quoted.** `status: accepted · the gate …` is
  valid YAML; `status: accepted: the gate …` is not — the value truncates at
  the second colon and the whole node silently leaves the graph. Quote it or,
  better, pick a standard status and move the sentence into the body.
- **An id is an identity, not a filename.** The stem usually equals the id
  (`docs/architecture.md` → `architecture`), but not always: the `docs/` root
  holds path-anchored docs whose ids are module names (`container-tooling.md`
  → `lib`), because d0XX bodies reference the _path_. Renaming a file does not
  change its id, and an id must never be silently re-spelled — retarget every
  reference instead.

## Colliding numbers

Two records that claim the same number are two identities wearing one name, and
a letter suffix (`d090b`) is worse than the collision: it invents a second
namespace nobody designed, that no index lists, that sorts after the record it
collides with, and that reads as a subsection of it. The `b` handles this tree
once carried are gone for that reason (d111).

The rule that replaces them: **rename the least-cited of the colliding records
to the next free number, and leave the plain number to the survivor.** Citation
count decides, because the rename's cost _is_ the number of references to
retarget — moving the rarely-named record keeps the churn near zero and keeps
every existing `dNNN` pointer meaning what it always meant. "Next free" means
one past the highest number in use, never a backfilled hole: the number is a
creation-order marker, and filling a gap would date the record wrongly.

Renumbering is permitted **only** for an actual collision. A record that is
merely misfiled, poorly scoped, or superseded keeps its number and earns a
`status:` change instead — this is the one carve-out from the stability rule in
the frontmatter table, and it is bounded by it.

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
    └── llm-local-inference
        └── llm-local-inference-cache   (the folded cache pipeline, CACHE-DESIGN.md)
```

The `lib` and `local-llm` nodes are gone with their folders (docs/d113): the
repo-level `lib/` dissolved into per-unit copies, so the workload API it
anchored (`docs/container-tooling.md`, id `workload-api`) now describes a
contract that **crosses** units and is an `architecture-design` document — the
scope test below says so, since it still holds when any one unit is deleted.
The cache pipeline kept its own spec but became a submodule of the unit it
feeds (`llm-local-inference-cache`), which is what folding the folder flat
made it.

Three rules follow, and they are mechanical enough to apply without judgement:

- **The parent is a code unit.** Only `goal`, `architecture`, a module node
  (id = folder name) or a submodule node may be a parent. **A record is never a
  parent:** no code lives inside a decision, so nothing is "inside" one. When
  the real relation is "this record decided, that one followed", it belongs on
  `depends-on` — where every one of this tree's decision chains already is.
- **One node per code unit.** Each module folder owns exactly one spec whose id
  is the folder name (`coding-agent`, `estige`, `git`, `llm-local-inference`),
  and that node parents to `architecture` — it is the
  module's front door, not something inside the module. Every other spec about
  that folder parents to the node, wherever its _file_ physically sits: `docs/`
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

Drift against these rules survives a green validation run: every misplaced edge
still resolves, so only a subtree walk shows the loss. d111's pass left one such
snapshot in this file as a to-do; d112 closed it — no record is a parent, every
module-scoped spec hangs off its module node, and `git/` has a node — and the
snapshot is gone with it, because the nesting checks below now say the same
thing without a hand-maintained table.

## Types

`type` answers **scope**, not genre: how far the document's authority reaches.

| type                    | scope                                                                                                          | in this tree                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal-and-requirements` | what the system must do — normative, one document                                                              | `docs/requirements.md` (id `goal`, the root of the living tree)                                                                                                                                    |
| `architecture-design`   | spans the repository or crosses module boundaries: the map, the shared rules, prior art, system-wide decisions | `docs/architecture.md`, `docs/environments-and-variants.md`, prior-art and audit docs, the d0XX records that change the layout or a shared contract                                                |
| `module-design`         | confined to one runner folder or one module (`coding-agent/`, `estige/`, `git/`, `llm-local-inference/`)       | each module's `README.md` + `DESIGN.md`, the module-scoped decision records                                                                                                                        |
| `submodule-design`      | a directory-level subsystem inside a package                                                                   | `estige/CI.md`, `llm-local-inference/CACHE-DESIGN.md`                                                                                                                                              |
| `task-spec`             | one piece of work with acceptance criteria                                                                     | temporary by definition — the ThinkRail tools write them to `.thinkrail/context/TASK-*.md` and the work's landing removes them. Nothing durable belongs here; a finished decision becomes a record |

Choosing between the first two is the only judgement call: **would the decision
still hold if the module were deleted?** Yes → `architecture-design`. No →
`module-design`. The d0XX log is not a type: records are typed by that same
scope test, and the `d0XX` filename prefix is what marks them as history.

## Lifecycle

`status` is the record's position in its life, and it is separate from `type`.

| status       | meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| `draft`      | proposed, not in force; nothing in the tree has to obey it yet      |
| `active`     | in force — the code and docs are expected to match it               |
| `stale`      | still in force but known to lag the tree; needs a keeper            |
| `done`       | the work it describes is complete, or the investigation is finished |
| `deprecated` | superseded or retired; kept as history, pointed at by its successor |

Rules that keep the value parseable:

- **One word.** Anything the record needs to say beyond the lifecycle word goes
  in a `## Status` section at the top of the body — "superseded by d084",
  "phase 1 landed, phase 2 deferred", "enforced at each generator change". That
  prose is where the qualifier belongs: it is readable, and it cannot break a
  parser.
- **No synonyms.** If you are reaching for one of these, use the standard value
  and let the body carry the nuance:

  | tempting                                                                     | standard     |
  | ---------------------------------------------------------------------------- | ------------ |
  | `implemented`, `accepted`, `adopted`, `adopted-in-part`, `stable`, `current` | `active`     |
  | `proposed`, `deferred`                                                       | `draft`      |
  | `findings`                                                                   | `done`       |
  | `superseded`, `archived`, `partially-archived`                               | `deprecated` |

- **A status is not a decision.** Superseding a record is done by writing a new
  record that says so and pointing the old one at it (d072: records stay
  mechanically accurate, never rewritten wholesale); the old record's `status`
  only ever becomes `deprecated`.

## Where specs live in this tree

| location                           | what it is                                                                                                                                    | type                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `docs/requirements.md`             | the BRD, root of the living tree                                                                                                              | `goal-and-requirements`                          |
| `docs/*.md`                        | cross-cutting reference and prior art — a doc whose `parent` is `architecture` or `goal`, because it spans units or describes the repo itself | `architecture-design` / `module-design`          |
| `docs/dNNN-*.md`                   | the decision log (history)                                                                                                                    | `architecture-design` / `module-design` by scope |
| `docs/archive/`                    | investigations that finished, plus retired operational docs                                                                                   | same two types, `status: done` / `deprecated`    |
| `<module>/README.md` + `DESIGN.md` | one module: what it is and why it is shaped that way                                                                                          | `module-design`                                  |
| `<module>/<topic>.md`              | a living doc that guides exactly one module — a runbook, a generated table, per-harness reference — with `parent` naming that module (d117)   | `module-design` / `submodule-design`             |
| `<module>/<subsystem>.md`          | a subsystem inside a package                                                                                                                  | `submodule-design`                               |
| `.thinkrail/context/TASK-*.md`     | the tool's working task-specs — real nodes in the graph, outside this tree's hierarchy                                                        | `task-spec`                                      |
| `.agents/skills/SPEC.md`           | the vendored spec of the workflow skill family (id `submodule-workflow-skills`)                                                               | `submodule-design`, no `parent`                  |

Two locations are indexed but sit outside the docs tree, and both are
load-bearing rather than incidental:

- **`.thinkrail/context/TASK-*.md`** are genuine `task-spec` nodes: the graph
  tools index them, `spec_grep` finds them, and that is intended — they are the
  work-in-flight layer. They stand outside the durable tree (some carry
  `parent: architecture` because the session that started them wrote it; no
  archive of the tree depends on that edge) and they disappear when the work
  lands. A checkout without the tooling has no such folder: skip it rather than
  treating those files as docs, which is why the checks below exclude it.
- **`.agents/skills/SPEC.md`** is the one vendored node. It keeps `id` + `type`
  and deliberately has no `parent`: the package nodes it belongs to
  (`module-thinkrail-workflow`, `module-spec-graph`) ship with the workflow
  package, not this workspace, so an edge here would dangle (d111). The tools
  have **no exclude list** — every id-bearing file in the checkout is a node —
  so a second copy of that file is an immediate duplicate-id failure. Keep
  exactly one, and delete stale copies of the workflow package instead of
  adding them beside it.

Deliberately **not** the standard layout, and not drift to fix (d111's
rejected alternative): module docs are `README.md` + `DESIGN.md`, not
`SPEC.md`, and there is no `docs/reference/` or `docs/design/` subdirectory.
Three constraints bind the placement, and the first one decides:

- the **parent-edge rule** (d117) — a living doc's file sits beside the node its
  `parent` names. A doc that guides one unit lives in that unit's folder; a
  cross-cutting doc lives here. The edge and the path must agree, and when they
  disagree the **edge wins**: it carries the scope judgement, the path only
  carries habit.
- the **anchor constraint** — a doc cited by path from a d0XX body may still
  move: since d072 the records naming it are updated in the same change. Keep
  the cite true; do not let it freeze a doc in the wrong folder.
- the **numbering constraint** — no numbered sections and no `§` cites in
  records; use named headings.

## Adding a document

1. Pick the type by scope, then the `status` it actually has (usually `active`
   for reference, `draft` for a proposal).
2. Write the frontmatter: `id`, `type`, `status`, `title`, `parent`, and links
   as **ids**. The `parent` is the code unit the document belongs to — the
   module it describes, or `architecture` when it spans modules — never the
   record it happens to follow from (that is `depends-on`).
3. Give it a home per the table above. **Do not add an index row.** The README
   documentation index describes the five `type` patterns and a short reading
   path; it deliberately does not enumerate documents, because a row per doc
   meant the index was re-edited on nearly every doc landing and still drifted
   from the graph. Discovery is the frontmatter: `id`, `type`, `status`,
   `parent` and the links are the machine-readable map, and a search over them
   is more accurate than any hand-kept list. A new doc that nothing links to is
   still reachable by search and by its `parent` edge — that is the intended
   state, not an orphan to be repaired by adding a row.
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

## What the tooling checks, and what it does not

`spec_validate` reports exactly three failures: duplicate ids, `parent` /
`depends-on` / `references` / `implements` values that resolve to no node, and
parent cycles. Everything else in this contract is silent to it (measured
against this tree in d112):

| the tooling                                                                           | the contract                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| reports duplicate ids, dangling links and cycles — run it after any structural change | nothing extra: the same failures                          |
| writes and indexes any `type:` / `status:` value                                      | the five types and five statuses; nobody else checks them |
| accepts a missing `title`                                                             | a title on every node                                     |
| writes `covers` but never resolves it                                                 | `references` for an edge you mean                         |
| accepts a record as a parent, or a module-scoped spec at `architecture`               | the nesting rules above                                   |
| has no exclude list — every id-bearing file is a node                                 | exactly one copy of a vendored spec                       |

That gap is the reason the checks below exist: they are the part the tooling
does not do, and skipping them is how this tree carried 33 misplaced nodes
through a dozen green validation runs (d112).

## Checking the graph without the tooling

Run these over the tree after a docs change; a check that prints something is a
finding, not a warning — fix the value, the id, or the link before adding
anything on top of it. `SPECS` excludes the tool-owned `.thinkrail/` scratch
folder. `.agents/` stays in on purpose: its vendored spec is a node.

```sh
SPECS=(-r --include='*.md' --exclude-dir=.git --exclude-dir=.thinkrail --exclude-dir=node_modules .)
```

### Contract checks

```sh
# the types in use — every line must be one of the five
grep -rh '^type: '   "${SPECS[@]}" | sed 's/^type: *//'   | sort | uniq -c

# the statuses in use — every line must be one of the five
grep -rh '^status: ' "${SPECS[@]}" | sed 's/^status: *//' | sort | uniq -c

# nodes without a title — must print nothing
for f in $(grep -rl '^id: ' "${SPECS[@]}"); do grep -q '^title: ' "$f" || echo "$f"; done

# duplicate ids — must print nothing
grep -rh '^id: ' "${SPECS[@]}" | sed 's/^id: *//; s/"//g' | sort | uniq -d

# link targets that resolve to no id — must print nothing
comm -23 \
  <(grep -rh -E '^(parent|depends-on|references|implements|covers):' "${SPECS[@]}" \
      | sed 's/^[a-z-]*: *//; s/[][]//g; s/"//g' | tr ',' '\n' | tr -s ' ' '\n' \
      | grep -v '^$' | sort -u) \
  <(grep -rh '^id: ' "${SPECS[@]}" | sed 's/^id: *//; s/"//g' | grep -v '^$' | sort -u)
```

### Nesting checks

```sh
# parents that are not a code unit — keep this roster equal to the module nodes
comm -23 \
  <(grep -rh '^parent: ' "${SPECS[@]}" | sed 's/^parent: *//; s/"//g' | sort -u) \
  <(printf '%s\n' goal architecture coding-agent estige git llm-local-inference \
      | sort)

# a record used as a parent — must print nothing
grep -rl '^parent: d' "${SPECS[@]}"

# module-design specs parked at the system level — read the list, judge each
grep -rl '^type: module-design' "${SPECS[@]}" \
  | xargs grep -l '^parent: architecture' \
  | xargs grep -L -E '^(id: (coding-agent|estige|git|llm-local-inference))$'
```

The last one needs a reader. Output is not automatically wrong — an archived
investigation has no module left to hang from — but the question for each line
is the scope test from [Types](#types): _which folder's behavior does this
describe?_ If the answer is one folder, `parent` is that module node; if it is
several, the record is `architecture-design` and parents to `architecture`.
