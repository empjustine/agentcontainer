---
id: d124
type: module-design
status: active
title: "d124 — a ThinkRail session cannot spawn or steer sibling sessions; subagents inherit its checkout"
parent: coding-agent
depends-on: [d054]
references: [d116, d117]
tags: [coding-agent, thinkrail, pi, sessions, subagents, worktrees]
---

# d124 — ThinkRail session and subagent boundaries

## Question

Can a running session start its own worktree sessions or subagents, and can it
supervise sessions already in progress elsewhere? Recorded because the answer
decides how parallel work is planned here: an agent that assumes it can spawn
or join a sibling session writes plans that cannot execute, and one that
assumes it cannot misses the observation surface it actually has.

## Findings

Verified 2026-11-02 against ThinkRail 0.3.0 / pi 1.4.0 on this workstation,
from inside a live session — not read off documentation.

### Delegation exists, isolation does not

The session's one delegation primitive is pi's builtin `Agent` tool (subagent
types `scout`, `planner`, `worker`, `reviewer`). Each subagent gets its own
context window, but **the same working directory and the same git checkout as
its parent**: a spawned scout reported `pwd` at the parent's path with a real
`.git` directory, not a linked worktree. There is no `worktree` parameter, no
per-subagent cwd, and no nesting — a `worker`'s tool set is read/bash/edit/write
only, so it cannot delegate further.

Consequence: N parallel subagents from one session are N writers in **one**
tree. Parallel fan-out is safe only with file-disjoint scopes or serialization;
"spawn three workers on three branches" is not a thing this tool does.

### A session cannot create a session

Workspaces — the thing that owns a branch and a worktree — are created by the
operator in the ThinkRail UI. The session's tool surface carries no workspace
or session verb at all: nothing lists, spawns, messages, cancels, or awaits
another session. This pi build's `settings.json` installs no packages, so no
extension-supplied session tool is being overlooked.

All workspaces live in **one** `thinkrail` process. Observed directly: a single
process id served three workspaces while two sibling sessions appended to their
transcripts concurrently with this one, so concurrency is real and it is
in-process — not one process per workspace that a session could find and talk
to.

### Supervision is filesystem observation, not control

There is no IPC channel between sessions; the only cross-session surface is
shared disk state, and it is enough to *read* a sibling's work and not enough
to *change* it:

- `~/.thinkrail/workspaces.json` — workspace → `branch` → `worktreePath`,
  `baseBranch`, `lastActiveAt`.
- `~/.thinkrail/turns.json` — per-turn `baseTree`/`headTree` plus a per-file
  `status`/`added`/`removed` census, keyed by workspace; written **at settle**,
  so a live turn is absent from it and its transcript is the liveness signal.
- `~/.thinkrail/session-lifecycle.json`, `session-receipts.json`,
  `terminals.json`, `logs/`.
- pi transcripts per workspace under
  `$PI_CODING_AGENT_SESSION_DIR/--<worktree-path-with-slashes-as-dashes>--/*.jsonl`.
- git itself in the sibling's worktree (`git -C <worktreePath> status|log|diff`).

What that buys a supervising session: reading a sibling's transcript and
uncommitted diff, detecting two sessions editing the same files, and pointing
its own `reviewer` subagents at absolute worktree paths (a subagent can read any
path, so cross-worktree review does work). What it does not buy: sending a
message into another session, cancelling its run, or awaiting its completion.
Intervention stays with the operator — switch workspace in the UI, or end the
process.

One trap worth recording: a workspace's worktree can be re-pointed to a
different branch between turns (observed within a single session's lifetime).
Any cached path→branch mapping — in a plan, a TODO note, or a doc — is stale by
nature; read `git worktree list` at the moment of use.

### The shell-level escapes, and what they cost

Two workarounds exist and neither is a ThinkRail feature:

- `git worktree add` through bash, then hand the absolute path to a `worker`
  subagent to `cd` into. This is genuine worktree isolation, but by convention
  only: the subagent's transcript still belongs to the parent session, so
  ThinkRail's per-workspace turn tracking never sees the work.
- A separate headless `pi -p` process (pi 1.4.0 supports `-p`, `--session`,
  `--fork`, `--session-dir`). Not a ThinkRail workspace: invisible to the app,
  unmanaged by it, reading `~/.pi/agent` provider config directly, and
  controllable only at process level (start, tail, kill). A nested harness is
  also outside what the container runner is set up to supervise.

## Consequences for how work is planned here

- A session plans **within** its own workspace. Work that needs a second branch
  is a second workspace, created by the operator.
- Cross-session review is a legitimate supervising role and the one this repo
  actually uses: read the sibling worktrees, diff their trees, flag overlap,
  report. Do not promise coordination the tool surface cannot deliver.
- Parallel subagents in one session share one checkout — plan file-disjoint
  scopes, or run them in sequence.

## Verification status

Findings are behavioural observations of this ThinkRail/pi build, taken with
the session's own tools (`pwd`, `git worktree list`, `ps`, the state files
above) rather than from upstream documentation. Nothing in this repo changes
with this record; the persistence facts it leans on stay d054's, and the
harness-tier policy stays d116's.
