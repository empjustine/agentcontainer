---
id: d183
type: module-design
status: draft
title: "d183 — capturing ThinkRail and delegated loops: three roots, not one"
parent: datalakehouse
depends-on: [d182]
references: [d124, d167, d180, d181, d182, d184]
tags:
  [
    "datalakehouse",
    "sessions",
    "thinkrail",
    "subagents",
    "delegation",
    "worktrees",
    "pi-coding-agent",
    "capture",
  ]
---

# d183 — capturing ThinkRail and delegated loops

This record verifies whether ThinkRail sessions, its subagent delegation, and its
git-worktree agent loops are capturable, and where each one's bytes live. It
covers the three roots, what is reachable and what is not, and it is not a reader.
The reader is whoever writes the session reader. What it finds: capture is
possible, but the data sits under three roots, and the delegation root is not the
session directory.

## Status

Draft; read from `JetBrains/thinkrail` `924783f31` (2026-11-10), its
`packages/pi-delegation/` package, and d124's live findings against ThinkRail
0.3.0 and pi 1.4.0.

## The three roots

- **Worktree and workspace sessions.** pi JSONL under
  `$PI_CODING_AGENT_SESSION_DIR/--<worktree-path-with-slashes-as-dashes>--/<timestamp>_<session-id>.jsonl`,
  one cwd-derived folder per workspace (d124, and the server history module's
  layout note). The staged session dir holds all of them, so the pi reader of
  d167 covers them — provided it walks every cwd folder, not only the parent's.
- **Subagent and resource transcripts.** `pi-delegation` stores them under the
  **agent dir**, not the session dir: `getAgentDir()/delegation/<scope>/<parentSessionId>/<timestamp>_<childSessionId>.jsonl`,
  and resource children at
  `<delegationRoot>/<scope>/.resources/<resourceId>/<pi-file>.jsonl`, with the scope
  defaulting to `default` (`packages/pi-delegation/src/storage.ts`). They are
  pi-format JSONL, so one parser reads both transcript roots; the delegation root
  is `~/.pi/agent/delegation`.
- **ThinkRail's own documents.** `workspaces.json` (workspace to branch to
  `worktreePath`, `baseBranch`, `lastActiveAt`), `turns.json` (per-turn
  `baseTree` and `headTree` plus a per-file census, keyed by workspace),
  `session-lifecycle.json`, `session-receipts.json`, `terminals.json` and `logs/`,
  under the ThinkRail data dir. These are whole-document rewrites of management
  state, so a reader upserts them by file (d167); whether they belong in the
  warehouse at all is [What carries the payload](#what-carries-the-payload).

## What is capturable, and how

- ThinkRail runs pi in-process (d124), so its transcripts are pi's JSONL.
  Capturing ThinkRail's session content is capturing pi's files from two roots:
  the session dir and the agent dir's `delegation/`.
- Worktree loops are ordinary sessions. The workspace-to-worktree mapping is
  `workspaces.json`, so a reader attributes a cwd folder to a workspace and a
  branch without guessing.
- Subagents are hidden, non-interactive children with their own context window;
  they share the parent's cwd and checkout (d124) and write their own JSONL under
  the delegation root. They are separate files, capturable, and absent from the
  staged session dir.
- Resource children, the DAG consumer's variant, use the `.resources/<resourceId>/`
  layout under the same root.

## What is not

- **Live content from `turns.json`.** It is written at settle, so a running turn
  is absent and its transcript is the liveness signal (d124). A poll sees a turn
  only after it settles.
- **A push from ThinkRail.** A session cannot create or steer another; there is
  no cross-session IPC and the capture surface is shared disk (d124). The reader
  reads files; it cannot ask ThinkRail for an event.
- **A per-run delegation root.** It lives under the permanently mounted agent dir
  (d054), so it accumulates across runs and the sandbox can write it. That is a
  capture win and a tamper liability: d182's placement caveat applies with more
  force here, because the delegation root is a stable, agent-writable path.

## What carries the payload

The three roots do not carry equal value, and the difference decides what the
warehouse keeps.

- **The pi JSONL is the payload.** It is the inference log: the messages sent
  and received, the tool calls and their results, usage, model changes, thinking
  and compaction. It is self-describing — the header carries `cwd` and the session
  id, a forked header carries `parentSession`, and `session_info` carries the name
  — so the transcript already answers where, which and whose without a second
  source.
- **ThinkRail's documents are management state.** `workspaces.json` maps a
  workspace to a branch and a worktree path, `turns.json` is a per-turn tree
  census written at settle, and `session-lifecycle.json`, `session-receipts.json`,
  `terminals.json` and `chats.json` are lifecycle, receipt and UI state. Most of
  it is derivable — the worktree from the transcript's `cwd`, the branch from
  git, the name from `session_info` — and what is not, a rename or a
  `lastActiveAt`, is ephemeral by nature.
- **Whole-document rewrites churn.** A document rewritten at every settle would
  append a version at every settle in an append-only archive (d180), so the
  management state would generate the most versions for the least payload. That
  is the just-in-case data d173's Datensparsamkeit argues against.

The verdict, and the decision this record carries: **store no ThinkRail-specific
field**. The warehouse's only ThinkRail-origin payload is the pi JSONL from the
two transcript roots; the documents are neither appended nor snapshotted. The
postmortem sweep that recovers their sessions without them is
[d184](d184-postmortem-session-sweep.md).

## Consequences

- The session reader needs **three roots and one parser**: the staged session dir
  (worktree folders included), the agent dir's delegation root, and the ThinkRail
  data dir. One pi JSONL parser reads both transcript roots.
- The `store` column of d167's pi rows distinguishes staged, worktree and
  delegation rows; this record fixes where each root is, so a Worktree row and a
  Delegation row are not confused with a parent session.
- ThinkRail needs no content reader of its own; only its metadata documents need
  a document reader.
- Delegation transcripts are protected by whatever protects the agent dir, which
  is d181's route or d026's diode, not by their location.

## Alternatives rejected

- **Read only the staged session dir.** It misses every subagent and resource
  transcript, which live under the agent dir.
- **Read only the agent dir.** It misses worktree sessions in the staged session
  dir.
- **Treat ThinkRail as a separate format.** Its transcripts are pi JSONL; only
  its metadata documents are its own.
