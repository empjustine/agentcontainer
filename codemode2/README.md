---
id: codemode2
type: module-design
status: draft
title: "codemode2: a closed core-tool surface, enumerated from the living-off-the-land corpora"
parent: architecture
depends-on: [d194, d196, d198, d150, d152, d153, d156, d176]
references: [codemode-runtime-prior-art, d153, d163, d127, d113]
tags: ["tools", "sandbox", "shell", "allowlist", "gtfobins", "lolbas", "research"]
---

# codemode2: a closed core-tool surface

**codemode2** is a tooling framework whose whole surface is a table of POSIX and
Windows core-tool contracts — each command exposing a deliberately small slice
of what its namesake does, over a filesystem the runtime owns, with no process
creation, no network, no privilege and no loader. It is not a shell, and it does
not filter binaries: the tools are reimplemented, so the dangerous half of each
binary is absent by construction rather than denied by policy. Closing the surface
is the product decision — a toolset the model already knows how to drive, minus the
escape half — not a containment claim (see the next section).

The reader is whoever builds or attacks that surface. The reasoning lives in
[d194](../docs/d194-codemode2-closed-tool-surface.md) (the research record); this
file is the folder's front door: what the artifacts are, how to reproduce them,
and what is still open.

## The layer this is, and the layer it is not

Two trust questions sit next to each other in this repository, and they are not one
question.

- **Containment** asks what _the code_ may do to the machine. The adversary is the
  code itself: a hostile dependency, an injected agent, a compromised tool. Mount
  and namespace policy, egress, credentials, disposal and the workload runtime
  answer it ([workload-sandboxing-prior-art](../docs/workload-sandboxing-prior-art.md),
  [workload-api](../docs/container-tooling.md), [d127](../docs/d127-proxy-only-container-egress.md)).
  This unit changes none of that.
- **Surface closure** asks what _the sentence_ may make the machine do. The
  adversary is the tool surface the model drives: a convenience flag that is a
  program launcher, a command that is a data destroyer, an idiom from the training
  corpus that reads as one thing and does another. That is the question here, and
  it is asked of a cooperative model on a clean repository, because the danger is
  in the feature rather than in the intent.

The two layers share mechanisms — `no_new_privs`, seccomp, path policy, no egress —
for different reasons. A deployment puts this runtime **inside** the containment
layer; this design never claims to be that layer, and a security review should not
accept it as one. What closure buys is the other half of the decision: a model
trained on bash and pwsh keeps a familiar, composable surface
([d153](../docs/d153-minimal-agents-over-real-runtimes.md),
[d156](../docs/d156-shmode-a-closed-shell.md)) instead of a read/write/edit/grep/find
vocabulary, and the surface is closed at the same time.

## Status

Draft — research only. No runtime exists. What exists is the decided surface
(`surface.json`), the corpus projection that justified it (`taxonomy.json`), and
the probe set derived from the corpora (`attack-corpus.json`), all reproducible
from the reference farm.

The build plan is three records. [d194](../docs/d194-codemode2-closed-tool-surface.md)
owns the surface: which commands, which flags, four bars, the deny roster.
[d196](../docs/d196-refusal-cascade-and-isolation-envelope.md) owns the layer above
it: the canonical tree that is both decided on and executed, the mechanical
derivation of grants, the refusal cascade that reproves and repairs instead of
approving, and the worktree-plus-journal envelope that turns a destructive
operation into a rollback rather than a review.
[d198](../docs/d198-reversible-mutation-journal-and-checkpoint.md) prices that reversal —
the mechanisms, their costs, and the five measurements that decide whether "reversible"
can be the default grade, which is the same dial as how much surface the model gets.

d196's own claim is the working assumption here: **safer by design, still not
trusted.**

## Inherited research

The runtime and tool-surface questions were surveyed before this unit existed.
Those records now hang off this node and are this spike's evidence base, unchanged:

- **d150** — the four harnesses' Code Mode implementations and their base
  inventories: what a catalog is, where the model learns it, and the eight
  capabilities every base set shares.
- **d152** — pymode: what a sibling Python code mode costs, and the interpreter
  options with their prices.
- **d153** — whether a minimal agent over a familiar runtime beats a tuned
  sandbox, written as a measurement nobody has run; its claim is this unit's
  hardest open question.
- **d156** — shmode: the first closed-command-table sketch, and the pipeline
  finding that a multi-stage pipeline needs a filesystem holding the truth.

Two surveys stay at `architecture` because they outlive the unit:
[codemode-runtime-prior-art](../docs/codemode-runtime-prior-art.md) (the four
runtime shapes, with the farm's tips) and
[workload-sandboxing-prior-art](../docs/workload-sandboxing-prior-art.md) (the
backends). [d176](../docs/d176-reimplement-contracts-not-tools.md) supplies the rule
the surface applies to them: reimplement the contracts, not the tools.

## The artifacts

| file                 | what it is                                                                                                                     | who owns the words |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `surface.json`       | the decided surface: 44 POSIX and 14 Windows commands, their grants, the allowed flags, the denied flags, the deny roster      | `docs/d194`        |
| `enumerate.mjs`      | the enumeration: reads the GTFOBins and LOLBAS mirrors, projects them onto the candidate tool names, emits the two files below | this file          |
| `taxonomy.json`      | GENERATED — corpus tips and counts, the GTFOBins function table (total vs unprivileged), and one row per candidate tool        | `enumerate.mjs`    |
| `attack-corpus.json` | GENERATED — the corpora's own examples for the functions a command does not expose: the red-team suite, once a runtime exists  | `enumerate.mjs`    |
| `tests/`             | the parser and surface invariants that hold offline                                                                            | `codemode2/tests`  |

## Reproduce the projection

```sh
./node-run.sh codemode2/enumerate.mjs           # rewrite taxonomy.json + attack-corpus.json
./node-run.sh codemode2/enumerate.mjs --check   # exit 1 when the corpus moved
```

The input is the bare-mirror farm (docs/d043), default
`~/Downloads/references/github.com`, override with `--farm DIR`. Two mirrors are
read at their tips: `GTFOBins/GTFOBins.github.io.git` and
`LOLBAS-Project/LOLBAS.git`. The committed output carries both tips, so
`--check` on moved corpora is a loud finding, not an aged table.

The projection is deterministic: same tips in, same bytes out. It sorts every
collection it emits and stamps nothing but the tips.

## The four bars, in one paragraph

GTFOBins is a table of capabilities annotated with the context that reaches them,
and LOLBAS documents only the _unintended_ use of a binary — so neither says
"this tool is unsafe". What they show is that nearly every core utility carries a
feature that leaves the sandbox, and that those features cluster behind four
bars: **exec** (start a process), **loader** (write somewhere dynamic code is
loaded from), **privilege** (uid, capabilities, SUID) and **network**. A surface
that removes all four keeps only file read, file write and text transformation —
exactly what a coding workflow needs. `docs/d194` carries the numbers; a command
in `surface.json` may declare `fs.read`, `fs.write`, `env` and `clock`, and the
test suite refuses any row that asks for `net` or `exec`.

## Folder rules

- One copy unit (docs/d113): no `lib/`, and `tests/` reads only this folder. The
  farm path is an input of `enumerate.mjs`, not a dependency of anything else.
- `taxonomy.json` and `attack-corpus.json` are generated — never hand-edited. A
  hand edit is what `--check` exists to catch.
- `surface.json` is source, not output: it is the decision, reviewed as prose in
  the record and as flags here. Every command row carries its strategy
  (`reimplement`; `broker` is reserved and unused), its grants, and the flags it
  refuses.
- Regenerating `taxonomy.json` after a corpus move is a normal change; the
  record's numbers are re-read in the same commit.
