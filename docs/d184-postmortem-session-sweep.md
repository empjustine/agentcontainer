---
id: d184
type: module-design
status: draft
title: "d184 — postmortem session sweep: orphaned worktrees and agent sessions"
parent: datalakehouse
depends-on: [d183]
references: [d167, d180, d181, d182, d183]
tags:
  [
    "datalakehouse",
    "sessions",
    "capture",
    "postmortem",
    "worktrees",
    "delegation",
    "sweep",
    "orphans",
  ]
---

# d184 — postmortem session sweep

This record adds a filesystem sweep, run from both the host and inside a
sandbox, that captures the sessions the live path missed: orphaned git-worktree
sessions and agent sessions. It covers the roots, the orphan test and the two
appenders, and it is not the live route. The reader is whoever writes the
appender. What it decides: the sweep is the fallback for missed emissions, and
the warehouse stores no ThinkRail-specific field.

## Status

Draft; nothing implemented.

## Why a postmortem sweep

The live route of [d181](d181-session-ingest-route.md) captures what an emitter
sends. It misses three cases: a route that was down when the session ran, a
harness that never had an emitter ([d182](d182-harness-emitter-surfaces.md)), and
events a compromised agent withheld — the emission non-goal both d181 and d026
state. Sessions are files, so a sweep finds what the live path did not, after the
fact.

## The roots to search

The sweep walks the roots of [d183](d183-thinkrail-and-delegated-loop-capture.md):

- **Worktree and workspace sessions** — `$PI_CODING_AGENT_SESSION_DIR/--<cwd-with-slashes-as-dashes>--/*.jsonl`.
- **Agent (subagent) sessions** — `<agentDir>/delegation/<scope>/<parentSessionId>/*.jsonl`.
- **Resource children** — `<agentDir>/delegation/<scope>/.resources/<resourceId>/*.jsonl`.

## The orphan test

- **Orphaned worktree.** Decode the cwd from the folder name, or read the
  transcript header's `cwd`, then test whether the path still exists and
  whether it is a live git worktree (a `.git` entry, and a match in
  `git worktree list`). A worktree that was pruned, deleted or re-pointed
  leaves its sessions behind; that is exactly the case the postmortem exists for,
  so the session is captured **regardless** of whether the worktree survives. The
  test decides attribution, not capture.
- **Orphaned agent session.** A delegation or resource transcript whose parent
  session is gone, or whose scope has no live owner, is an orphan of the same
  kind: capture it by its own identity.
- **Idempotence.** The natural key of d167 makes a re-sweep a no-op for rows
  already captured, so the sweep can run as often as wanted.

## Both sides

- **Host-side appender.** Runs on the host, enumerates the real paths, and is the
  archive's writer through d180's collector. It is authoritative.
- **Agent-side appender.** The same resolver runs inside the sandbox over the
  mounted roots — the staged session dir and the agent dir — reusing d180's
  dual-environment path resolution. It can only POST to the route (d181), never
  write the archive.
- The two are redundant on purpose: the host side is trustworthy, the agent side
  is opportunistic and can be suppressed. The host sweep is what makes the
  postmortem trustworthy; the agent sweep is what makes it fast when the sandbox
  still has the files.

## No ThinkRail-specific fields

The decision carried from [d183](d183-thinkrail-and-delegated-loop-capture.md):
the warehouse stores **no ThinkRail-specific field**. The worktree, the branch
and the name are derivable — `cwd` and `parentSession` in the transcript
header, `session_info` for the name, git for the branch — and the orphan sweep
recovers the sessions without them. ThinkRail's documents are not appended and
not snapshotted.

## Consequences

- The sweep closes the route-down gap and the no-emitter gap, and it is where a
  deleted worktree's sessions survive.
- The sweep reads only; it never writes a session store, so it cannot weaken the
  diode property of d180 and d181.
- Cost is a periodic scan of the session and delegation roots, bounded by JSONL
  size and made cheap by the fact that unchanged files are skipped by the natural
  key.
- A session whose cwd is gone is still attributed by the transcript's own header,
  so the postmortem does not depend on ThinkRail's mapping being present.

## Alternatives rejected

- **Live route only.** It misses the withheld, the unemitted and the route-down
  cases by construction.
- **Sweep the session dir only.** It misses every agent session under the agent
  dir's delegation root.
- **Require the worktree to exist.** The orphaned worktree is the case the
  postmortem exists for.
- **Keep a ThinkRail snapshot as a fallback.** The decision is to store none; the
  transcript and git already carry what a query needs.
