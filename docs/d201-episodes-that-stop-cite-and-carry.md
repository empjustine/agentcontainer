---
id: d201
type: module-design
status: draft
title: "d201 — a journey bench for stopping, citing and drifting: generated scenes, judge-free scoring, days on a slow host"
parent: llm-local-bench
depends-on: [d196, d113]
references: [d194, d198, d153, writing-style, llm-local-bench]
tags: ["bench", "agent", "refusal", "ambiguity", "local-inference", "evaluation", "design"]
---

# d201 — a journey bench for stopping, citing and drifting

This record decides the shape of [llm-local-bench](../llm-local-bench/README.md):
what a benchmark of "refuse the unreasonable request, find the local answer, keep
doing it" can measure, how the measurement stays out of the training data, and how
it runs for days on one slow local model without a supervisor. The folder owns the
artifact map and the mechanics; this record owns the decisions and what they cost.

## Status

Draft, built to the grammar `0.2.0` and never yet pointed at a model. The
generator, the scorer, the runner and their tests exist. No threshold, no baseline
table, and no second grammar. The leakage control below is a procedure a run must
include, not a flag the runner enforces.

## Problem

A local model's failure modes are not the ones the popular benchmarks score, and
none of them is a single-step property:

- it answers an ambiguous request instead of asking, and the answer is
  confidently wrong in a way that reads as progress;
- it answers from prior knowledge where the truth lives only in the repository,
  and the invention is indistinguishable from a finding;
- it holds that discipline for a while and then loses it — the failure arrives
  after enough ordinary work, not on the first hard question;
- it thrashes, repeats a call, or stops terminating, which is the shape a low-bit
  quantisation or a starved context window takes.

A benchmark of "does it produce a passing patch" cannot see any of the four: it
rewards the guess when the guess lands, it never asks who the answer belongs to,
and it has no notion of how long the model stayed sound. The internal knowledge a
human-wisdom benchmark tests is also the wrong axis, because a local model cannot
win it and a coding agent does not need it — it needs the initiative to look, and
the judgement to stop when looking settles nothing.

Three constraints bound the design as much as the failure modes do. It must stay
local: no cloud judge, no network corpus. It must stay un-leaked: a request that
exists on the internet measures memorisation. And it must run unsupervised for days
on an inference server that serves one request at a time, so every step has a
deadline, and a crash costs one journey rather than a night.

## Decision

### The unit is a journey, not a step

A seed composes a small repository and a journey of any length: roughly a quarter
of the steps are traps, the rest are ordinary chores, and the traps sit at seeded
positions with at least two chores between them and none in the warm-up. A short
bench asks whether the model can answer one trap; only a long one asks how far it
gets, which is the property an operator can act on.

The growing length is not a difficulty ramp, it is the mechanism: the journey
accumulates the agent's own edits, its own notes and its own filled context, and
the question is what those do to its discipline.

### The primary reading is a distance

The report leads with the ordinal of the first trap that broke the journey, the
traps survived, the steps answered, and the cause — wrong decision, bare refusal,
missed source, missed fact, or no answer at all. The aggregate is a survival
curve: per trap ordinal, how many journeys reached it and how many were still
clean. That is a rate over a small sample, so it carries an interval and the
verdict says `Inconclusive` until the interval is narrow.

A second table reads the same traps by their position in the journey. A flat
curve is discipline that survives accumulation; a falling one is drift, and it
names the point where the model stopped looking.

### Traps are a minority and the decoy is mandatory

Most steps must be answered, not refused. The chores are the over-refusal
counterweight, and one of the six trap shapes — the decoy — is a conflict the
repository resolves, so proceeding is correct. A model that refuses everything
survives no journey and passes no chore.

The six shapes are cycled with a shuffle and repeated with fresh tokens, so a long
run measures the same behaviours more than once instead of measuring more
behaviours once.

### Two accumulations, kept separable

The workspace persists, because the agent's mess is part of the condition being
measured: its notes file is what the `echo` trap reads back, wrongly. The context
persists too, because the agent is spawned once per journey and fed one request
per line.

The control arm (`--arm steps`) runs the same seed through the same workspace with
a fresh process per step. The difference between the arms is what the session's
own history costs, holding the filesystem constant. A third arm that also isolates
the workspace is deliberately absent: it would answer a different question, and a
slow host cannot afford another doubling.

### The answer key is anchored out of band

Scene files that the agent edits are compared against the seed, never against the
previous step, so a tampered decision record does not move the truth and cannot
forge a later key. The journey is marked tampered, and the count is its own line
in the report — a model that "fixes" the contradiction by rewriting the record has
derailed without ever deciding wrongly, and that is a distinct finding.

### Stop quality is a structure

A stop counts only when it carries a question and the action it refused to take. A
bare refusal is the cheap move this bench exists to distinguish from a
clarification, so the answer envelope carries both fields and the scorer reads them
as booleans.

### Judge-free scoring

Every check is a string or file predicate: the decision field, the cited paths,
the seeded token anywhere in the answer object, the artifact's contents, and
whether a cited path exists at all. A second local model would be another
quantised opinion, a cloud judge contradicts the constraint that made the bench
local, and neither can be re-run from a journal by a reviewer without the model
that produced the answer.

### A repair pass grades what a decision could not

A wrong decision cannot be re-asked: the harness cannot adjudicate "would you have
stopped", and a model told its answer was wrong can only agree. A wrong file can.
So the second and third passes grade **repair**, on the state the journey left:

- The tree records its own history: every note line names the request that wrote
  it, and the harness keeps the transcript of requests in `JOURNEY.md`. Without
  both, a claimed span would be a guess and a repair would be ungradeable.
- `defectsOf` derives the ledger from the SEED, not from the session's memory: a
  missing note, a note whose value no record states, a scene file edited away from
  the seed. It is the only surface a repair pass can be scored on, and it is why
  the pass grades files and never decisions.
- The probe is one **witness**: a symptom with no request number and no cause. The
  rest of the damage is the test. A model that fixes only the notice scores a
  repair of one and a span of one.
- The pass runs in a **fresh session**. The context that produced the mistake is
  gone by construction; that is the circumstance a resumed harness actually faces.
- Grading is four numbers — fixed, remaining, regressed, and the claimed span
  against the recorded one — because "it repaired" and "it repaired the right
  amount" are different findings, and "it broke something sound" is a third.

### Journal, attempts, and a report that is a recount

One step has a wall-clock deadline; hitting it is recorded as a timeout and the
process group is killed, because the timeout is the measurement. Results are
appended to `journal.jsonl`, a torn line is skipped, an unfinished journey is
re-run under a new attempt number, and the report is computed from the journal —
so an interrupted run reports the distance each journey actually reached.

## Alternatives rejected

- **A fixed spine of traps.** Nine steps make nine memorisable answers, and they
  cannot answer the only question that matters here — how far — because there is
  no "far".
- **A curated corpus of ambiguous requests.** The shortest route to a leak: one
  committed list is a training target, and every model tuned on it scores without
  the behaviour.
- **A real repository as the subject.** The prior knowledge of real code is the
  contamination this bench cannot price, and the ground truth would be an opinion
  about a diff. Generated scenes keep the answer key exact.
- **Per-step isolation as the primary arm.** A fresh process and a rebuilt world
  remove exactly the pollution the bench exists to measure. It survives as the
  control arm, where that removal is the point.
- **Asking the same journey again and calling the difference repair.** A rerun
  measures variance, not recovery; recovery needs the state the first run left and
  a notice that is smaller than the damage.
- **A withheld-source step to test whether state was written down.** Rebuilding a
  step's world to hide its sources measures memory discipline in a world that does
  not exist; `echo` measures the same thing against the state the journey really
  accumulated.
- **Retrying a timed-out step.** A retry doubles a run already measured in days
  and hides the loop the timeout detected.
- **An LLM judge, local or remote.** The local one is a second broken opinion on
  the same hardware; the remote one breaks the locality that makes the bench
  runnable at all.
- **A composite "agent score".** One number hides the trade between stopping and
  doing, and hides the distance, which is the finding.

## Consequences

- **The journey is expensive.** A forty-step journey is forty model round trips;
  four seeds of two arms is a night or two on a slow host. The length is a flag for
  that reason, and the verdict line is what tells an operator whether the night
  bought anything.
- **Repair is graded only where a file was written.** A model that is wrong in a
  decision and right in its citations leaves no defect behind, so the repair pass
  cannot see it; the two passes and the journey are three measurements of one
  session, not one measurement of three.
- **The grammar is the ceiling.** Six trap shapes cover a fraction of real
  ambiguity. `GRAMMAR_VERSION` bounds every claim, and a second grammar is a new
  comparison rather than an extension of the old table.
- **Token grading rewards a dump.** An answer that lists every plausible value
  satisfies the fact check; the chores, `clean` and `invented` are the
  counterweight, and a reader ranks by them.
- **A dead session hides the rest of its journey.** The steps after a death are
  recorded as unreached rather than failed, so a survival curve is over the traps a
  journey actually met — which is why the death count and the answer count are
  printed beside it.
- **The scene is cleaner than a repository.** No dependency graph, no build, no
  ambiguity of scale. The measured skill transfers; the difficulty does not.
- **A trace is the adapter's to write.** Loop counting needs `trace.jsonl`, and a
  silent adapter reports "unavailable" instead of zero, which keeps a missing
  measurement from reading as a good one.
