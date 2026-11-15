---
id: d196
type: module-design
status: draft
title: "d196 — the decision point and the isolation envelope: derive, reprove, repair, journal"
parent: codemode2
depends-on: [d194, d163]
references:
  [
    d176,
    d151,
    d115,
    d127,
    d180,
    d181,
    d156,
    d198,
    d150,
    d152,
    d153,
    workload-sandboxing-prior-art,
    codemode-runtime-prior-art,
  ]
tags: ["codemode2", "sandbox", "refusal", "execution", "isolation", "worktree", "review", "design"]
---

# d196 — the decision point and the isolation envelope

This record carries the phase-two design for **codemode2**: how a program becomes
a canonical tree that is decided on, refused or repaired, and executed against a
worktree the runtime owns, with a mutation journal and a rollback instead of a
review wherever the operation is reversible. It is the answer to two questions
[d194](d194-codemode2-closed-tool-surface.md) leaves open — who decides, and what
the executor can touch — and it is deliberately not a third answer to "is this
command safe".

The reader is whoever builds the executor, attacks it, or operates the queue. The
design's own claim is narrow: **safer by design, still not trusted.** Every layer
below removes an attack surface or a decision from a human's hands. None of them
is a boundary, and nothing outside the sandbox may treat the sandbox as one.

## Status

Draft, unbuilt. [d194](d194-codemode2-closed-tool-surface.md) owns the surface
(58 commands, the four bars, the deny roster); this record owns the layer above it
(normalisation, derivation, the refusal cascade, the lease, the worktree
envelope). The runtime shapes the executor chooses between are
[d150](d150-codemode-and-base-tooling.md) and
[d152](d152-pymode-a-python-code-mode-extension.md), and the ergonomics claim the
refusal cascade has to answer is [d153](d153-minimal-agents-over-real-runtimes.md)'s.
No code implements any of it yet.

## What "still not trusted" means

The phrase means something narrower than "untrusted code", and the difference is
the layer. Containment — a hostile dependency, an injected agent, a damaged tool
([workload-sandboxing-prior-art](workload-sandboxing-prior-art.md)) — is not what
this design answers; it removes capability from a cooperative author rather than
containing a hostile one. Four things are still not trusted _by the surface_, and
each one names who must compensate.

- **The parsers and reimplementations are unaudited code.** A surface command is
  a new program with new bugs; the corpus that justified it is not a proof of it.
  The remedy here is the cascade and the journal, and the workload layer is what
  keeps the claim from mattering to the host.
- **The corpora are not exhaustive.** [d194](d194-codemode2-closed-tool-surface.md)'s
  own findings list what they cannot see (loader variables, config seams, archive
  entry names).
- **The reviewing tiers are steerable.** A model reads the program it is asked to
  reprove, and can be moved by text it was not asked to trust
  ([d115](d115-live-listing-input-schema-poisoning.md)'s lesson, one layer up).
- **The envelope is not a machine boundary.** The worktree bounds what one run may
  write. It says nothing about the process, its dependencies, the kernel, or a
  co-tenant; those are the containment layer's, and a deployment that skips it is
  not this design's failure mode but its absence.

So the four bars of d194 stay the boundary, and the layers below are _defences
alongside_ them: a wrong decision costs a refused retry, never an escape. What this
design adds on top of the bars is reversal and refusal quality, not trust.

## The decision point: decide the tree you execute

Free-text shell never reaches an executor. A program is parsed once into a
canonical tree, and that tree is both the thing decided on and the thing run — the
two are the same bytes, so a normaliser bug is a refusal, not a bypass.

```
source → tokenise → parse (closed grammar; unmodelled construct = refusal)
       → canonical AST (command resolved, flags split, operands typed, paths symbolic)
       → derive (node → grants, grade)     ← mechanical, no model
       → cascade (allow | reprove+repair | escalate)
       → execute the AST under the lease
```

Three properties are not negotiable, because they are what make the later tiers
honest.

- **The residual is a refusal class.** Anything the grammar cannot model — `eval`,
  `.`/`source`, command substitution, heredocs, process substitution, an unknown
  flag — stops at the parser. Passing unparsed text to a judge reopens the
  sanitizer-versus-interpreter gap.
- **Canonical form is the identity.** The AST hashes; the lease names the hash;
  the log records it; the cache keys on it. An obfuscated variant of an approved
  program is the same request, not a new one.
- **Equivalence is tested, not assumed.** For every probe in
  `codemode2/attack-corpus.json`, the quoting, alias, `${IFS}`, assignment-prefix,
  bundled-flag and full-path mutants must canonically equal it. That suite is the
  normaliser's gate, and it is cheap because the probes already exist.

## Derive, do not decree

The small decider never authorises. Grades and grants come from a table over node
types, computed before any model is consulted:

| node                                               | grants                                           | grade            |
| -------------------------------------------------- | ------------------------------------------------ | ---------------- |
| `read`, `grep`, `find` (predicates)                | `fs.read(worktree)`                              | allow            |
| `write`, `cp`, `mkdir`, `git.add`                  | `fs.write(worktree)`                             | allow            |
| `git.rm`, `git.checkout`, `rm`                     | `fs.write(worktree)`, `fs.write(repo/index)`     | allow, journaled |
| `git.commit`                                       | `fs.write(repo/objects)`, `fs.write(repo/index)` | allow, journaled |
| any `exec`, `net`, `cred` node                     | —                                                | unrepresentable  |
| repository config, hook path, filter driver, alias | —                                                | unrepresentable  |

The named grants are the point. d194's `fs.write` becomes three resources —
worktree, index, object database — so "delete a tracked file" is distinguishable
from "write a new file", and the default envelope is the worktree only. That
revision of `surface.json` (a grade and named grants per row) is the next change
to the artifact, and this record is its spec.

Consequences worth stating plainly: a git hook is not a reviewed operation, it is
**inert data**, because no node executes and no repository config is honoured.
`git` itself is a reimplemented node set (`status`, `diff`, `log`, `add`, `rm`,
`checkout`, `commit`), never a brokered binary — GTFOBins files `git` under shell
because its config, aliases, pagers, hooks and `-c` overrides are an execution
engine, and the repository supplies that config.

## The refusal cascade

Escalation moves the _justification_, never the permission. Each rung either
refuses with a rule and a repair, or hands off; no rung approves.

| rung                     | decides                                                                 | cost    | hands off when                          |
| ------------------------ | ----------------------------------------------------------------------- | ------- | --------------------------------------- |
| parse                    | unmodelled construct                                                    | exact   | never                                   |
| derive                   | grant outside the envelope                                              | exact   | never                                   |
| static destructive table | `rm -rf .`, `git reset --hard`, `git clean -fdx`, tracked-file truncate | exact   | never — refuse, or allow with a journal |
| small screen             | legal but mismatched with the request                                   | ~1 s    | cannot name a rule                      |
| strong reproval          | the same, harder, plus repair synthesis                                 | seconds | cannot name a rule                      |
| operator                 | the unrefused lease, pre-drafted                                        | human   | —                                       |

Four rules keep the cascade from becoming noise.

- **A reproval is falsifiable.** Its output is `{rule, evidence, alternative_ast}`.
  "Risky" is a handoff with extra latency, so each rung is scored on specificity
  and repair rate, not on how often it says no.
- **Class dedupe.** A reproval covers a lease class for the session; instances are
  bound by AST hash. Forty destructive variants become one rule and one log line.
- **Review programs, not steps.** The whole tree is known before the first node
  runs, so a twenty-step destructive plan is one reproval at a checkpoint.
- **The operator rung is budgeted.** Two interruptions per run by default; the
  excess stops the run with a summary rather than queueing. A rate-limited
  operator is the only operator who reads.

A reproval is not appealable to its author — the agent gets the repair, the
operator gets the case — and the reviewing tiers read the AST, the lease and a
bounded path/diff preview, never file bodies or package prose. "Won't work"
(unrepresentable, unknown flag) and "won't serve the request" are separate rungs,
because a parser is exact and a reviewer is not.

## The isolation envelope: a worktree, a journal, a rollback

Isolation is what makes the cascade cheap, and it is where the alert fatigue is
actually defeated: a destructive operation the envelope can undo does not need a
human. It is blast-radius isolation over operations the surface already permits,
not containment of hostile code — the surface decides what may be asked for, and
this envelope decides how much of it can be undone. That last clause is the invariant
[d198](d198-reversible-mutation-journal-and-checkpoint.md) prices: a verb is
auto-graded because its effect is undoable, so the refusal rate the model meets is
proportional to the irreversibility of its verbs. The mechanisms, their costs and the
measurements that decide between them live in that record.

- **The runtime owns a snapshot of the repository** — a copy-on-write worktree over
  the visible tree, with the object database and the index as separate named
  resources. The host's worktree is never written directly; an export step, itself
  a graded node, is the only way bytes leave.
- **Every mutation lands in a journal** before it lands in the tree: node, path,
  prior content hash, lease id. The operator's summary is the journal; the
  rollback is the journal replayed backwards, or the snapshot dropped.
- **The lease binds the run**, not the session: grant set, budget (ops, bytes,
  time), expiry, AST hash, intent reference. Execution re-derives the grants and
  refuses a node whose grant the lease does not carry — a mid-run tree swap is a
  refusal, not a race.
- **Ephemerality is the default.** A run that ends leaves no state the next run
  inherits, except what the journal exported, so a poisoned artifact cannot become
  a persistent capability.
- **The envelope is not a machine boundary.** Egress remains
  [d127](d127-proxy-only-container-egress.md)'s chain step, credentials never enter
  the runtime, and co-tenant and kernel assumptions are the container's, not this
  design's.

What this buys is the classification that matters for the operator: an operation is
either **unrepresentable** (nothing to ask), **reversible** (silence is safe
because the journal can undo it), or **irreversible** (the residue worth a human).
A review queue built before that split exists is a queue of everything.

## Failure modes and the number that catches each

| failure          | shape                                            | metric                                                        |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| over-rejection   | legitimate work refused until the task fails     | false reprovals on the negative set; abandonment per reproval |
| reproval theatre | "risky" with no rule, no repair                  | specificity and repair rate per rung                          |
| sycophantic flip | the same rung re-asked says yes                  | appeals refused at the same rung, by construction             |
| injection        | repo text steers the reviewer                    | review input surface: AST + lease + bounded preview only      |
| lease creep      | grants accumulate across a run or a session      | lease scope diff per node; single-use leases                  |
| silent damage    | the operator sees nothing and the tree is wrong  | journal exists for every mutation; random replay audit        |
| unwanted queue   | escalation rate high enough to be the bottleneck | interruptions per 100 runs; time before first node            |

## What would make it trusted

Two of these would move the environment out of "safer by design", and neither is
planned here: an **audited reimplementation suite** (a second implementation of the
surface, differentially tested against the first — the corpus's probes as the
input), and a **kernel-enforced bar** (seccomp/landlock verdicts logged and asserted
at run time, not stated in a document). Both are surface-layer trust: they make the
closure auditable, and neither touches the containment question, which no tool
surface can answer. Until they exist, this runtime is a good neighbour and never a
boundary, and the host, the operator and the harness all behave accordingly.

## Open questions

- **Grade vocabulary.** Whether `allow | escalate | deny` is enough, or whether
  "allow but journaled" needs to be its own grade. The table above treats the
  journal as a grant property, which is the terser spelling.
- **Intent reference.** Who writes it, and how a reviewer resolves it without
  reading untrusted prose. The harness's own request is the candidate source.
- **Snapshot mechanism.** Overlay, hardlink farm, or `git worktree` against a
  read-only object store — each has a different failure mode on `git rm`.
- **Journal granularity.** Per node or per path; the replay audit wants the second,
  the rollback cost wants the first.
- **Operator budget.** Two interruptions per run is a guess; the session logs
  ([d180](d180-session-collection-leg.md), [d181](d181-session-ingest-route.md)) can
  measure what a real run needs.
- **Cross-run export.** An export step is a graded node, which means the isolation
  envelope has exactly one door — worth designing as a door, not as a copy.
