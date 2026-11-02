# FINDINGS — pi and ThinkRail contracts behind pi-summarized-thinking

The reconnaissance this design rests on, written down so a future session does
not re-derive it. The design itself (and the reversals that shaped it) is
[`../coding-agent/summarized-thinking.md`](../coding-agent/summarized-thinking.md);
this file is the evidence under it. Two source trees are cited, and they are not
the same tree:

- **pi** — `@earendil-works/pi-coding-agent`, upstream `earendil-works/pi`,
  paths `packages/coding-agent/src/…` and `packages/agent/src/…`. The container's
  provider extensions were verified against **1.4.0** (see `../pi-synthetic/TODO.md`);
  ThinkRail pins **1.5.0** with a local patch on `@earendil-works/pi-ai@1.5.0`.
  Re-check anything marked "unverified" against the installed version.
- **ThinkRail** — `@thinkrail/*`, paths `packages/server/src/…`,
  `packages/contracts/src/…`, `apps/web/src/…`.

## pi's entry model: the two shapes that look alike

`packages/coding-agent/src/core/session-manager.ts`

| Entry | Persisted by | Projected into the model context |
| --- | --- | --- |
| `type: "custom"` | `appendCustomEntry(customType, data)` | **no** — `sessionEntryToContextMessages()` returns `[]` |
| `type: "custom_message"` | `appendCustomMessageEntry(customType, content, display, details)` | yes — becomes a `CustomMessage`, `role: "custom"` |
| `type: "message"` | normal turns | yes |
| `type: "context_edit"` | `appendContextEdit(targetId, replacement)` | applies `replacement` to the target at read time |
| `type: "compaction"` | `appendCompaction(...)` | becomes the compaction summary message |

`convertToLlm()` (`core/messages.ts`) is the last step before a provider call and
turns **`custom` → `role: "user"`** with its content; `display` is not consulted
(it is a rendering flag). It is used by prompt calls, by compaction's
`generateSummary`, and by extensions/tools. So a `custom_message` reaches the
model, and a `custom` entry never does — the difference the whole design hangs on.

`projectContextEntry(entry, edit)` applies a `context_edit`: `replacement: null`
drops the entry, `replacement.content` replaces the message's content (a string
becomes a single text block). `buildSessionProjection(entries)` is the
compaction-aware view both the agent and `prepareCompaction` read.

## The `turn_end` boundary

`packages/coding-agent/src/core/agent-session.ts` (`_dispatchTurnEndBoundary`,
`_installAgentBoundaryHooks`, `_applyBoundaryDrafts`, `_refreshFinalizedContext`)

- Fires from `agent.finishTurn`, after the assistant message and its tool results
  are persisted, before the low-level turn end. Event fields: `turnIndex`,
  `message`, `toolResults`, `messageEntryId`, `toolResultEntryIds`, `outcome`
  (`"completed" | "aborted" | "error"`).
- A context preview is built lazily: `contextEntries`, `contextMessages`,
  `llmMessages`, `pendingMessages`, `canContinue`.
- Handlers return drafts of exactly four kinds — `custom`, `custom_message`,
  `context_edit`, `compaction` — applied in list order, then
  `_refreshFinalizedContext()` rebuilds `agent.state.messages` from the
  projection and emits `entry_appended` for each.
- `continue` is allowed only while the projected context is runnable.
- `agent_before_settle` is the sibling boundary (same draft support) that fires
  once the run is truly over, after retries, follow-ups and compaction; `turn_end`
  fires per turn, which is what a per-answer card wants.
- `prepareCompaction` runs on `buildSessionProjection(...)`, i.e. **`context_edit`
  entries are what compaction reads** — the reason the rejected design expected
  to control compaction with them.

## The extension surface relied on

`packages/coding-agent/src/core/extensions/types.ts`

- `appendEntry<T>(customType, data)` — doc comment: *"Append a custom entry to
  the session for state persistence (not sent to LLM)."*
- `registerEntryRenderer<T>(customType, renderer)` — renders those entries in
  the TUI; `EntryRenderer` gets the entry and the theme.
- `ctx.ui` — `select`/`confirm`/`input`/`editor`/`notify`/`setStatus`/…; commands
  and `getSessionCommands` are the two surfaces a summary tool needs.

## The cache rule (why the earlier designs died)

Provider caching is a **prefix hash**: a request is served from cache up to the
first changed token, and everything after it is billed and processed again.
Cached reads are roughly 0.1× input price, cache writes roughly 1.25×.

The rule that follows: **only ever edit a message that has never been sent to the
provider.** A message's own first send is unavoidable; a later edit costs a full
re-prefill of everything after it, every turn.

- The **terminal** assistant message of a turn was output, never input → rewriting
  it at `turn_end` is free. (This is why the rejected `context_edit` design
  *could* have replaced the last block safely.)
- Rounds 1…N-1 of a tool chain **were** input in later rounds of the same turn →
  rewriting them diverges the prefix at round 1 and re-prefills the whole chain,
  every turn, for as long as the chain stays in the window.
- Anything touching the **system prompt** voids everything. ThinkRail rebuilds the
  system prompt every turn (`_installAgentNextTurnRefresh`), so a dynamic fragment
  there is the most expensive bug available.

Worked example, 250k-token chain, Opus-class pricing ($15/M input, $1.50/M cached
read, 1.25× write): a cache hit on that segment ≈ $0.38; a `context_edit` of
round 1 forces ≈ $8 of uncached read plus a rewrite, per turn. The CoT removed by
the edit is ~20% of the chain, so the strip never pays for itself inside a normal
compaction interval. The remaining, decisive asymmetry: appending is always free,
editing is never free.

## ThinkRail integration

The extension model three rings deep: `packages/server/src/extensions/registry.ts`
lists the server halves (`ext-visualize`, `ext-ask-user-question`,
`ext-web-access`), `apps/web/src/extensions/registry.ts` lists only web *tool
renderers*, and `packages/server/src/extensions/catalog.ts` produces the
Settings → Extensions list (it records tool names through an inert proxy, so a
command-only extension has nothing to record).

- **Loading:** `packages/server/src/agent/extensions.ts` builds pi's
  `DefaultResourceLoader` with `additionalExtensionPaths` and gates on
  `ctx.trusted`; `projects.ts` seeds trust from pi's own. A package installed in
  the host's extension dir is discovered and relabelled there. ThinkRail's own
  `thinkrail-extensions/<name>` wrapper is only needed to ship a *bundled*
  default; a `pi-*` package loaded from the agent dir needs no wrapper.
- **Commands:** `agentSessionManager.ts` exposes `getSessionCommands` and runs
  them under `notifyingCommandContext`, which proxies `ctx.ui.notify` to the web.
- **UI bridge:** `packages/server/src/agent/webUiContext.ts` implements
  `select`/`confirm`/`input`/`editor`/`notify`/`setStatus`/`setWidget`/`setTitle`
  over `ExtUiRequest`; **`custom` is a stub returning `undefined`**, and
  `setHiddenThinkingLabel`, `setWorkingMessage`, `setWorkingVisible`,
  `setWorkingIndicator`, `setFooter`, `setHeader`, `onTerminalInput` are no-ops.
- **Events:** `session.subscribe` in `agentSessionManager.ts` projects through
  `sessionEventProjection.ts`, where **`entry_appended` carries only
  `{ entryType }`** — the payload is deliberately hidden.
- **Transcript:** `getSessionMessages` → `transcriptMessages()` filters on
  `isTranscriptMessageRole` (`packages/contracts/src/piProtocol.ts`), whose set
  **includes `custom`**. So a `custom` summary entry is in the transcript a
  refetch returns, but not in the live `entry_appended` event.
- **Web rendering:** `apps/web/src/store/appStore.ts` maps only known
  `customType`s (`tool-response`, todo-review, background-command and subagent
  completions); `apps/web/src/chat/hydrate.ts` (`messagesToRuntime`) does the
  same on load. An unknown `customType` is ignored in both paths → a summary card
  is **invisible in ThinkRail until one row type is added**.
- **Thinking rows:** `apps/web/src/chat/rows.ts` drops empty thinking blocks
  (`block.thinking.trim().length === 0`) and `ActivityGroup.tsx` folds the rest
  into a thinking group — pi's `hideThinkingBlock` is not a ThinkRail setting, so
  "hide" there would have to mean rewriting the block empty (no longer needed
  now that summaries are entries, not thinking).
- **Cheap-model precedent:** `packages/server/src/agent/oneshot.ts` already owns
  a `ModelTier = "cheap" | "default"` preference list and `completeOnce()`; the
  summarizer's host fallback should mirror it rather than invent a second list.
- **Sessions on disk:** ThinkRail uses pi's `SessionManager.create(cwd)` /
  `SessionManager.open(path)` (calls in `agentSessionManager.ts`), so sessions are
  pi JSONL and the sidecar/backfill reader needs no bespoke parser.

## Model catalogue facts

- `coding-agent/lib/catwalk-facts.json`, provider `synthetic`:
  `default_small_model_id: syn:small:text`; the listing carries both
  `syn:small:text` (alias, 196608 ctx, 0.1/0.5 per M, `can_reason: true`) and
  `hf:zai-org/GLM-4.7-Flash` (the same model by canonical id).
- The **generated** `coding-agent/model-019-cloud-synthetic.json` emits only
  `hf:zai-org/GLM-4.7-Flash`, with `thinkingLevelMap.off: "none"`. So the alias
  must be tried first and skipped when `find()` misses — the reverse order would
  make the summarizer look unavailable on the container's own generated config.
- Container-local chain (previous draft): llama-swap `:18080`,
  `01b-ctx125-unsloth/LFM2.5-8B-A1B-GGUF:Q8_0` → `02b-ctx128-unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL`,
  then `opencode-go/mimo-v2.5` as the cloud emergency. The `:18080` catalogue is
  free and local, so it stays ahead of the cloud rung; `mimo-v2.5` retires in
  favour of the synthetic pair.
- `ModelRegistry.getApiKey(model)` was **removed in the 0.62/0.63 era**; the
  current surface is `getApiKeyAndHeaders(model) → { ok, apiKey, headers, baseUrl }`.
  ThinkRail pins 1.5.0, so the new name is the one to code against. *(Reported by
  upstream release notes during this recon; verify against the installed 1.5.0
  typings before relying on a field name.)*

## Superseded claims in the previous draft

The previous revision of this note (`coding-agent/summarized-thinking.md`)
asserted things that no longer hold:

| Previous claim | Now |
| --- | --- |
| Replace the stored `thinking` block at `message_end` | Summaries are `custom` entries; thinking blocks are never touched |
| `hide_thinking_fallback` resolves a clash with `hideThinkingBlock` | Key retired — no thinking rewrite, no clash |
| `opencode-go/mimo-v2.5` as the cloud emergency | `synthetic/syn:small:text`, then `synthetic/hf:zai-org/GLM-4.7-Flash` |
| The summary is what the model sees next turn | The model sees nothing new; the summary is for the human |
| Built-in behaviour "pulls from the live llama-swap catalogue" | Still true as one rung, but it is rung 2 behind an explicit pin, and the chain now ends at the host's cheap tier |

## Verified, and not

| Question | Status |
| --- | --- |
| `custom` entries never enter the model context | verified in source (`sessionEntryToContextMessages`, `convertToLlm`) |
| `custom_message` becomes a `user` message | verified (`convertToLlm`) |
| `turn_end` accepts a `custom` draft and persists it | verified (`_applyBoundaryDrafts`) |
| Boundary commit rebuilds `agent.state.messages` | verified (`_refreshFinalizedContext`) |
| Compaction reads the projection | verified (`prepareCompaction` + `buildSessionProjection`) |
| `appendEntry` is documented as "not sent to LLM" | verified (types.ts doc comment) |
| ThinkRail hides `entry_appended` payloads | verified (`sessionEventProjection.ts`) |
| ThinkRail's transcript includes `custom` messages | verified (`TRANSCRIPT_MESSAGE_ROLES`) |
| Cache invalidation semantics and price ratios | provider-generic; not re-measured here |
| `getApiKeyAndHeaders` shape on 1.5.0 | reported upstream; verify on the installed typings |
| Whether pi merges consecutive `user` messages deterministically | **unverified** — matters only for the retired digest design, not for `custom` entries |
| ThinkRail's own row for a `custom` summary | not built; one web change either way |
