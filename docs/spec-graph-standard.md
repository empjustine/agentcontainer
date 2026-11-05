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

**Which rules are whose.** The tooling's own requirement set is narrower, and
the difference is deliberate. ThinkRail requires `id`, `type` and `title`,
treats `status`, `parent` and the link lists as optional, and validates three
failure classes. Everything this file demands beyond that — `status` and
`parent` as required fields, the closed vocabularies, the id spelling, the
nesting levels, d117's file/edge agreement — is required by _this repository_
and enforced by `docs/spec-check.mjs`, the gate `./lint.sh` runs. So read a rule
here as "this tree requires it" unless it names the tooling, and where the two
differ obey the stricter one: the gate is the one that can fail a build.

## The contract

A document is part of the graph when its file starts with a `---` frontmatter
block that carries **`id`** and **`type`**. Nothing else makes a file a node,
and a markdown file whose frontmatter lacks either field is simply not one —
`llm-local-inference/model-cards/*.md` are notes, not specs. Being a node is not the same
as meeting the contract below, and the validator only sees part of it.

The `required` column is this tree's requirement, enforced by the gate — not the
tooling's, which asks for less (see above).

| field                                    | required         | rule                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                     | yes              | Unique across the whole tree. Lowercase kebab-case (`gguf-model-tooling`) or a `dNNN` record handle (`d104`, `d114`). **Stable** — never renumber, never reuse; every link in the tree points at it. A bare `dNNN` only: no suffixed variants, ever (see [Colliding numbers](#colliding-numbers)).                                                                                    |
| `type`                                   | yes              | One of the five types below. Nothing else ever.                                                                                                                                                                                                                                                                                                                                       |
| `title`                                  | yes              | One line, human sentence. Required by ThinkRail's own skill and by this tree, but enforced by neither tool: `spec_validate` is silent when it is missing, and `spec_create`'s mandatory `title` argument still writes no `title:` field when handed an empty string. The gate is what enforces this.                                                                                  |
| `status`                                 | yes              | One of the five lifecycle values below. Nothing else ever. Absence is drift, not a default — the gate reports it (ThinkRail treats the field as optional).                                                                                                                                                                                                                            |
| `parent`                                 | all but the root | One id — the tree edge. A **code unit** only: `goal`, `architecture`, a module node, a submodule node (see [Nesting](#nesting-the-expected-shape)). Exempt by design: the graph root, and any node under `.agents/` — the vendored spec's package nodes ship with the workflow package, so an edge there would dangle (d111; see [Where specs live](#where-specs-live-in-this-tree)). |
| `depends-on`, `references`, `implements` | optional         | Lists of **ids**, not paths: `[d073, d077]`. The validator reports every value here that resolves to no id.                                                                                                                                                                                                                                                                           |
| `covers`                                 | optional         | A list of ids the tooling writes but **never resolves**: a `covers` value pointing at nothing is silent drift (`spec_get` lists no such edge). Unused in this tree — prefer `references` for the edge you actually mean.                                                                                                                                                              |
| `tags`                                   | optional         | Free-form list. Genre words live here, not in `type` (`bugfix`, `research`).                                                                                                                                                                                                                                                                                                          |

Two hard rules that a graph walker cannot forgive:

- **Values containing `: ` must be quoted.** `status: accepted · the gate …` is
  valid YAML; `status: accepted: the gate …` is not — the value truncates at
  the second colon and the whole node silently leaves the graph. Quote it or,
  better, pick a standard status and move the sentence into the body.
- **An id is an identity, not a filename.** The stem usually equals the id
  (`docs/architecture.md` → `architecture`), but not always:
  `docs/container-tooling.md` carries the id `workload-api`, because the bodies
  that cite it name the CONTRACT — the workload API every unit implements — not
  the file. Renaming a file does not change its id, and an id must never be
  silently re-spelled — retarget every reference instead.

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
    ├── pi-hyper            module-design — one node per `pi-*` package, id = its folder (d141)
    │   └── summarized-thinking.md      (pi-summarized-thinking's design note, d117)
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
  is a file layout, not the graph. **Which file carries the front door is the
  unit's choice** — `README.md` in `estige/` and `git/`, `DESIGN.md` in
  `coding-agent/` and `llm-local-inference/` — because the id and the edge, not
  the filename, are what the graph reads; the other file of the pair is an
  ordinary `module-design` doc parented to that node. The `pi-*` packages carry
  one too, their `README.md` being the front door and their folder rules staying
  in `AGENTS.md` (d141 — until then the whole family was node-less prose). A
  folder with nothing to declare still has no node: the rule binds units that
  own specs, not every directory.
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

| type                    | scope                                                                                                                         | in this tree                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal-and-requirements` | what the system must do — normative, one document                                                                             | `docs/requirements.md` (id `goal`, the root of the living tree)                                                                                                                                    |
| `architecture-design`   | spans the repository or crosses module boundaries: the map, the shared rules, prior art, system-wide decisions                | `docs/architecture.md`, `docs/environments-and-variants.md`, prior-art and audit docs, the d0XX records that change the layout or a shared contract                                                |
| `module-design`         | confined to one runner folder or one module (`coding-agent/`, `estige/`, `git/`, `llm-local-inference/`, or a `pi-*` package) | each module's `README.md` + `DESIGN.md`, a `pi-*` package's `README.md`, the module-scoped decision records                                                                                        |
| `submodule-design`      | a directory-level subsystem inside a package                                                                                  | `estige/CI.md`, `llm-local-inference/CACHE-DESIGN.md`                                                                                                                                              |
| `task-spec`             | one piece of work with acceptance criteria                                                                                    | temporary by definition — the ThinkRail tools write them to `.thinkrail/context/TASK-*.md` and the work's landing removes them. Nothing durable belongs here; a finished decision becomes a record |

Choosing between the first two is the only judgement call: **would the decision
still hold if the module were deleted?** Yes → `architecture-design`. No →
`module-design`. The d0XX log is not a type: records are typed by that same
scope test, and the `d0XX` filename prefix is what marks them as history.

## Lifecycle

`status` is the record's position in its life, and it is separate from `type`.

| status       | meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `draft`      | being written or proposed, not in force; nothing in the tree has to obey it yet |
| `active`     | in force — the code and docs are expected to match it                           |
| `stale`      | still in force but known to lag the tree; needs a keeper                        |
| `done`       | the work it describes is complete, or the investigation is finished             |
| `deprecated` | superseded or retired; kept as history, pointed at by its successor             |

Rules that keep the value parseable:

- **One word.** Anything the record needs to say beyond the lifecycle word goes
  in a `## Status` section at the top of the body — "superseded by d084",
  "phase 1 landed, phase 2 deferred", "enforced at each generator change". That
  prose is where the qualifier belongs: it is readable, and it cannot break a
  parser. "Top of the body" means the first section: a document's opening block
  of prose sits above it (`docs/writing-style.md`), so the qualifier stays the
  first thing a reader reaches by heading.
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
  package, not this workspace, so an edge here would dangle (d111). Which trees
  the tools index matters here, because it is narrower than "the tree" and wider
  than git: they skip `node_modules/` (an id-bearing file there is invisible to
  `spec_grep`, `spec_get` and `spec_validate`) and index **everything else,
  including trees `.gitignore` hides** — `.venv/`, `__pycache__/` and
  `.thinkrail/context/` all answer to a search. So a second copy of that file
  anywhere outside `node_modules/` is an immediate duplicate-id failure: keep
  exactly one, and delete stale copies of the workflow package instead of adding
  them beside it.

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
   record it happens to follow from (that is `depends-on`). `spec_create`
   scaffolds only `id` and `type`, so a node taken straight from it fails the
   gate three times over (`parent-missing`, `status-missing`, `title-missing`):
   add the rest with `spec_update` in the same sitting.
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
5. Write the prose to `docs/writing-style.md`: the opening block (what it is,
   what it is not, who reads it), one idea per sentence, and the three modal
   forms for how binding a statement is. A living doc keeps its prose timeless;
   a record stays true to its own moment instead (`docs/d142`, `docs/d143`).

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
against this tree in d112, and re-measured on the tooling itself in d140's
amendment):

| the tooling                                                                           | the contract                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| reports duplicate ids, dangling links and cycles — run it after any structural change | nothing extra: the same failures                                     |
| requires only `id`, `type`, `title`                                                   | `status` and `parent` required as well (see _Which rules are whose_) |
| writes and indexes any `type:` / `status:` value                                      | the five types and five statuses; nobody else checks them            |
| accepts a missing `title`                                                             | a title on every node                                                |
| writes `covers` but never resolves it                                                 | `references` for an edge you mean                                    |
| accepts a record as a parent, or a module-scoped spec at `architecture`               | the nesting rules above                                              |
| skips `node_modules/` and indexes every other tree, `.gitignore` or not               | exactly one copy of a vendored spec                                  |
| indexes `.venv/` and `.thinkrail/` — the gate skips both                              | no durable node in either; nothing to check there                    |

That gap is the reason the checks below exist: they are the part the tooling
does not do, and skipping them is how this tree carried 33 misplaced nodes
through a dozen green validation runs (d112).

## Mechanical enforcement

`./docs/spec-check.mjs` is the executable half of this contract (adopted by
d140). Every rule above that a machine can decide is checked by `./lint.sh`'s
`spec graph` leg, so "is the graph valid?" no longer depends on somebody
remembering a grep pipeline. It needs node and nothing else — no network, no
ThinkRail tooling, no YAML package — and it walks the whole tree except `.git`,
`node_modules`, `.venv` and `.thinkrail` (the blind spot the tooling table above
names: the last two are trees ThinkRail does index, so nothing durable may live
in either). Its own suite, `docs/tests/spec-check.test.mjs`, is run by
`./test.sh` and pins every finding code below, the walk's skip list, and the
committed tree's cleanliness — a rule added here without a fixture there is
unpinned.

Run it alone as `./node-run.sh docs/spec-check.mjs [root]`: exit 0 clean, 1
findings, 2 unreadable tree. A finding prints as `path: [code] sentence`, and
the code is the vocabulary of the gate:

| code                       | the rule it enforces                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| `frontmatter-unterminated` | an opening `---` with no closing `---` — every reader would eat the document |
| `value-unquoted`           | a frontmatter value containing `: ` and no quotes (the truncation trap)      |
| `half-node`                | `id` without `type`, or `type` without `id`                                  |
| `type-unknown`             | a type outside the five                                                      |
| `status-missing`           | no `status` — the lifecycle is part of the contract                          |
| `status-unknown`           | a status outside the five                                                    |
| `title-missing`            | no `title`                                                                   |
| `id-spelling`              | neither a bare `dNNN` handle nor lowercase kebab-case                        |
| `id-duplicate`             | two files claiming one id                                                    |
| `edge-unresolved`          | `depends-on` / `references` / `implements` naming no node                    |
| `parent-missing`           | no `parent` on a node that is not the root and not under `.agents/`          |
| `parent-unresolved`        | a `parent` naming no node                                                    |
| `parent-not-a-unit`        | a `parent` that is a record or a plain doc, not a code unit                  |
| `parent-level`             | the parent's level does not match the child's `type`                         |
| `parent-cycle`             | the chain returns to a node it already visited                               |
| `module-node`              | a front door whose id is not its folder name                                 |
| `placement`                | a record outside `docs/`, or a living doc outside its parent's folder (d117) |

What it deliberately does **not** decide: whether the chosen `type` is the right
scope judgement, whether an id deserves its name, whether a record's prose still
matches the code, or whether a body's `## Status` qualifier is honest. Those are
reading work, and a gate that guessed them would be wrong loudly.

## Rulings: the points the contract left to implication

Reading this file end to end without the tooling turned up the questions below,
each answered only by implication before (d140's audit). They are decided here
rather than in a chat, because a contract two readers must interpret is two
contracts — the first six are enforced by the gate.

- **`status` is required.** The field table used to say "recommended" while the
  lifecycle section said "one of the five, nothing else ever"; nothing said what
  absence meant. Absence now means drift, and the gate reports it. An empty
  lifecycle is not a default, it is a node nobody can classify.
- **The legal-parent roster is derived, not listed.** The nesting check printed
  a hand-maintained `printf` of module ids, which had already gone stale: a
  submodule node may parent (the contract says so, the roster did not), so
  `llm-local-inference-cache`'s docs looked illegal. A legal parent is `goal`,
  `architecture`, or any node the graph itself types as a module front door or
  a submodule.
- **One front door per unit, and its filename is the unit's choice.** See the
  nesting rules: `README.md` carries it in two units, `DESIGN.md` in the other
  two. What makes a file the front door is `type: module-design` +
  `parent: architecture` + `id` equal to its folder name, at the folder root —
  not the filename.
- **A half node is a finding.** "A file that carries `id` without `type` is
  simply not a node" described the symptom, not the rule: it still claims an
  identity that other docs may link to, so the gate refuses it.
- **`parent` is required except for the graph root and the `.agents/` subtree.**
  The vendored spec's package nodes ship with the workflow package, so an edge
  there would dangle (d111); every node in that subtree inherits the exemption
  rather than the one file, because a vendored package may add a node of its own.
  "For living docs" left the archive and the node-less folders ambiguous; neither
  is exempt.
- **Records are the one exemption from the file/edge agreement.** A record's
  file lives in `docs/` (or `docs/archive/`) whatever its `parent` says,
  because the log is one chronological shelf. The archived `module-design`
  parked at `architecture` is allowed only with `status: done` or
  `deprecated`: a finished investigation has no module left to hang from, a
  live one always does.
- **A record that decides two things at different scopes is typed by the higher
  scope.** The contract assumed one decision per record; d123 is two (the Go leg
  of the sweep, and an egress refusal in estige). Typing it `module-design`
  would file a sweep-wide rule inside `estige/`; it is `architecture-design`
  and the body carries both halves. Split the record when the halves stop
  sharing a reason.
- **A node-less folder is legal.** The rule that each unit has exactly one node
  binds units that own specs. The `pi-*` packages were the example here — prose
  only, installed by path — until d141 gave each of them a front door, on the
  ground that a folder owning an entry, a generator, a committed artifact and a
  test suite owns behaviour worth a node. The principle is unchanged, only the
  example: a directory with no contract to state carries no frontmatter, and
  that is not drift.
- **`covers` stays unenforced.** The gate ignores it, matching the validator:
  an edge nothing resolves is worse to "fix" mechanically than to leave alone
  until someone means it.

## Checking the graph without the tooling

These greps are the fallback for a checkout with no node at all — the gate
above runs the same rules. A check that prints something is a finding, not a
warning: fix the value, the id, or the link before adding anything on top of it.
`SPECS` excludes the tool-owned `.thinkrail/` scratch folder, the installed npm
and python trees, and `.git` — the same set the gate skips, so a finding here is
a finding it would report too. `.agents/` stays in on purpose: its vendored spec
is a node.

```sh
SPECS=(-r --include='*.md' --exclude-dir=.git --exclude-dir=.thinkrail --exclude-dir=node_modules --exclude-dir=.venv .)
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
# parents that are not a code unit. The second list must hold every id that may
# parent: the two roots, each module front door, and each submodule node. The
# gate derives it from `type:` + `parent:`; the hand list here is the coarse
# stand-in, so re-read it when a unit is added.
comm -23 \
  <(grep -rh '^parent: ' "${SPECS[@]}" | sed 's/^parent: *//; s/"//g' | sort -u) \
  <(printf '%s\n' goal architecture coding-agent estige git llm-local-inference \
      llm-local-inference-cache estige-ci \
      pi-hyper pi-verboo pi-synthetic pi-cline-pass pi-mistral pi-opencode \
      pi-summarized-thinking \
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
