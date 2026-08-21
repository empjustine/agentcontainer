# Two approaches to building a minimal coding agent

A comparison of **mini-swe-agent** (`/reference/github/SWE-agent/mini-swe-agent/`, v2.4.6, Python) and **pi**'s agent core (`/reference/github/earendil-works/pi/packages/agent/`, `@earendil-works/pi-agent-core` 0.84.1, TypeScript), which is the package pi builds its coding agent on. Both solve the same problem — a loop that lets an LLM inspect a repo, run commands, edit files, and finish — but they optimize for opposite things: mini for *radical simplicity and hackability*, pi for *durability, extensibility, and UI-driven control*.

---

## 1. The one-paragraph summary

**mini-swe-agent** is a ~190-line synchronous Python loop (`src/minisweagent/agents/default.py`): render two Jinja2 templates (system + instance), then repeat `query model → parse actions → run actions → append observations` until the transcript's last message has role `exit`. It deliberately has **exactly one tool (bash)**, a **completely linear transcript** (trajectory == what the model sees), and **stateless execution** (`subprocess.run` per action, swappable for `docker exec`). "The LM, not the scaffold, is the middle."

**pi's agent package** is a three-layer TypeScript platform. At the bottom, `agent-loop.ts` is a low-level async event-stream loop (a "turn" = one assistant response + its tool batch, with streaming deltas, abort signals, and parallel/sequential tool execution). In the middle, `agent.ts` wraps it in a stateful `Agent` class with subscribe/steer/followUp queues. Above that, `harness/` adds durable sessions (crash recovery, lanes, operation logs), context compaction, skills, prompt templates, and telemetry — the machinery that pi's full `packages/coding-agent` product (CLI/TUI) runs on.

---

## 2. Architectural map

### mini-swe-agent (`src/minisweagent/`)

```
run/mini.py            CLI (typer): -t task, -c config specs, -y yolo
  └─ get_model()       model factory (litellm / openrouter / portkey / requesty …)
  └─ get_environment() env factory (local / docker / singularity / bubblewrap / contree / swerex)
  └─ get_agent()       agent factory (default / interactive)
       └─ DefaultAgent.run()                      ← the whole loop, agents/default.py
            └─ Model.query(messages)              ← litellm completion + tool-call/text parsing
            └─ Environment.execute(action)        ← subprocess.run or docker exec
            └─ Model.format_observation_messages() ← render observation_template (Jinja2)
config/default.yaml   system/instance/observation/format-error templates (text-format agent)
config/mini.yaml      same, but native `bash` tool-calling via litellm
run/benchmarks/       swebench.py, programbench.py runners; .traj.json output
```

The three core abstractions are Python `Protocol`s in `__init__.py`: `Model` (query/format_message/format_observation_messages/get_template_vars/serialize), `Environment` (execute/get_template_vars/serialize), and `Agent` (run/save). Everything else is duck-typed.

### pi agent core (`packages/agent/src/`)

```
agent-loop.ts      low-level loop: streamAssistantResponse → executeToolCalls → loop
                   events: agent_start, turn_start/end, message_start/update/end,
                           tool_execution_start/update/end, agent_end
agent.ts           stateful Agent wrapper: owns transcript, subscribe(), steer()/followUp(),
                   abort(), continue(), pendingToolCalls, errorMessage
types.ts           AgentMessage, AgentTool, AgentLoopConfig, hooks, thinking levels
harness/           durable layer: AgentHarness, Session tree + lanes + operation records,
                   compaction/, skills.ts, prompt-templates.ts, telemetry.ts, tools/
  tools/           bash.ts (streaming + truncation), read.ts, write.ts, edit-diff.ts,
                   image.ts, file-mutation-queue.ts, path-utils.ts
coding-agent/      (separate package) the actual pi product on top: CLI, TUI, extensions
```

The `harness/` layer is mid-rewrite: `agent-harness.ts` as checked in is mostly stubbed (`unavailable(...)`), with the target design specified in `docs/harness-v2.md` (a 3,400-line spec covering durable operations, lanes, records, recovery). `agent-loop.ts` + `agent.ts` are the complete, working, minimal-but-general core.

---

## 3. The loop itself

### mini — imperative, exception-driven

`DefaultAgent.run()` (about 190 lines total):

```python
while True:
    try:
        self.step()                      # query() then execute_actions()
        self.n_consecutive_format_errors = 0
    except FormatError as e:             # bad model output → bounce formatted error back
        self.cost += e.messages[0]["extra"]["cost"]
        ...
    except InterruptAgentFlow as e:      # Submitted / LimitsExceeded / TimeExceeded / UserInterruption
        self.add_messages(*e.messages)
    finally:
        self.save(self.config.output_path)
    if self.messages[-1]["role"] == "exit":
        break
```

- **Exceptions are control flow.** `exceptions.py` defines `InterruptAgentFlow` with subclasses `Submitted` (task done), `LimitsExceeded`/`TimeExceeded`, `UserInterruption`, `FormatError`. Anything that should end or redirect the loop raises a message-bearing exception.
- **One model call per step**, then all actions execute, then observations are appended. No streaming, no abort signal, no parallelism.
- **Termination is a magic string.** The prompt instructs the model to `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`. The environment (`local.py`, `docker.py`) sniffs the first output line; on match it raises `Submitted` with the remainder as the submission. Works with *any* model — no structural "end of turn" needed.
- **Format errors are conversational.** `parse_toolcall_actions` raises `FormatError` with a rendered `format_error_template` (e.g. "Your response MUST include at least one tool call"); the agent injects it as a user message and lets the model recover, capped at `max_consecutive_format_errors`.
- **Limits**: `step_limit`, `cost_limit` (litellm cost calculator), `wall_time_limit_seconds`, plus a process-wide `GLOBAL_MODEL_STATS` with env-configured cost/call caps.

### pi — async event stream with tool batches

`agent-loop.ts` (`runLoop`) is structured as nested loops: an inner loop drains tool calls + steering messages, an outer loop polls follow-up messages:

```
stream assistant response (token deltas via message_update events)
  → if stopReason error/aborted: agent_end
  → filter toolCalls
      → fail all calls if stopReason "length" (truncated args are unsafe)
      → else executeToolCalls (parallel by default, or sequential)
          prepare → beforeToolCall hook → validate args → execute → afterToolCall
      → append toolResult messages
  → prepareNextTurn? / shouldStopAfterTurn? / getSteeringMessages?
  → outer loop: getFollowUpMessages?
```

- **No exceptions for flow; everything is events and hooks.** The loop emits a typed `AgentEvent` union; observers (UI, logging) subscribe and cannot mutate execution; `beforeToolCall`/`afterToolCall`/`shouldStopAfterTurn`/`prepareNextTurn` hooks can.
- **Termination is structural**: no more tool calls + no queued steering/follow-up messages, an `error`/`aborted` stop reason, a hook returning `shouldStopAfterTurn: true`, or a tool batch where every result sets `terminate: true`.
- **Streaming and abort are first-class**: `AbortSignal` threads through the loop into every tool; streaming deltas are emitted as `message_update` events; a `length` stop fails the whole tool batch instead of executing half-parsed calls.
- **Retries** are policy-based (`retry` option); failures are encoded in the stream (assistant message with `stopReason: "error"`), never thrown.

---

## 4. The tool model

| | mini-swe-agent | pi agent core |
|---|---|---|
| Number of tools | **1**: bash. File edits happen *inside* bash (sed/cat). Deliberate: "no custom tools for every specific thing — tell the LM to figure it out" | Many: bash, read, write, edit-diff, image, plus app-defined tools |
| Tool schema | One hardcoded `BASH_TOOL` OpenAI-style function schema in `actions_toolcall.py` | Per-tool TypeBox JSON schemas, validated with `validateToolArguments` before execution |
| Tool-calling requirement | **None.** Two model families: tool-calling (`mini.yaml`, litellm) and text-format (`default.yaml`: parse ```mswea_bash_command blocks from free text) — "you can run it with literally any model" | Native tool-calling only; `convertToLlm` bridges message types, not action formats |
| Action shape | Plain dicts: `{"command": "...", "tool_call_id": ...}` | `AgentToolCall` content blocks + `AgentToolResult<T>` = `{content[], details, usage, addedToolNames?, terminate?}` |
| Result formatting | Jinja2 `observation_template` renders returncode/output/exception_info into the next user/tool message; truncation to 10k chars with head/tail + `elided_chars` | Tool returns structured `{content, details}`; bash tool truncates (last N lines / KB) *and saves the full output to a temp file*, pointing the model at it; streaming `onUpdate` partials throttled at 100 ms |
| Errors | Rendered into the observation (exception_info) or a `FormatError` user message | Contract: **throw** on failure → loop catches, wraps as `toolResult` with `isError: true`; `beforeToolCall` can block; `afterToolCall` can patch |
| Execution mode | Sequential by construction (one step = one action batch) | `parallel` (default) or `sequential`, per-batch or per-tool via `executionMode` |

mini's bash execution is deliberately primitive: `subprocess.Popen(shell=True, ...)` with a timeout that kills the process group, merged stdout/stderr, `start_new_session`. pi's bash tool is a mini-runtime of its own (`harness/utils/shell-output.ts` + `truncate.ts`): cwd/env injection, timeout, abort signal, per-chunk capture with progress callbacks, byte/line truncation with `[Showing lines X-Y of N. Full output: /tmp/...]` pointers.

---

## 5. Messages and history

**mini — "completely linear history" (a stated feature).**
- `self.messages` is a plain list of dicts; every step appends the assistant message and the observation messages. The trajectory you save (`serialize()`, `.traj.json`, format `mini-swe-agent-1.1`) **is** the exact prompt history. There is no hidden state, no pruning, no compaction.
- The README calls this out as a feature for debugging and for RL/fine-tuning: what you see is what the model saw, no transcript/context divergence.
- Context overflow is handled by... the model's format-error template (`finish_reason == "length"` → "your response was cut off, respond more concisely"). There is no summarization.

**pi — transcript ≠ provider context.**
- `AgentMessage` is a union of standard LLM messages plus **custom message types** (declaration-merging extension point: `role: "notification"`, `role: "artifact"`, etc.).
- Every LLM call passes through `transformContext()` (prune/inject at the AgentMessage level) and then `convertToLlm()` (map/filter to provider-visible `user`/`assistant`/`toolResult`). Custom messages never leak to the provider unless explicitly converted.
- Context pressure is managed: the `harness/compaction/` module does token estimation, `shouldCompact`, `compact` with summary generation, and `branch-summarization`; the harness spec adds durable compaction (auto at thresholds, manual, and overflow-triggered retry) and an append-only context invariant (mid-turn writes defer to checkpoints to preserve provider KV-cache hits).

---

## 6. State, durability, and session management

**mini:** everything lives in RAM. `save()`/`serialize()` dump the trajectory to JSON if an `output_path` is configured. There is no resume, no session store, no compaction, no multi-turn persistence. The `InteractiveAgent` can be steered at runtime (human/confirm/yolo modes), but the *history* is still just the message list.

**pi:** a whole durability layer. `harness/session/` models a session as:
- an append-only **tree** of entries (messages + config changes + summaries),
- **lanes** (named positions in the tree, like git branches; `main` plus app-defined lanes that run operations in parallel),
- per-lane **operation logs** of records (intent-before-effect: `operation_started`, `step_attempt`, `tool_started`, `queue_enqueued`, `usage`, … with provisioned entry ids),
- **global facts** (name, labels).

`docs/harness-v2.md` specifies crash recovery/resume (restore reduces the log to a state; unfinished steps retry with durable attempt counts; tools re-execute only if replay-safe), deferred provider requests (batch APIs), abort reconciliation, and queue durability. Storage backends: memory, JSONL, SQLite (`session-backends` package). This is the *platform* answer to "what if the process dies mid-task?" — mini's answer is "re-run the task."

---

## 7. Model/provider layer

| | mini (litellm_model.py) | pi (pi-ai + stream-fn) |
|---|---|---|
| Provider breadth | litellm (hundreds of providers), plus openrouter/portkey/requesty wrappers and text-based variants that skip tool-calling entirely | Explicit provider registry (`Models.setProvider`); `Models.streamSimple` is the default `StreamFn` |
| Stream contract | n/a — `litellm.completion` returns a full response | `StreamFn` **must not throw**; failures are encoded as protocol events + a final message with `stopReason: "error" | "aborted"` |
| Cost | litellm cost calculator per call; `GLOBAL_MODEL_STATS` with thread-safe cost/call limits; Anthropic cache-control markers | Per-message `usage` (input/output/cacheRead/cacheWrite/cost); harness keeps a durable `usage` record ledger so retried/discarded responses are still billed |
| Retry | tenacity loop with an abort-exception allowlist (auth errors, context overflow, …) | Configurable `RetryPolicy` with `maxRetryDelayMs`; durable attempt counts in the harness |
| Thinking | Interleaved thinking support + `_reorder_anthropic_thinking_blocks` | First-class `ThinkingLevel` ("off"…"max") + `thinkingBudgets` token caps |
| Auth/keys | dotenv global config file (`~/.config/mini-swe-agent/.env`) | Dynamic `getApiKey(provider)` per call (for expiring OAuth tokens), `sessionId` forwarded to providers for cache-aware backends |

---

## 8. User interaction

**mini** ships an interactive mode in the box (`agents/interactive.py`): `human` (user types commands, executed immediately), `confirm` (LM commands need Enter), `yolo`; `whitelist_actions` regexes skip confirmation; `/y /c /u /m /h` slash commands; rich console rendering of each step with running cost. The loop is synchronous, so "steering" is a blocking prompt between turns.

**pi** separates concerns: the agent core emits events and exposes queues; the interactive surface lives in other packages (the `tui` package, keybindings, the coding-agent CLI). `Agent.steer()` injects a user message *while a tool is running* (queued, durable in the harness); `followUp()` queues work for after the agent would stop; `steeringMode`/`followUpMode` control drain granularity. The harness spec even describes a Slack-thread/email-thread lane model where one session serves many parallel conversations.

---

## 9. Benchmarks, tests, and "minimal" as a research position

mini-swe-agent's second audience is *research*: `run/benchmarks/` contains SWE-bench, single-instance, and ProgramBench runners with batch progress and a stable trajectory JSON format, and the project's identity is "a baseline that puts the LM, not the scaffold, in the middle" (SWE-bench bash-only leaderboard). It scores >74% on SWE-bench verified with a single bash tool. The `minimal-agent.com` tutorial exists to teach the ~100-line pattern.

pi's agent package is a *general-purpose agent engine* whose test suite includes harness conformance tests (`harness/session/testing/`, `vitest.harness.config.ts`) and a "deterministic stepping" goal (drive mode that parks before every effect so tests can stop, inject, or crash-restart at any boundary). Benchmarks live in a separate `evals` package.

---

## 10. Shared ideas worth noting

- **Both treat the transcript as the core data structure** and append observation/tool-result messages after assistant messages. mini's `format_observation_messages` ↔ pi's `toolResult` messages.
- **Both execute bash statelessly** (fresh subprocess/shell per call) rather than keeping a stateful shell session — mini by design ("directory or environment variable changes are not persistent"), pi's bash tool likewise captures a single command with cwd/env. Sandboxing is a matter of swapping the execution backend.
- **Both truncate long command output** rather than flooding the context: mini's observation template (10k chars, head/tail + elided count) and pi's truncate util (last N lines/KB + full-output file pointer).
- **Both bounce malformed output back to the model** instead of crashing: mini's `FormatError` template vs pi's tool-argument validation errors and failed-truncated-batch messages.
- **Both have layered extension points**: mini's Model/Environment/Agent protocols and per-class configs vs pi's hooks, events, custom message types, and tool interfaces.

## 11. The honest trade-off table

| Dimension | mini-swe-agent | pi agent core |
|---|---|---|
| Core loop size | ~190 lines (Python) | ~800 lines `agent-loop.ts` + 590 lines `Agent` (TS) |
| Tools | 1 (bash) | open set with schemas/validation/hooks |
| History | linear, == transcript, in memory | typed messages ≠ provider context; pruned/compacted; durable session tree |
| Crash safety | none (re-run) | durable operations, intent records, resume |
| Streaming/abort | no | yes (deltas, AbortSignal everywhere) |
| Parallel tool calls | no | yes (default), with sequential opt-out |
| User steering mid-run | blocking prompt between turns | async steer/follow-up queues (durable in harness) |
| Model compatibility | any model incl. non-tool-calling (text format) | tool-calling models via providers |
| Cost/limits | step/cost/wall-time + global stats | usage ledgers, retry budgets, token-based compaction |
| Best at | baseline, research (RL/FT), hackability, minimal deps on scaffolding | long-running products, UIs, multi-session/multi-lane services, crash-resilient operation |
| Worst at | context growth, crash recovery, parallelism | doing anything at "glanceable simplicity" scale |

**Bottom line:** mini-swe-agent is the answer to "how little scaffold can we get away with?" — one tool, one loop, exceptions as control flow, the shell as the interface, and the transcript as the whole state. pi's `packages/agent` is the answer to "how do we build a *reliable, extensible, embeddable* agent engine?" — a minimal event-driven loop at its core, but wrapped in typed tools, hooks, queues, durable sessions, and compaction, because pi (the product) needs long-running, resumable, UI-driven coding sessions rather than a one-shot SWE-bench trajectory.
