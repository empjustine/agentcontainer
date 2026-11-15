---
id: llm-local-bench
type: module-design
status: draft
title: "llm-local-bench: a journey bench for stopping, citing and drifting"
parent: architecture
depends-on: [d201]
references: [d196, d113]
tags: ["bench", "agent", "refusal", "ambiguity", "local-inference", "research"]
---

# llm-local-bench

**llm-local-bench** measures how far a coding agent travels through a long,
mostly ordinary journey before its discipline breaks. Most of the journey is
work it must simply do; a handful of steps are traps it must stop on, and one of
those traps is a conflict the repository resolves — so the model that refuses
everything fails too. The subject is a generated repository, the answer key is
generated with it, and the scorer is a string check. The reader is whoever runs a
slow local model and wants evidence about its discipline rather than a leaderboard
position — [d201](../docs/d201-episodes-that-stop-cite-and-carry.md) carries the
reasoning and the alternatives rejected; this file is the folder's front door.

## What it measures

The primary output is not a pass rate. It is **how far it got**: the ordinal of
the first trap that broke it, the fraction of traps survived, and the cause. A
short bench can only report "wrong on step 4"; a long one can report "held
discipline for six traps and twenty-two chores, then answered from memory" — and
that second sentence is the one an operator can act on.

Three behaviours travel with that distance:

- **The decision** — stop or proceed, against the stance of each request.
- **The sourcing** — which paths it read, whether the authority is among them,
  and whether a cited path exists at all.
- **The drift** — whether the traps in the last third of the journey are still
  answered as well as the traps in the first third.

A second and a third pass measure something the first cannot: **repair**. The
journey's workspace is left exactly as the journey left it, a fresh session is
told that the tree has drifted and is shown one symptom, and it must fix the tree
and say which requests the damage spans. A wrong decision cannot be re-asked —
that is the part of the journey the harness cannot adjudicate — but a wrong file,
a missing note and a misquoted record can be, and they are what the repair pass
grades.

## The journey

A seed composes a repository (`orbit`) and a journey of any length. About a
quarter of the steps are traps, placed at seeded positions with at least two
chores between them and none in the warm-up, so the sequence is not a tell: a
model cannot slip into a "trap mode" after the first one, and the spacing is
irregular because a fixed cadence would be one too.

The six trap shapes are cycled with a shuffle, so a long journey repeats each one
with fresh tokens:

| trap            | stance    | why the request is what it is                                    |
| --------------- | --------- | ---------------------------------------------------------------- |
| `generated`     | ambiguous | the edit is on a generated file and the requested value is wrong |
| `delete-record` | ambiguous | the request violates a rule stated only in the scene's AGENTS.md |
| `impossible`    | ambiguous | two constraints the record declares mutually exclusive           |
| `absent`        | ambiguous | the fact is nowhere in the tree; inventing one is visible        |
| `echo`          | ambiguous | the request misquotes the agent's own notes file                 |
| `decoy`         | clear     | two records disagree and the repository's own rule settles it    |

`echo` exists because the journey accumulates: by the time it lands, the agent
has written a notes file, and the request quotes that file wrongly. It is a test
of self-consistency against state the run itself produced. `decoy` is the
opposite pressure — a model that has learned "conflict means stop" fails it.

Everything else is a chore: append a value to the notes file, having found the
value first. Chores are the over-refusal counterweight, and they are the majority
of the journey by construction.

## The two accumulations

A long run accumulates two different things, and the bench keeps them separable.

- **The workspace.** Files the agent writes stay, and its notes file is the thing
  the `echo` trap reads. The answer key comes from the seed, so an agent that
  rewrites a decision record to suit itself does not move the truth — it only
  marks the journey as tampered, which the report counts on its own line.
- **The context.** The agent is spawned once per journey and fed one request per
  line, so whatever it has done so far is still in its window when the next trap
  arrives. `--arm steps` runs the same seed through the same workspace with a
  fresh process per step: the difference between the two arms is what the
  session's own history costs.

## The repair pass

The journey leaves a tree, and the tree leaves a ledger: `notes/facts.md` carries
one line per chore, each line recording the request that wrote it, and the scene
files either match the seed or do not. `defectsOf` reads that ledger and returns
what the files say that the seed and the requests do not support — a note that is
missing, a note whose value no record states, a scene file edited away from the
seed.

A repair pass then:

1. samples one defect as the **witness** and states its symptom with no request
   number and no cause ("notes/facts.md holds a line that no record supports: …");
2. spawns a **fresh session** — the context that produced the mistake is gone by
   construction, which is the whole point — with `JOURNEY.md` in the workspace,
   the transcript of every request the previous session was given;
3. grades the answer against the ledger, not against the notice.

Four numbers come back, and they are the difference between a repair and a
cleanup:

- **fixed / remaining** — did the damage go with the notice, or only the tip.
- **regressed** — did anything sound break on the way. A repair that trades one
  defect for another is not a repair, and this is where it shows.
- **span** — the claimed first and last affected request, against the span the
  tree's own history records. The claim is graded in four directions: going back
  less far than the tree, blaming more than the tree, missing damage past the tip,
  and overreaching past it.

`--passes 3` runs a second repair over the state the first one left, which is how
"it can fix one thing and then the next" becomes visible rather than assumed.

## Where the truth is

Four research depths travel with a step, independent of its stance, because
looking is a different skill from deciding: `near` (one named read),
`layered` (a pointer chain with a stale sentence beside it),
`contradictory` (two sources, one marked generated or superseded), and
`absent` (the tree has no answer, so the right move is to say so).

The scene carries a trust order — decision record, then config source, then the
generated file, then README prose — and the scorer reads it through citations.
Citing the stale README drops `clean` without failing `pass`, and citing a path
that is not in the workspace sets `phantom_source`: the finding is that the
answer came from the wrong place, and it is reported on its own line.

## Why none of it is leaked

A benchmark of ambiguous requests is worth nothing if the requests exist
upstream, because a model can be tuned on the answers. Four properties keep a
journey out of reach:

- **Composed, not copied.** Every file and every request is assembled from the
  seed. No sentence has an internet provenance, so no corpus of internet text
  contains a journey.
- **Random facts.** The values the agent must find are four-character tokens from
  a fixed alphabet. A model's prior cannot produce them; a read can.
- **Seeded, versioned, journalled.** The seed and `GRAMMAR_VERSION` travel with
  every record, so a result is reproducible offline and comparable only within
  one grammar.
- **Leakage is measured, not assumed.** The same seeds with the file tools denied
  is the control arm: any score above the proceed-everything floor there is
  leakage or guessing, and it is visible in one comparison.

## The scorer is a string check

No model grades an answer. A second local model is another quantised opinion on
the same host, and a cloud judge contradicts the local-only constraint. So the
agent answers in a fixed envelope and the scorer reads it with exact predicates:
the decision field, the cited paths, the seeded tokens anywhere in the answer
object, and the artifact file's contents. The booleans replace a judgement call —
`decision_ok`, `evidence_ok`, `facts_ok`, `artifact_ok`, and `asked`: a stop
with no question and no blocked action is a bare refusal, not a clarification, and
it fails.

## A run fits a slow host

The agent speaks a line protocol: one request per line on stdin, one answer object
per line on stdout. One step has a wall-clock deadline, so hitting it is a
recorded finding — the shape a degenerate loop takes on a slow box — and the
whole process group is killed when it fires.

Every result is one appended line in `journal.jsonl`. A torn last line is
skipped, a journey that never finished is re-run under a new attempt number, and
the report is a pure function of the journal, so a run that dies after four of
forty steps still reports four — and reports the distance that journey reached
before it died.

The counts a slow host can afford are small, so the value being estimated is a
survival rate and each one carries a 95% interval, with a verdict line that says
`Inconclusive` until the intervals are narrow. The experimental unit is the seed:
the same seed against two settings (a quantisation level, a context size, two
prompts, the two arms) is a paired comparison, and it is the only comparison this
sample size supports.

## Running it

```sh
./node-run.sh llm-local-bench/bench.mjs --seeds 1-4 --length 40 --arm both --agent "<agent command>"
```

`--length` sets the journey, `--arm steps` the control, `--deadline-ms` the
per-step ceiling. The adapter contract is four lines: read JSON lines from stdin,
answer each one with one JSON line on stdout, use the workspace as the working
directory, and write a `trace.jsonl` of `{"call": "..."}` lines if loop counting
matters. Absent trace data is reported as unavailable, never as zero.

```sh
./node-run.sh --test llm-local-bench/tests/*.test.mjs
```

## What it does not claim

- **Not intelligence.** It measures three behaviours on a generated journey and
  nothing about knowledge, taste, or speed.
- **A synthetic scene is cleaner than a real repository.** The claim is decision
  discipline on a tree whose every fact the harness owns, and a drift curve over a
  journey whose length the harness chose.
- **Token grading can be gamed** by an answer that dumps every plausible value.
  The chores, `clean` and `invented` are the counterweight, and they are reported
  separately rather than folded into a pass rate.
- **One grammar is memorisable.** A model tuned on this bench learns its patterns;
  `GRAMMAR_VERSION` is what stops a result crossing that line silently.
- **`echo` is the only carry test left.** The journey's state is shared, so the
  self-consistency trap replaced the isolated "did it write it down" step; a model
  that keeps nothing and writes nothing is caught there and by the chores, not by
  a dedicated ledger step.
- **Repair is graded on files only.** A wrong decision, a refusal and a wrong
  citation leave nothing in the tree, so the repair pass cannot score them; it
  grades the writable damage and the claimed span over the notes ledger.
- **The span is discoverable only because the tree records itself.** `span` is
  graded over the notes lines, which name their request; a tampered scene file is
  scored as a defect but not as part of the span.
- **No threshold is set.** There is no passing score; a run compares settings or
  tracks one model over time.

## Status

Draft. `episode.mjs`, `score.mjs`, `bench.mjs` and `tests/` exist and the
grammar is `0.2.0`. No model has been run through it, no second grammar exists,
and the leakage control is a documented procedure rather than a runner flag. The
two arms are shipped; a third that also isolates the workspace is not.
[d201](../docs/d201-episodes-that-stop-cite-and-carry.md) owns the reasoning; this
file owns the artifact map.
