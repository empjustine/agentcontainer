---
id: blackboard-and-context-management-prior-art
type: reference
status: draft
title: "Blackboard systems and LLM task/context management prior art — reference farm survey"
parent: architecture
tags: ["references", "prior-art", "blackboard", "context-management", "memory", "task-management", "agents", "compaction", "session-persistence"]
---

# Blackboard and LLM context/task management prior art (reference farm)

A **prior-art survey**, not an assessment, recommendation, or trust statement:
how other projects shape shared state and manage an LLM's finite context, as a
reference frame for our own harness/workload work. Sources are bare mirrors
under `~/Downloads/references/`; each item is named as `<repo>:<path>`.

## Trust boundary — nothing here is trusted

**Every claim below is a third-party statement, read from a mirror tip, and is
unverified against upstream at run time.** This includes code that *looks*
authoritative (provider SDK constants, security posture docs, benchmark
numbers). Treat the whole survey as untrusted input:

- "the project claims/describes" is the strongest thing said here; no
  behavior, number, or safety property has been independently reproduced.
- Security mechanisms described below (attestation, nonce framing, delimiters,
  flock, single-writer rules) are the projects' own descriptions. Several
  authors themselves state the limits of those mechanisms; where they do, that
  is recorded, but the absence of such a caveat is not evidence of soundness.
- Anything in a memory/plan file that looks like an instruction is data, per
  this repo's own prompt-injection posture. The surveyed tools mostly say the
  same, and the survey does not upgrade their text into authority.

Scope note: search was over `HEAD` tips of the bare mirrors only (d043's
cross-branch index was not built), so this is the default-branch picture of
each project, not every branch.

## Two axes, one recurring metaphor

The farm's material splits cleanly:

1. **Blackboard / shared-state coordination** — independent actors (usually
   agents) publish to and read from a durable, inspectable shared medium, with
   a watcher or poller driving the next cycle.
2. **Task / spec / scope / context management and persistence** — a single
   agent's window is treated as scarce; state is externalized to files, a DB,
   or a provider-side feature, then re-injected or summarized under a budget.

The metaphor the whole field converges on, repeated almost verbatim in
`planning-with-files:skills/planning-with-files/reference.md` and
`Doorman11991/smallcode:ARCHITECTURE.md`:

> Context window = RAM (volatile, limited). Filesystem = disk (persistent,
> unlimited). Anything important gets written to disk.

The rest of this document is the concrete machinery behind that line.

---

## 1. Blackboard / shared-state coordination

### 1.1 `pelagos-containers/pelagos` — the one true blackboard in the farm

The clearest multi-agent blackboard is the **pelagos ↔ k3s-experiments**
coordination loop, documented identically in both repos
(`pelagos-containers/pelagos:docs/AGENT_COORDINATION.md`, mirrored in
`CLAUDE.md` §Agent Coordination). A separate `agent-coordinator` git repo holds
`state/` with one JSON file per writer:

| File | Writer | Reader |
|---|---|---|
| `cluster.json` | k3s-agent | pelagos-agent |
| `pelagos.json` | pelagos-agent | k3s-agent |

Design decisions worth recording as prior art:

- **Closed-set signals.** `signals_out.to_pelagos` accepts exactly five values
  (`null`, `new-cluster-bugs`, `retest-failed`, `priority-request`,
  `cluster-bug-fix-confirmed`). The doc explains why: two signals were used
  informally for weeks while the watcher did a single exact-string match, so
  they were silently ignored; the fix is documented values plus a loud warning
  for anything outside the set. *Free-form status strings are a protocol bug
  waiting to happen.*
- **One writer per file, with one documented cross-write exception**
  (pelagos-agent clears `cluster.json.signals_out.to_pelagos` at claim time).
- **All writes go through `bin/write-state.sh`**: `flock` (30 s, fail loud),
  re-read fresh after acquiring the lock, apply a jq filter, validate JSON,
  then commit. The doc records a real lost-update incident from editing +
  committing directly.
- **Watcher mechanics matter.** `inotifywait -e moved_to,close_write` because
  `git commit` writes a temp file and renames it (`close_write` fires on the
  temp path); `flock` on a watch lock prevents overlapping cycles.
- **Deterministic script-owned writes.** The post-cycle board update is done by
  the shell script with a 20-minute retry against `gh release view`, not left
  to the headless agent's self-report, because single-shot `claude -p` can end
  without resuming after a backgrounded wait (issues #507/#509/#510).
- **`watcher_status`** (`active`, `issues`, `signal`, `started_at`,
  `last_cycle_outcome`) exists so "who is working what right now" is one read
  of the board, not a process/worktree hunt.
- **Worktree isolation per cycle** to stop a headless run colliding with an
  interactive checkout.

This is the closest thing in the farm to a worked, incident-hardened
blackboard design; it is also deliberately filesystem-local (no push remote,
shared by path).

### 1.2 `cline/cline` — team task board + mailbox + mission log

`cline/cline:docs/sdk/guides/multi-agent-teams.mdx` describes a coordinator
agent with `team_spawn_teammate` / `team_delegate_task` / `team_check_status` /
`team_get_result`. Team state persists per team:

```
~/.cline/data/teams/[team-name]/
  task-board.json      # tasks and status
  mailbox.json         # inter-agent messages
  mission-log.json     # activity history
```

Resume is by team name (`cline --team-name auth-sprint "Continue ..."`). This
is a blackboard with named, persisted channels rather than a single JSON file.
`cline/kanban` is the adjacent UI: each task card gets its own terminal and
worktree, with dependency chains and auto-commit.

### 1.3 `humanlayer/12-factor-agents` — the blackboard as "what happened so far"

Factor 3 (`humanlayer/12-factor-agents:content/factor-03-own-your-context-window.md`)
frames the whole agent input as a *context window you own*, not a fixed
message array: "here's what's happened so far, what's the next step". It shows
packing the entire event history into a single user message with custom tags
(`<slack_message>`, `<list_git_tags_result>`), i.e. the blackboard can be the
prompt itself when the interaction is short. The repo also names frameworks
(`boundaryml/baml`, LangChain/LangGraph, etc.) as the surrounding ecosystem.

### 1.4 Classical, non-LLM lineage

The farm carries the pre-LLM ancestors of the pattern, useful as a contrast
to the JSON-file blackboards:

- `apache/incubator-kie` (Drools/Kogito): `WorkingMemory`,
  `StatefulKnowledgeSessionImpl`, Rete network, truth maintenance, agenda, and
  `drools-persistence-jpa` session storage
  (`drools-persistence/.../PersistableRunner.java`). This is a *shared fact
  store with inference* and durable session persistence — the "blackboard"
  name's actual origin domain.
- `flowable/flowable-engine`, `temporalio/temporal`: durable workflow/task
  engines; task state survives process death and actors coordinate through the
  engine rather than a file.
- `git.sr.ht/~ymherklotz/emacs-zettelkasten`, `org-zettelkasten`,
  `logseq/logseq`: personal knowledge stores; persistence of linked notes, no
  LLM loop (relevant only as the knowledge-base shape that `pi-knowledge-search`
  later reuses).

---

## 2. Context-window management (budget & compaction)

The common shape: a **budget engine** decides what fits; a **compactor**
summarizes or drops older material; recent turns stay raw.

### 2.1 `Doorman11991/smallcode` (marrow) — budget engine + compactor + scratchpad

`ARCHITECTURE.md` is explicit that every choice compensates for an 8–32k
model. The machinery:

- `marrow/src/context/budget.ms` — `BudgetEngine` tracks four buckets
  (`system_prompt`, `working_memory`, `conversation`, `tool_results`) against
  `model_context_length * max_budget_pct/100`, with a `CHARS_PER_TOKEN = 4`
  approximation and an allocation view.
- `marrow/src/context/compactor.ms` — keeps the last 2 turns intact and
  summarizes earlier turns into a single system message, then updates the
  budget by `freed - summaryTokens`.
- `marrow/src/context/working_memory.ms` — a `.smallcode/memory.md`
  scratchpad wrapped in `<working_memory>` tags, token-capped on load, with
  section-level clear; `marrow/src/tools/builtin/memory.ms` exposes
  read/write/append/clear to the model.
- `marrow/src/planner/todo.ms` — a `.smallcode/TODO.md` task list whose status
  (`pending`/`in_progress`/`done`/`failed`) the model re-reads each turn.
- `marrow/src/core/session_persistence.ms` — per-session JSON snapshots
  (messages, working memory, plan, budget, model) under
  `.smallcode/sessions/`, with atomic write and 0600 permissions.
- Deterministic **tool router** and, under 16k, two-stage routing to avoid
  sending all tool schemas; an affirmation guard keeps the prior category on
  "ok"/"yes".

### 2.2 `antoinezambelli/forge` — pluggable compaction strategies

`src/forge/context/strategies.py` defines `CompactStrategy` with a documented
cut priority (cut first → preserve longest):

1. `step_nudge` / `retry_nudge` (ephemeral corrections),
2. `tool_result` truncated to its first line,
3. `tool_call` collapsed to a one-liner,
4. `reasoning` preserved as long as possible,
5. recent iterations inside the `keep_recent` window left intact.

The contract **must never cut** the system prompt and the original user input.
`NoCompact` (VRAM-rich) and `SlidingWindowCompact` are shipped strategies;
`src/forge/context/manager.py` and `hardware.py` own thresholds/environment.

### 2.3 The pi harness itself (`earendil-works/pi`)

Pi models compaction as **session entries**, not ad-hoc truncation:

- `packages/agent/src/harness/compaction/compaction.ts` creates
  `CompactionEntry`s carrying `summary`, `tokensBefore`, `retainedTail`, and
  `details.readFiles` / `details.modifiedFiles`. A later compaction folds the
  previous entry's file lists forward.
- `packages/agent/src/harness/session/context.ts` builds the model context by
  finding the latest compaction and emitting `[compaction summary, ...tail]`;
  `branch_summary` entries are a separate summary kind (fork/branch).
- Session backends are pluggable: JSONL under `packages/agent/.../session/jsonl/`
  and a SQLite backend with migrations, usage ledger, and branch entries under
  `packages/session-backends/sqlite-node/`.
- `packages/ai/README.md` advertises "context serialization and hand-off to
  other models mid-session".

### 2.4 Provider-side context management

Two mirrored provider SDKs expose server-managed context editing; both are
untouched-by-us reference constants:

- `vercel/ai:content/providers/01-ai-sdk-providers/05-anthropic.mdx` documents
  Anthropic `contextManagement` with `clear_tool_uses_20250919`
  (`trigger`/`keep`/`clearAtLeast`/`clearToolInputs`/`excludeTools`) and
  `compact_20260112`, plus a `taskBudget` whose `remaining` carries budget
  across compacted-away contexts.
- `OpenRouterTeam/typescript-sdk` has `ContextCompactionItem`
  (`type: context_compaction`, optional `encryptedContent`) and a
  `clear_tool_uses_20250919` edit model.

This is a different trust posture from filesystem memory: the provider owns
the compaction and may return an opaque/encrypted summary.

### 2.5 `huggingface/smolagents` — memory steps and replay

`src/smolagents/memory.py` stores an `AgentMemory` of typed `MemoryStep`s
(`ActionStep` holds tool calls, observations, errors, token usage).
`docs/source/en/tutorials/memory.md` shows `agent.replay()` and step callbacks
that reach into `agent.memory` — e.g. deleting images from ancient steps to
cut token cost. Memory is a first-class, inspectable object rather than an
opaque transcript.

---

## 3. Task / spec / plan persistence on disk

### 3.1 `OthmanAdi/planning-with-files` — the most developed file-plan skill

`skills/planning-with-files/SKILL.md` + `reference.md` encode Manus's published
context-engineering lessons as an agent skill and hook set:

- **Three files**: `task_plan.md` (phases), `findings.md` (research),
  `progress.md` (session log). The rules: create the plan first, the
  2-action rule (save findings after two view/search ops), read before decide,
  update after act, log all errors, never repeat failures, continue after
  completion.
- **The 6 Manus principles** (`reference.md`): design around KV-cache
  (stable prefixes, no timestamps, append-only), mask don't remove tools,
  filesystem as external memory, recitation to manipulate attention,
  keep the wrong stuff in, don't get few-shotted.
- **3 strategies**: context reduction (compaction/summarization), context
  isolation (planner + knowledge manager + executor sub-agents), context
  offloading (few tools, full results to disk).
- **5-question reboot test**: where am I / going / goal / learned / done.
- **Hooks**: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
  `PreCompact`; auto-recovery on start; parallel plans pinned by `PLAN_ID` /
  `PWF_PLAN_ROOT`; one plan owner with per-worker ledgers.
- **v3 hardening as an honesty model**: SHA-256 plan attestation, per-session
  nonce framing, delimiter framing, and a structured ledger summary so raw
  `progress.md` free text never enters context in autonomous mode. The doc
  itself states the limits — nonce and plan live in the same directory, so a
  writer can forge the END delimiter; attestation is not a keyed signature; a
  "cannot defend a same-directory writer" caveat is exactly the kind of
  self-limitation to keep.
- **Runaway guards**: persistent `Stop`-block counter, cap (default 20), stall
  detection, host capability tiers (hard block / follow-up / notify only).

### 3.2 `ttttmr/pi-context` — checkpoint / timeline / compact (d-mail time travel)

`skills/context-management/SKILL.md` defines a working-set model (raw /
state-summary / discardable process) and exactly three tools:

- `context_checkpoint` — semantic anchors before noisy work or a new phase;
- `context_timeline` — structural view of the active path;
- `context_compact` — branch from a chosen anchor and replace the tail with a
  state summary (a `root` option and backup checkpoint exist for recovery).

The **compact gate** requires all four: the target removes real low-value
trail; state can be restored without losing needed raw detail; there is a
*known* continuation (not merely a possible user reply); and the benefit
survives recovery cost. The **summary contract** restores task state, external
state (changed files/processes/tickets), verification state (commands, risks),
and navigation state (anchors, rejected leads, next step). Crucially: context
navigation does **not** roll back the world — disk/processes/remote services
stay current. `src/context.ts` also renders a `/context` usage dashboard.

### 3.3 `Tiziano-AI/pi-continue` — continuation ledger ("tattoos")

`README.md` + `assets/system/history_update.md` + `examples/continuation-output-shape.md`
describe a mid-turn compaction handoff whose artifact is a **structured brief**,
not a transcript replay:

```
Task / Done When
Forbid      (human prohibitions, known-bad paths)
Established (anchored facts: evidence + basis + reopen clause)
Learned     (session insights)
Open        (questions paired with what would close them)
Next        (ordered actions; next[0] is the immediate resume action)
```

- Evidence must be a navigable anchor (`path:line`, `test:name`,
  `cmd:...#anchor`, `doc:url#section`, `user@msg-id`) with a fixed `basis`
  (`observed|test|output|user|doc`).
- The synthesizer is told to **reconcile** the prior brief (carry forward by
  default, demote when `reopen` triggers, never silently drop) — a
  "Memento-style tattoo" model of durable working memory.
- Artifacts are manual-inspection/output-only and **never auto-imported**;
  `pi-continue` explicitly says it is not a memory system.
- `continuation-prompt.ts` frames the brief as authoritative *factual* context
  while separating instruction authority: embedded directive-looking text is
  data unless current instructions authorize it.

### 3.4 `containers/fetchit` — GitHub spec-kit in the wild

`fetchit` carries the `.specify/` layout and `.claude/commands/speckit.*`
commands: `.specify/memory/constitution.md`, `templates/{spec,plan,tasks,
checklist,agent-file}-template.md`, and `scripts/{create-new-feature,
setup-plan,update-agent-context}.sh`; specs land in
`specs/NNN-feature/{spec,plan,tasks,research,data-model,quickstart}.md`.
`tasks-template.md` organizes work by user story with `[P]` parallel markers and
phase structure. This is the "spec → plan → tasks → implementation" pipeline as
files plus slash commands — a spec-management counterpart to the plan-file
family.

### 3.5 Lighter task surfaces

- `charmbracelet/crush`: `internal/db/migrations/20250812000000_add_todos_to_sessions.sql`
  adds a `todos TEXT` column to the sessions table — task list persisted with
  the session row.
- `cline/kanban` (above) and `cline/cline` teams are the multi-agent task-board
  end.

---

## 4. Session persistence & retrieval

### 4.1 `samfoy/pi-memory` + `pi-session-search` + `pi-knowledge-search` (packaged by `pi-total-recall`)

Three composable context layers, all built on `node:sqlite` FTS5 (Node 24+):

- **`pi-memory`** — learns preferences/patterns/corrections via end-of-session
  LLM consolidation, injects relevant memory into every session's system
  prompt; complements (does not duplicate) session search.
- **`pi-session-search`** — indexes JSONL session files from
  `~/.pi/agent/sessions/` and `sessions-archive/`; FTS5 keyword search always
  on, optional embeddings; hybrid via reciprocal-rank fusion; injects a short
  recent-session primer at session start.
- **`pi-knowledge-search`** — hybrid vector + BM25 over local markdown/text
  vaults, exposes `knowledge_search` + `kb_read` (`[[wikilink]]` resolution),
  and injects a folder/keyword overview on session start.
- **`pi-total-recall`** is the meta-package wiring all three.

This is the "what you prefer / what you've done / what you know" split, with
the retrieval plumbing (FTS5 + vectors + RRF) reused across layers.

### 4.2 `anomalyco/opencode` — durable session core

`AGENTS.md` §V2 Session Core documents a durable prompt-admission model:
`session_input` rows admitted before execution, process-global
`SessionExecution` keyed by Session ID, Location/workspace-scoped runners, a
"System Context algebra" in `src/system-context`, Session-owned Context Epoch
persistence, and explicit delivery vocabulary (steer vs queue). It is a
DB-durable session store rather than a file scratchpad; crash-continuation
recovery is called out as needing separate design.

### 4.3 Other persistence mentions

- `smallcode` session snapshots and git-checkpoint rollback (`ARCHITECTURE.md`
  §7): every turn opens a checkpoint; writes record pre-edit content; hard-fail
  can auto-rollback the turn.
- `cline/cline` team `mission-log.json` / `mailbox.json` (above).
- `dredozubov/hazmat:docs/plans/2026-06-12-kimi-harness-evaluation.md` names
  `MoonshotAI/kimi-cli` and `MoonshotAI/kimi-code` data roots
  (`~/.kimi`, `~/.kimi-code`) as credential/session stores — the harness state
  that sandbox policy must fence.

---

## 5. Sub-agent, scope, and memory-safety

### 5.1 Scope isolation for sub-agents

- `gotgenes/pi-packages:packages/pi-subagents/README.md` — in-process
  sub-agents, each with its own tools/system prompt/model/thinking level and an
  isolated session; **optional context inheritance** (fork parent
  conversation); foreground/background, mid-run steering, session resume,
  `ask_parent` and `notify_parent`; lifecycle events including `compacted`.
- `kstenerud/yoloai:docs/contributors/design/multi-agent.md` — role-scoped
  agents via mount composition (`tests/:rw`, `src/` untouched, reviewer
  read-only), with the `/copy` + diff/apply review gate as the enforcement
  mechanism; cross-visibility is an early sketch and is honestly labeled as
  needing more design. Note the boundary is *prompt-based* scoping plus
  after-the-fact diff review, not a kernel boundary (consistent with
  d020/workload-sandboxing-prior-art.md).

### 5.2 Memory safety / poisoning

Persistence is also an attack surface, and the farm carries explicit warnings:

- `NVIDIA/SkillSpector:src/skillspector/nodes/analyzers/static_patterns_memory_poisoning.py`
  has static patterns for memory poisoning in agent skills.
- `OWASP/CheatSheetSeries:cheatsheets/AI_Agent_Security_Cheat_Sheet.md`
  covers agent memory/context risks.
- `apache/maka:docs/archive/maka-memory-whitebox-contract.md` is a useful
  *default-off* contract: a local transparent memory file has two switches —
  `enabled` (file on disk) and `agentReadEnabled` (agent may consume it in the
  system prompt, **default OFF**), 128 KB cap, 0700/0600, fail-open parse,
  Markdown H2 entries with HTML-comment metadata.
- `planning-with-files` (above) is the most explicit on the limits of
  attestation/nonce/delimiters against a same-directory writer.

---

## 6. Cross-cutting lessons (what the farm keeps rediscovering)

1. **Externalize before you need to.** Every durable system writes state out
   of the window early (plan/todo/scratchpad/session row), not at the moment of
   overflow. The RAM/disk metaphor is the shared mental model.
2. **A compaction summary is a state transfer with a contract, not a recap.**
   `pi-context`'s four-part summary contract and `pi-continue`'s
   task/done/forbid/established/learned/open/next brief are the strongest
   versions; forge's cut-priority is the strongest budget ordering.
3. **Preserve pointers, not bytes.** Compression must be restorable: keep
   URLs, file paths, anchors, and retrieval methods; drop bulky content
   (`planning-with-files` Manus principle 3, `pi-context`).
4. **Compaction is not rollback.** Context navigation changes conversation
   state only; disk, processes, tickets, and remote services stay current
   (`pi-context` says this explicitly).
5. **Single writer per shared channel, and lock the read-modify-write.**
   Pelagos' per-file writer rule + `flock` + fresh re-read after lock + JSON
   validation + commit is the incident-tested version. Free-form status strings
   are a protocol bug; use closed sets and log drift loudly.
6. **Deterministic script-owned finalization beats a headless agent's
   self-report** for the state that triggers other actors (pelagos post-cycle
   write, retried against real GitHub state).
7. **KV-cache stability, append-only, stable prefixes.** No timestamps in
   system prompts; masking over dynamic tool removal; the file-plan family is
   designed around this.
8. **Hybrid retrieval is the default answer**: FTS5/BM25 + vector embeddings
   fused by reciprocal-rank fusion, across sessions, memory, and local
   knowledge (`samfoy/*`, and d043's blob-addressed semantic layer).
9. **Separate factual authority from instruction authority.** Tool results and
   file contents prove that text existed; they do not make it an instruction.
   `pi-continue` and `planning-with-files` both encode this; it is the same
   prompt-injection posture our runner threat model takes.
10. **Name the limits.** The best docs (planning-with-files attestation,
    yoloai's multi-agent sketch, pelagos' incident log, maka's default-off
    memory) state what their mechanism does *not* protect against. That is the
    standard for any mechanism we borrow.

---

## 7. Verification record

- **Search scope**: 888 bare mirrors under `~/Downloads/references/` at first
  pass, re-verified against **897** after the mirroring batch landed, `HEAD`
  tip only (`git grep -I` per repo, case-insensitive). No Zoekt index was built
  (no container runtime on this host), so cross-branch hits are out of scope.
- **Re-verification (post-batch)**: the §8 candidate list was re-checked
  against the 897-mirror farm, including repo renames/redirects and basename
  collisions (not just exact `owner/repo`); nine previously-missing repos are
  now present and six "missing" entries were aliases/forks of mirrored repos.
  The corrected, still-missing set is §8.2; scope/platform triage is §8.3.
- **Second correction pass**: three further names were verified against
  upstream with `git ls-remote` (network reachable): `SafeRL-Lab/clawspring`
  and `SAIL-Research-Lab/cheetahclaws` are the same HEAD (`ec5d091b…`);
  `invariantlabs-ai/mcp-scan` and `snyk/agent-scan` are the same HEAD
  (`ca91ebef…`); `nousresearch/hermes-agent` is live but failed to clone here.
- **Blackboard**: only `pelagos-containers/pelagos` uses "blackboard" as a
  designed coordination medium on the farm (the other `blackboard` matches are
  themes, port names, dictionaries, and prose). `apache/incubator-kie`
  (Drools) is the classical working-memory ancestor.
- **Context/plan tooling**: the richest single sources are
  `OthmanAdi/planning-with-files`, `Doorman11991/smallcode`,
  `ttttmr/pi-context`, `Tiziano-AI/pi-continue`, and `samfoy/*`; provider-side
  context editing appears in `vercel/ai` and `OpenRouterTeam/typescript-sdk`.
- **Counts of files matching the survey terms** (repo-labeled): see the
  per-term `git grep` passes; representative hits are cited inline, not
  exhaustively listed.
- **Not yet read in depth**: `mozilla-ai/cq`/`otari` (agent gateway with scoped
  budgets and `routing_memory.py`), `getkern/kern`, `statewright/statewright`
  (state-machine pipeline + `candidate_context.rs`), `apache/maka`
  (local-memory and context-window UI), `deepseek-ai/deepseek-harness`. They
  are cataloged here as leads, not summarized.

---

## 8. Mirror-batch status (re-verified against 897 mirrors)

Section first drafted against 888 mirrors. Nine candidates were then mirrored
(the batch this survey prompted) and six were aliases/forks that should never
have been raised. Both lists are recorded here so the next sweep does not
re-raise them.

### 8.1 Resolved — do NOT re-raise

**Aliases / forks of a mirrored repo:**

| Raised as | Actually is |
|---|---|
| `sst/opencode`, `opencode-ai/opencode` | `anomalyco/opencode` (mirrored) |
| `badlogic/pi-mono`, `earendil-works/pi-mono` | `earendil-works/pi` (mirrored; canonical origin) |
| `maka-agent/maka-agent` | pre-Apache upstream of `apache/maka` (mirrored) |
| `mebassett/smallcode` | fork of `Doorman11991/smallcode` (mirrored) |
| `svkozak/pi-acp` | `georgeharker/pi-acp` / `victor-software-house/pi-acp` (both mirrored) |
| `gotgenes/pi-subagents` | package inside `gotgenes/pi-packages` (mirrored) |
| `googlecloudplatform/gemini-cli` | `google-gemini/gemini-cli` (same project; old org) |

**Excluded on purpose:** `anthropics/claude-code` — proprietary; the repo is
an issue/docs surface, not source. Referenced behavior is documented well
enough via the harnesses that mirror it (`anthropics/skills` is separately
mirrored).

**Now mirrored in the batch** (verified non-empty, ref counts at sweep time):

| Repository | refs |
|---|---|
| `openai/codex` | 22,571 |
| `openhands/openhands` | 13,863 |
| `continuedev/continue` | 7,563 |
| `boundaryml/baml` | 5,630 |
| `modelcontextprotocol/servers` | 3,982 |
| `moonshotai/kimi-code` | 3,241 |
| `anthropics/skills` | 2,257 |
| `agentclientprotocol/agent-client-protocol` | 2,163 |
| `moonshotai/kimi-cli` | 1,859 |

### 8.2 Still missing — on-topic (corrected)

Un-mirrored repos named by the surveyed sources that are **on-topic** and not
covered by an alias/fork above. Fetch with `git/-forge-mirror.sh <url>` (d043)
then re-run the matching survey section.

**Agent harnesses / context management**

| Repository | Why it matters | Cited by |
|---|---|---|
| `swe-agent/swe-agent` | Full SWE-agent loop; only `SWE-agent/mini-swe-agent` is mirrored | `yoloai:.../research/agents.md` |
| `aider-ai/aider` | Repo-map context construction + history files | `yoloai`, `hazmat` |
| `google-gemini/gemini-cli` | Gemini CLI context/session surfaces (canonical org) | `yoloai`, `apache/maka`, `hazmat` |
| `nousresearch/hermes-agent` | Agent referenced as comparison/alternative | `planning-with-files`, `apache/maka`, `hazmat` |
| `openclaw/openclaw` | Agent harness evaluated by hazmat | `hazmat:...openclaw-harness-evaluation.md` |
| `openai/openai-agents-js` | Agent framework (message/history management) | `apache/maka` (third-party notices) |
| `pydantic/pydantic-ai` | Agent framework with message-history management | `hazmat:docs/integrations.md` |
| `microsoft/autogen` | Multi-agent conversation framework | `huggingface/smolagents` |
| `langchain-ai/langchain` | Memory/retriever modules the field builds on | `getkern/kern:bindings/python/LANGCHAIN-SHELL.md` |
| `mozilla-ai/any-llm` | Provider-abstraction layer | `mozilla-ai/cq` ecosystem |
| `got-agents/agents` | Agent framework named by 12-factor | `humanlayer/12-factor-agents:README.md` |
| `dexhorthy/mailcrew` | Humanlayer's agent-mailbox example | `humanlayer/12-factor-agents:README.md` |

**Context / plan / memory tooling**

| Repository | Why it matters | Cited by |
|---|---|---|
| `badlogic/cchistory` | Claude Code history extraction (session persistence) | `earendil-works/pi:packages/ai/src/api/anthropic-messages.ts` |
| `tintinweb/pi-subagents` | Upstream of `gotgenes/pi-subagents` | `gotgenes/pi-packages:.pi/skills/package-pi-subagents/SKILL.md` |
| `nicobailon/pi-subagents` | Alternative pi sub-agent fork | `gotgenes/pi-packages` |
| `hazat/pi-interactive-subagents` | pi interactive sub-agents | `earendil-works/pi`, `gotgenes/pi-packages` |
| `elidickinson/pi-claude-bridge` | pi ↔ Claude bridge | `gotgenes/pi-packages` |
| `earendil-works/pi-chat` | pi chat surface | `earendil-works/pi:README.md` |
| `doorman11991/marrowscript` | The language behind smallcode's memory/context modules | `Doorman11991/smallcode:README.md` |
| `doorman11991/bonescript` | Sibling language/runtime | `Doorman11991/smallcode:README.md` |
| `doorman11991/budget-aware-mcp` | Budget-aware MCP — context budgeting as a protocol concern | `Doorman11991/smallcode:README.md` |
| `kmichels/multi-manus-planning` | Parallel-Manus planning variant | `OthmanAdi/planning-with-files:CONTRIBUTORS.md` |
| `lincolnwan/planning-with-files-copilot-agent` | planning-with-files port | `OthmanAdi/planning-with-files:README.md` |
| `taoidle/plan-cascade` | Cascaded planning | `OthmanAdi/planning-with-files:README.md` |
| `Ataraxy-Labs/inspect` | Semantic code review from the `sem`/`weave` stack | `Ataraxy-Labs/sem`, `Ataraxy-Labs/weave` |
| `Ataraxy-Labs/opensessions` | tmux sidebar for coding agents (session visibility) | `Ataraxy-Labs/sem`, `Ataraxy-Labs/weave` |
| `arize-ai/phoenix` | LLM tracing/inspection (observing agent memory/runs) | `huggingface/smolagents:docs/.../inspect_runs.md` |
| `brexhq/prompt-engineering` | Prompt/context engineering reference | `humanlayer/12-factor-agents` |
| `tursodatabase/agentfs` | Agent filesystem — durable agent state | `swival/swival:swival/sandbox_agentfs.py` |
| `SAIL-Research-Lab/cheetahclaws` | Original Python agent substrate behind `little-coder` (memory/checkpoint/sub-agent design). Old name `SafeRL-Lab/clawspring` redirects to the same HEAD (`ec5d091b…`, verified via `git ls-remote`) | `itayinbarr/little-coder:NOTICE` (links `SafeRL-Lab/clawspring`) |
| `co-l/cache-hunter` | Cache/KV tooling referenced alongside compaction | `itayinbarr/little-coder:CHANGELOG.md` |

**Skill / spec / protocol ecosystem (context and tool exchange)**

| Repository | Why it matters | Cited by |
|---|---|---|
| `agentskills/agentskills` | Agent-skills packaging spec | `vercel/ai` |
| `modelcontextprotocol/modelcontextprotocol` | The MCP spec repo itself (only the TS SDK is mirrored) | `modelcontextprotocol` ecosystem |
| `modelcontextprotocol/registry` | MCP server registry | `Ataraxy-Labs/sem` |
| `modelcontextprotocol/go-sdk`, `modelcontextprotocol/sdk-go`, `modelcontextprotocol/ext-auth`, `modelcontextprotocol/conformance` | MCP SDKs/conformance (Go side, auth, tests) | MCP ecosystem |
| `agentclientprotocol/typescript-sdk` | ACP TypeScript SDK | `vercel/ai`, `hazmat` |
| `mark3labs/mcp-go` | Widely used MCP Go SDK | `mozilla-ai/cq` |
| `nvidia/skills`, `trailofbits/skills`, `skillmatic-ai/awesome-agent-skills`, `buzhangsan/skill-manager` | Skill packaging/management ecosystem | `NVIDIA/SkillSpector`, `Anbeeld/PROMPTING.md` |
| `cline/plugins` | Cline plugin surface | `cline/cline` |
| `deepseek-ai/awesome-deepseek-agent` | Agent-harness index | `deepseek-ai/deepseek-harness` |
| `chromedevtools/chrome-devtools-mcp` | Browser context as an MCP tool | MCP ecosystem |
| `datasette/datasette-agent-charts`, `datasette/datasette-agent-openai-imagegen` | datasette-agent plugin surfaces | `datasette/datasette-agent` |

### 8.3 Scope triage (harness / platform specificity)

Not every remaining candidate is a runtime dependency for this Linux/podman
harness; classify before spending a mirror slot.

- **Cross-platform, idea-rich (normal priority):** `swe-agent/swe-agent`,
  `aider-ai/aider`, `google-gemini/gemini-cli`, `openai/openai-agents-js`,
  `pydantic/pydantic-ai`, `microsoft/autogen`, `langchain-ai/langchain`,
  `mozilla-ai/any-llm`, `openclaw/openclaw`, `got-agents/agents`,
  `dexhorthy/mailcrew`, `doorman11991/{marrowscript,bonescript,budget-aware-mcp}`,
  `tursodatabase/agentfs`, `nicobailon/pi-subagents`,
  `earendil-works/pi-chat`, `kmichels/multi-manus-planning`,
  `lincolnwan/planning-with-files-copilot-agent`, `taoidle/plan-cascade`,
  `modelcontextprotocol/*`, `agentclientprotocol/typescript-sdk`,
  `mark3labs/mcp-go`, `agentskills/agentskills`, `cline/plugins`,
  `deepseek-ai/awesome-deepseek-agent`, `chromedevtools/chrome-devtools-mcp`,
  `arize-ai/phoenix`, `brexhq/prompt-engineering`,
  `Ataraxy-Labs/{inspect,opensessions}`, `co-l/cache-hunter`,
  `datasette/datasette-agent-{charts,openai-imagegen}`.
- **Claude-Code-specific — idea-level prior art, not a runtime dependency:**
  `badlogic/cchistory` (extracts Claude Code system prompts/tools — directly
  relevant to this survey's context-file question), `elidickinson/pi-claude-bridge`,
  `nvidia/skills`, `trailofbits/skills`, `skillmatic-ai/awesome-agent-skills`,
  `buzhangsan/skill-manager`; also the `tintinweb/pi-subagents` /
  `hazat/pi-interactive-subagents` pi extensions (Claude-Code-*style*, but
  cross-platform pi packages).
- **`nousresearch/hermes-agent` — clone failed** on this host, but the repo is
  live (`git ls-remote` resolves); retry rather than treating it as missing.
- **macOS-primary among the sandbox cluster** (deprioritize on a Linux host):
  `michaelneale/agent-seatbelt-sandbox`, `neko-kai/claude-code-sandbox`
  (macOS `sandbox-exec`), and `oeftimie/vv-claude-harness`; the rest mix
  macOS/Linux or are Linux-first.

**Belongs to the sandboxing survey, not here.** The same sweep surfaced a
cluster of Claude/agent *sandbox* repos (`boxlite-ai/claudebox`,
`neko-kai/claude-code-sandbox`, `eugene1g/agent-safehouse`,
`michaelneale/agent-seatbelt-sandbox`, `rivet-dev/sandbox-agent`,
`lasso-security/claude-hooks`, `trailofbits/claude-code-devcontainer`,
`whisller/claude-compose-sandbox`, `thevibeworks/claude-code-yolo`,
`kydycode/claude-code-secure-container`, `oeftimie/vv-claude-harness`,
`snyk/agent-scan` (aka `invariantlabs-ai/mcp-scan` — same HEAD `ca91ebef…`,
verified), `captainmccrank/sandboxedclaudecode`, `rchgrav/claudebox`,
`rsh3khar/claude-sandbox`, `textcortex/claude-code-sandbox`,
`unixfox/opencode-claude-code-plugin`, plus the `awesome-agent*runtime-security`
lists). They are deliberately **not** added to this list; if any are wanted,
raise them under [workload-sandboxing-prior-art.md](workload-sandboxing-prior-art.md)
so the two surveys keep separate scopes.

Note: `pelagos`'s blackboard repo (`agent-coordinator`) is local-only and not
on a forge, so it cannot be mirrored; the design is fully recorded in
`pelagos-containers/pelagos:docs/AGENT_COORDINATION.md`.
