---
id: summarized-thinking
type: module-design
status: draft
title: "pi-summarized-thinking — human-facing reasoning summaries as a pi package"
parent: coding-agent
tags: ["design", "pi-extensions", "reasoning"]
---

# pi-summarized-thinking — human-facing reasoning summaries as a pi package

One summarizer call at the end of a turn, writing a short "what it thought and
did" card **for the human reading the transcript**. The summary never enters the
model's context, never replaces a thinking block, and never touches an entry a
provider has already seen — the prompt bytes of a session that uses this
extension are identical to a session that does not.

This folder is the package, like `../pi-synthetic/`: `README.md` here,
`FINDINGS.md` for the pi/ThinkRail contracts the design rests on, `AGENTS.md`
for the folder's own rules, `TODO.md` for the open work. No code yet — this is
the design of record, and it replaces the note that lived at
`../coding-agent/summarized-thinking.md` (that path is gone; see "Why it moved").

## What this is not

Three designs were worked through and rejected before this one. Each rejection
is the reason a rule below exists:

- **Not a thinking-block replacement at `message_end`.** It works mechanically
  (pi rewrites the finalized message in place before subscribers and before
  `SessionManager` persists it), but it feeds the summary to the model as if it
  were the reasoning that produced the answer — a lossy, provider-signed
  artifact standing in for the thing the model actually needed.
- **Not a context rewrite at `turn_end`.** Replacing every assistant message's
  thinking with its share of the summary keeps the context small, but every one
  of those messages was already inside a cached prefix. One changed token voids
  the cache from that token to the end of the request — see the cost table.
- **Not a `custom_message` digest fed back to the model.** The summary is
  bookkeeping for a person; a user-role message injected every turn to carry it
  is noise the model must then reason around, and a `custom_message` is precisely
  the entry type that *does* enter the context.

## The entry type that makes this safe

pi has two entry shapes that look alike and are opposites:

| Entry | Written by | In the model context? |
| --- | --- | --- |
| `custom_message` | `appendCustomMessageEntry` / `sendMessage` | **yes** — `convertToLlm` turns it into a `user` message |
| `custom` | `appendCustomEntry` / `pi.appendEntry` | **no** — `sessionEntryToContextMessages` returns `[]` for it |

pi's own doc comment on `pi.appendEntry` states it plainly: *"Append a custom
entry to the session for state persistence (not sent to LLM)."* A `custom`
entry is persisted in the session file, emitted as `entry_appended`, and
rendered by an extension-supplied `registerEntryRenderer` — with the context
untouched **by construction**, not by our discipline. That is the whole
architecture: the summary is a `custom` entry, `customType: "reasoning-summary"`.

## How it works

At the `turn_end` boundary, for a turn that produced a final answer (no tool
results pending, outcome `completed`):

1. Read the turn off the branch: the user message that opened it, every
   assistant message's thinking, and the tool-call ledger (name, key argument,
   result or error — truncated).
2. Make **one** summarizer call over that material, grounded by a short snippet
   of the preceding user/tool text. One call per turn, never a rolling summary:
   each rolling step sees only a lossy predecessor, so decisions quietly
   evaporate.
3. Return one boundary draft — `{ type: "custom", customType:
   "reasoning-summary", data: { turnId, coveredEntryIds, summary, model } }` —
   which pi applies through `appendCustomEntry` in the same commit as the rest
   of the boundary. `pi.appendEntry` from inside the handler is equivalent; the
   draft form is atomic with the boundary and is what this design uses.
4. Write-once. `coveredEntryIds` makes a re-run a no-op; a summary is never
   regenerated, because a regeneration is a new entry, not an edit.

The summarizer's own tokens never enter the session: it is a `complete()` call,
not an agent turn, so there is nothing to hide and no thinking to suppress
beyond turning reasoning off on the request.

## Where the summary goes

Two deliveries, one core. The core is a pure function — turn entries in,
summary text out — which is why both are cheap:

| Delivery | What it does | What it costs |
| --- | --- | --- |
| In-chat (`custom` entry) | live card in the transcript; TUI via `registerEntryRenderer`, ThinkRail via one row type | one host/web change in ThinkRail (below) |
| Sidecar (`<session>.reasoning.jsonl`) | backfill over sessions that predate the extension, re-summarize with another model, audit trail | a viewer or a host endpoint that reads it |

The sidecar path is the external-tool reading: `SessionManager.open(path)` walks
the same JSONL the host writes, no extension loading, no trust gate, read-only.
It must **never** append into a session a live session has open — the in-memory
leaf would diverge from the file — so it writes beside it.

## Model chain

Priority: explicit pin → local llama-swap → cloud → host fallback. A candidate is
usable iff `ctx.modelRegistry.find(provider, modelId)` resolves (catalogue entry
plus working auth); nothing is self-registered.

1. `SUMMARIZER_PROVIDER` + `SUMMARIZER_MODEL_ID`, or the same pair in
   `.pi/summarized-reasoning.json`
2. live llama-swap on `:18080` — free, and only resolvable where that catalogue
   exists: `01b-ctx125-unsloth/LFM2.5-8B-A1B-GGUF:Q8_0`, then
   `02b-ctx128-unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL`
3. `synthetic/syn:small:text` — the cheapest cloud tier that is still coherent
   for this task; **try the alias first**
4. `synthetic/hf:zai-org/GLM-4.7-Flash` — the same model by canonical id, for a
   registry whose generated catalogue does not emit `syn:*` aliases (the current
   `coding-agent/model-019-cloud-synthetic.json` does not; the upstream fact
   table does)
5. the host's own cheap-model preference (ThinkRail's `oneshot.ts` tier list),
   then `ctx.model` (`SYNTHETIC_API_KEY` in the container comes from the env chain)
6. nothing resolves → disable for the session and say so once, never silently
   fall back to the session's own model

Request shape: `getApiKeyAndHeaders(model)` (pi ≥0.63; `getApiKey` is gone),
reasoning **off** (`thinkingLevelMap.off: "none"` for GLM-4.7-Flash), a small
`maxTokens` (≈250), temperature 0, an abort signal and a timeout. A summary that
fails is a missing card, never a failed turn.

## Commands

| Command | Purpose |
| --- | --- |
| `/reasoning-summary` | Toggle the card on/off (default ON). OFF stops writing entries; existing ones stay. |
| `/reasoning-summary-test` | One summarizer call over the current turn, printed inline, nothing written. Validates the pipeline and the model chain. |
| `/reasoning-summary-model <provider/modelId>` | Pin the summarizer; empty args reset to env/file/builtin. The pin must resolve in the registry. |

In ThinkRail these surface through `getSessionCommands` + the bridged `ctx.ui`
(`select`/`confirm`/`input`/`notify`), which is also why the test command prints
rather than opening a custom component: `ctx.ui.custom` is a stub there.

## Configuration

Priority: env > `.pi/summarized-reasoning.json` > builtin. Flat object, every key
optional; a single explicit `provider`+`model_id` replaces the candidate chain.

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

The old `hide_thinking_fallback` key retires with the thinking rewrite: pi's
`hideThinkingBlock` is a display setting for pi's own renderer, and this
extension no longer touches thinking blocks, so there is no conflict to resolve.

## Invariants

These are not preferences; each one is a bill.

- **Nothing enters the model context.** No `custom_message`, no `context_edit`,
  no system-prompt fragment, no injected tool result. `custom` entries only.
- **The system prompt stays byte-identical.** ThinkRail rebuilds it every turn,
  so any dynamic contribution — a timestamp, a session id, a summary — would void
  the whole cached prefix on every request.
- **Append-only, at the tail.** Never prepend, never insert between an assistant
  tool-call message and its results, never mid-chain.
- **Edit only what has never been sent.** Restated in `FINDINGS.md` with the
  arithmetic: rewriting a message that is already inside a cached prefix costs a
  full uncached re-prefill of everything after it, per turn.
- **Write-once.** Summaries and their entries are immutable once written; a
  reload, a retry, or a toggle must not regenerate them.

## Why it moved

This was `coding-agent/summarized-thinking.md`. The extension now owns a folder
of its own, and a document travels with the unit it describes (docs/d117), so the
note travels with the package it specifies — same id, same `parent: coding-agent`
edge, which is still true: the extension is one of the `pi-*` packages that unit
ships. Its revision history, and the reasoning behind every reversal above, is in
`FINDINGS.md`.
