# pi-summarized-thinking — end-of-turn reasoning summaries as a pi package

One summarizer call at the end of a completed turn, written into the session as a
`custom` entry: a small "what it thought and did" card for the person reading the
transcript. The model's context is untouched — a session with this extension
loaded hands the provider exactly the same bytes as one without it.

Design rationale, the reversals that produced it, and the cache arithmetic live
in [`../coding-agent/summarized-thinking.md`](../coding-agent/summarized-thinking.md);
the decisions a build must not re-litigate are
[`../docs/d125-summarized-thinking-decisions.md`](../docs/d125-summarized-thinking-decisions.md);
the pi/ThinkRail contracts it rests on (with the symbols to check them against) are
in [`FINDINGS.md`](FINDINGS.md). Nothing is implemented yet — `TODO.md` owns the
build order and `AGENTS.md` the folder rules.

## What it is not

- Not a thinking-block replacement. The thinking block of the message that
  produced the answer _is_ the reasoning that produced the answer; a paraphrase
  standing in for it is worse input, not cheaper input.
- Not a context rewrite. Anything that edits a message already inside a cached
  prefix re-prefills the whole suffix on every turn.
- Not a `custom_message` digest fed to the model. The summary is for a human;
  `custom_message` is the one entry type that _does_ become a `user` message.

## The entry that makes it safe

| Entry            | Written by                                 | In the model context?                                 |
| ---------------- | ------------------------------------------ | ----------------------------------------------------- |
| `custom_message` | `appendCustomMessageEntry` / `sendMessage` | **yes** — `convertToLlm` makes it a `user` message    |
| `custom`         | `appendCustomEntry` / `pi.appendEntry`     | **no** — `sessionEntryToContextMessages` returns `[]` |

pi's own doc comment on `appendEntry` says it: _"Append a custom entry to the
session for state persistence (not sent to LLM)."_ The card is
`customType: "reasoning-summary"`; the context is untouched by construction, not
by discipline.

## How it works

At the `turn_end` boundary, for a turn that produced a final answer (outcome
`completed`, no tool results pending):

1. Read the turn off the branch — the user message that opened it, each assistant
   message's thinking, and the tool ledger (name, key argument, truncated result).
2. One summarizer call over that material, grounded by a snippet of the preceding
   user/tool text.
3. Return one boundary draft — `{ type: "custom", customType:
   "reasoning-summary", data: { turnId, coveredEntryIds, summary, model } }` —
   persisted by `appendCustomEntry` in the same commit as the rest of the
   boundary. `pi.appendEntry` from inside the handler is equivalent; the draft
   form is atomic with the boundary.
4. Write-once: `coveredEntryIds` makes a re-run a no-op. A summary is never
   regenerated, because a regeneration would be a new entry, not an edit.

The summarizer itself is a plain `complete()` call, never an agent turn: its
tokens are not the session's tokens and there is no thinking to suppress.

## Where the summary goes

Two deliveries over one dependency-free core (`entries → summary text`):

| Delivery                             | What it does                                                                             | What it costs                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| In-chat, `custom` entry              | live card in the transcript; TUI via `registerEntryRenderer`, ThinkRail via one row type | one web change in ThinkRail (below)       |
| Sidecar, `<session>.reasoning.jsonl` | backfill over existing sessions, re-summarize with another model, audit trail            | a viewer or a host endpoint that reads it |

The sidecar reader opens pi JSONL with `SessionManager.open(path)`, walks to a
leaf, and writes **beside** the session — never into a file a live session has
open, or the in-memory leaf and the file diverge and the tree corrupts.

## Model chain

Priority: explicit pin → local llama-swap → cloud → host fallback. A candidate is
usable only if `ctx.modelRegistry.find(provider, modelId)` resolves; nothing is
self-registered.

1. `SUMMARIZER_PROVIDER` + `SUMMARIZER_MODEL_ID`, or the same pair in
   `.pi/summarized-reasoning.json`
2. live llama-swap on `:18080` — free, and only resolvable where that catalogue
   exists
3. `synthetic/syn:small:text` — cheapest cloud tier that is still coherent here;
   **try the alias first**
4. `synthetic/hf:zai-org/GLM-4.7-Flash` — the same model by canonical id, for a
   registry whose generated catalogue emits no `syn:*` alias (`coding-agent/model-019-cloud-synthetic.json`
   does not; the upstream fact table does)
5. the host's own cheap-model preference (ThinkRail's `oneshot.ts` tier list),
   then `ctx.model`
6. nothing resolves → disable for the session and say so once

Request shape: `getApiKeyAndHeaders(model)` (pi ≥ 0.63; `getApiKey` is gone),
reasoning **off** (`thinkingLevelMap.off: "none"` on GLM-4.7-Flash), `maxTokens`
≈ 250, temperature 0, abort signal, timeout. A failed summary is a missing card,
never a failed turn.

## Commands

| Command                                       | Purpose                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/reasoning-summary`                          | Toggle the card (default ON). OFF stops writing entries; existing ones stay.            |
| `/reasoning-summary-test`                     | One summarizer call over the current turn, printed inline, nothing written.             |
| `/reasoning-summary-model <provider/modelId>` | Pin the summarizer; empty args reset to env/file/builtin. Must resolve in the registry. |

In ThinkRail these arrive through `getSessionCommands` and the bridged `ctx.ui`
(`select` / `confirm` / `input` / `notify`) — which is why the test command prints
instead of opening a custom component: `ctx.ui.custom` is a stub there.

## Configuration

Priority: env > `.pi/summarized-reasoning.json` > builtin. Flat object, every key
optional; an explicit `provider` + `model_id` replaces the candidate chain.

```json
{
  "provider": "synthetic",
  "model_id": "syn:small:text",
  "grounding_chars": 1200,
  "summarize_min_chars": 200,
  "max_summary_tokens": 250
}
```

Environment: `SUMMARIZER_PROVIDER`, `SUMMARIZER_MODEL_ID`,
`SUMMARIZER_GROUNDING_CHARS`, `SUMMARIZER_MIN_CHARS`,
`SUMMARIZER_MAX_TOKENS`.

## Invariants

The folder rules in [`AGENTS.md`](AGENTS.md) are the long form; these are the
short form, and each one is a bill:

- **Nothing enters the model context** — no `custom_message`, no `context_edit`,
  no system-prompt fragment, no injected tool result.
- **Append-only, at the tail** — never prepend, never insert between an assistant
  tool-call message and its results.
- **Only edit what has never been sent** — in practice: nothing at all.
- **Write-once** — a reload, retry or toggle never regenerates a summary.
- **Cheap and bounded** — one call per turn, small `maxTokens`, reasoning off,
  timeout, abort signal.

## Layout

| File                       | Role                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| `index.ts`, `package.json` | the extension entry and its `pi.extensions` manifest — the folder IS the package |
| `README.md`                | this file: what it is, how it runs, the model chain, the commands                |
| `FINDINGS.md`              | pi/ThinkRail contracts with citations, the cache rule, the superseded claims     |
| `AGENTS.md`, `TODO.md`     | folder rules · the build order, unbuilt                                          |

`index.ts` stays out of `tsconfig.json`, like `../pi-synthetic/index.ts`: it
imports `@earendil-works/pi-coding-agent`, which this repo does not vendor.
