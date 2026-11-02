---
id: summarized-thinking
type: module-design
status: draft
title: "summarized-reasoning extension — design note: human-facing summaries, no context mutation"
parent: coding-agent
tags: ["design", "pi-extensions", "reasoning"]
---

# summarized-reasoning — the design note

One summarizer call at the end of a completed turn, written into the session as a
`custom` entry: a short "what it thought and did" card **for the person reading
the transcript**. The model's context is never touched, so a session running this
extension sends the provider exactly the same bytes as one that does not.

This note owns the *why* and the reversals. The package itself —
layout, the summarizer's model chain, commands, configuration, the invariants as
folder rules — is `../pi-summarized-thinking/`, and the pi/ThinkRail contracts
this rests on are `../pi-summarized-thinking/FINDINGS.md`. The **decisions** that
constrain a build are `../docs/d125-summarized-thinking-decisions.md`: this note
argues, that record decides, and a build must not re-litigate it.

## Problem

The first draft of this extension was wrong twice, and both mistakes are
instructive rather than embarrassing — each one looks correct until a cost shows
up one level away.

**Mistake one: replacing the stored thinking block at `message_end`.** It works
mechanically: pi rewrites the finalized assistant message in place before
subscribers and before `SessionManager` persists it, so a summary really does
replace the CoT end to end. What it gets wrong is meaning. The thinking block of
the message that produced the answer *is* the reasoning that produced the answer;
replacing it substitutes a lossy paraphrase for the thing the model needed, and
every later turn re-reads the paraphrase as if it were the model's own reasoning.
A summary is an overlay on the transcript, not a substitute inside it.

**Mistake two: rewriting the chain at `turn_end`.** Keep the first round's raw
CoT (it drives the tool calls) and replace the rest with their share of the
summary. This preserves meaning and shrinks the context — and pays for it on
every single turn. See the cache rule.

Both variants also shared the deeper defect: they made the summary *the model's*
input. That is backwards. The model needs its own reasoning to produce correct
output; the summary exists so a human can audit a long turn without reading raw
CoT. Everything below follows from separating those two audiences.

## The cache rule

Provider caching is a **prefix hash**. A request is served from cache up to the
first changed token; every token after it is billed and processed again (cached
reads run ≈0.1× input price, cache writes ≈1.25×).

> **You may only edit a message that has never been sent to the provider.**

The terminal assistant message of a turn was output, never input — so rewriting
*it* is free (which is why mistake two could have safely replaced the last block,
and nothing else). Every earlier round of a tool chain was input to a later round
of the same turn: editing round 1 diverges the prefix immediately and re-prefills
the entire chain, on every turn, for as long as the chain stays in the window.

Worked example — a 250k-token chain on an Opus-class model ($15/M input,
$1.50/M cached read, 1.25× write): a cache hit on that segment costs ≈ $0.38; a
`context_edit` of round 1 forces ≈ $8 of uncached read plus a rewrite, per turn.
The CoT it removes is ~20% of the chain, so the strip does not pay for itself
inside a normal compaction interval. Appending is always free; editing is never
free. That asymmetry is the whole argument.

## Decision

**The summary is a session entry for humans: `type: "custom"`, `customType:
"reasoning-summary"`, written once per completed turn.** `custom` entries are
invisible to the model by construction — `sessionEntryToContextMessages()`
returns `[]` for them, while the superficially similar `custom_message` is what
`convertToLlm` turns into a `user` message. So the cache risk stops being
something this extension manages and becomes something it cannot express.

- The extension is a **read-only observer plus an append**: it never rewrites a
  message, never prepends, never contributes a system-prompt fragment (ThinkRail
  rebuilds the system prompt every turn, so any dynamic fragment there would void
  the entire prefix on every request).
- One call per completed turn, over thinking + a truncated tool ledger + a
  grounding snippet. Never a rolling summary: each rolling step sees only a lossy
  predecessor, so decisions quietly evaporate.
- Write-once, keyed by `coveredEntryIds`: a reload, a retry, or a toggle is a
  no-op rather than a regeneration.
- `hide_thinking_block` concerns retire with the rewrite — pi's
  `hideThinkingBlock` is a display setting for pi's own renderer, and this
  extension no longer touches thinking blocks.

## Consequences

- **Rounds 1…N-1 keep their folded thinking cards** for the rest of the window;
  only the final answer's card becomes the chain summary. Accepted: folding
  several cards per turn is a *rendering* problem worth zero tokens, whereas
  rewriting them costs the cache (this note's rule).
- The summarizer's tokens never surface as thinking: it is a `complete()` call with
  reasoning off, not an agent turn.
- Delivery is a `custom` entry, so the TUI needs `registerEntryRenderer` and
  ThinkRail needs one web row — where the entry arrives in the transcript but not
  in the live `entry_appended` payload (`../pi-summarized-thinking/FINDINGS.md`).
- The summary is not selectable, searchable or quotable by the model, ever. That is
  the point, and it is also the one thing a user may ask for (feeding it back) that
  this design refuses.
- Toggling is a rendering decision, not a context one: turning the card off cannot
  change what the model sees.

## Status

Design only — nothing implemented. `../pi-summarized-thinking/TODO.md` owns the
build order, led by the regression test that keeps it honest: a turn with the
extension on and off must produce byte-identical `llmMessages`.
