---
id: d125
type: module-design
status: active
title: "d125 — pi-summarized-thinking: human-facing turn summaries, and the context is never touched"
parent: coding-agent
depends-on: [d100, d117]
references: [d042, d096, d116, d124]
tags: ["pi-extensions", "reasoning", "cache", "sessions", "thinkrail"]
---

# d125 — pi-summarized-thinking: decisions of record

## Status

Decisions taken; **nothing implemented**. The package folder exists with
documentation only (`../pi-summarized-thinking/`), and the build order is its
`TODO.md`. This record is the decision log for that extension: the design note
`../coding-agent/summarized-thinking.md` holds the reasoning and the reversals,
and this record holds the decisions a build must not quietly re-litigate.

## Problem

Two separate needs, and they are why this is a record rather than a longer note.

The first is ordinary: a new `pi-*` package joined the family that docs/d100
describes, and the family's members each have a decision record that argues their
shape (docs/d096 for `pi-synthetic`, docs/d097 for `pi-opencode`). This one has a
harder job than its siblings, because its subject is *invisible* when it goes
wrong — a summary that leaked into the model context would still render
correctly, still look right in a transcript, and only show up as an unexplained
bill.

The second is that the design reversed twice before this record existed, and the
reversal is the part worth pinning. The first draft replaced the stored thinking
block at `message_end`; the second rewrote the whole chain at `turn_end` through
`context_edit` entries. Both are mechanically supported by pi 1.5.0, both look
reasonable in review, and both are wrong for reasons one level away from the code
— meaning, and cache economics. A future session reading only the note could
rebuild either one in good faith; the decisions below are what makes that hard.

## Decisions

### The audience is the human, and only the human

A summary exists so a person can audit a long turn without reading raw
chain-of-thought. It is **not** a substitute for the model's reasoning and is
never fed back to the model: the model needs its own CoT to produce correct
output, and a paraphrase of it is strictly worse input than nothing. This decides
more than the entry type — it rules out every "help the model by summarizing"
feature, including ones that would be trivial to add.

### The card is a `custom` entry — and a context leak is unrepresentable

The summary is written as `type: "custom"`, `customType: "reasoning-summary"`,
because pi's `sessionEntryToContextMessages()` returns `[]` for `custom` entries,
while `convertToLlm()` turns the superficially similar `custom_message` into a
`user` message. The distinction is not a convention this extension promises to
respect; it is a property of the entry type. Cache invalidation by this
extension therefore stops being a risk to manage and becomes something the
implementation cannot express.

Consequence for every future addition: no `context_edit`, no system-prompt
fragment, no injected tool result, no writer that touches anything but a new
`custom` entry at the tail of the branch.

### One call per completed turn, append-only, write-once

The summarizer runs at the `turn_end` boundary for a turn whose outcome is
`completed`, over that turn's thinking plus a truncated tool ledger, and the
result is committed as a boundary `custom` draft. Never per round, and never as a
rolling summary — each rolling step sees only a lossy predecessor, so decisions
evaporate silently over a long chain.

The write is keyed by `coveredEntryIds` and is **immutable**: a reload, a retry, a
toggle or a re-run must not regenerate it. Regeneration is a new entry, never an
edit, which is also what makes the extension safe to toggle mid-session.

### The cache rule: edit only what has never been sent to the provider

Provider caching is a prefix hash, so a changed token re-prefills everything after
it, on every request. The rule this repo now applies to prompted sessions:

> You may only edit a message that has never been sent to the provider.

The terminal assistant message of a turn qualifies (it was output, not input);
every earlier round of a tool chain does not. This is the decision that killed
the second draft: rewriting rounds 1…N-1 diverges the prefix at round 1 and
re-prefills the entire chain each turn — roughly 20× a cache hit on a 250k-token
chain, to remove ~20% of its tokens. It also independently forbids any dynamic
system-prompt contribution, which matters because ThinkRail rebuilds the system
prompt every turn.

### The summarizer is a `complete()` call, not an agent turn

It runs outside the agent loop: one model call with reasoning **off**, a small
`maxTokens`, temperature 0, an abort signal and a timeout. Nothing about it
surfaces as the session's thinking, no tool is available to it, and a failure is a
missing card rather than a failed turn — never a retry loop, and never a fallback
to the session's own model (that would silently bill the reasoning model at full
price).

### The model chain has a fixed order, and the alias rung is tried first

Explicit pin → live local llama-swap → `synthetic/syn:small:text` →
`synthetic/hf:zai-org/GLM-4.7-Flash` → the host's cheap-model tier → `ctx.model` →
disable for the session. A candidate is usable only if
`ctx.modelRegistry.find(provider, modelId)` resolves; nothing is self-registered
to make a rung work.

The alias is tried **first and skipped on a miss** on purpose: the upstream fact
table names `syn:small:text` as the provider's `default_small_model_id`, while
this repo's generated `coding-agent/model-019-cloud-synthetic.json` emits only the
canonical GLM row. The reverse order would make the summarizer look unavailable on
the container's own generated config. Whether to close that generator gap is left
open (below) — deliberately not silently "fixed" by hand-editing a generated file.

### Two deliveries over one core, and session files are read-only

The core is `entries → summary text`, dependency-free, so both deliveries are
thin: an in-chat `custom` entry (TUI renderer + one ThinkRail web row) and a
sidecar `<session>.reasoning.jsonl` for backfill, re-summarization with another
model, and audit. The sidecar reads pi JSONL through `SessionManager.open()`,
walks to a leaf, and writes **beside** the session — never into a file a live
session has open, because there is no channel to the session holding it: d124
finds that sessions share only disk state, never control, so a second writer
cannot learn the live leaf before writing it and the entry tree would be
corrupted. Being able to read a session is not permission to write into it — the
sidecar is the only place a second writer can live, beside the file and never
inside a live tree.

### Configuration precedence and a three-command surface

`env > .pi/summarized-reasoning.json > builtin`, flat and fully optional; an
explicit `provider` + `model_id` replaces the candidate chain. The commands are
`/reasoning-summary` (toggle, default on), `/reasoning-summary-test` (one call,
prints, writes nothing) and `/reasoning-summary-model <provider/modelId>` (pin;
empty args reset). Toggling is a *rendering* decision — it can change what a human
sees and can stop new writes, but it can never change what the model sees, because
nothing this extension writes is model-visible.

### Placement: the note stays a `coding-agent` living doc, the folder is not a node

`coding-agent/summarized-thinking.md` keeps its id and its `parent: coding-agent`
edge and stays where docs/d117 requires a single-unit living doc to sit; the new
folder carries a plain package README, no frontmatter — the split docs/d096 uses
for `pi-synthetic`. This record is the decision home that the note is *not* (a
living doc argues; a record decides), which is why the two do not duplicate each
other and both point here.

## Consequences

- A long turn keeps its earlier folded thinking cards for the rest of the window;
  only the final answer carries the chain summary. Folding several cards per turn
  is a rendering problem worth zero tokens, so it stays in the renderer (or
  unbuilt) rather than becoming a context rewrite.
- The summary is not selectable, searchable or quotable by the model — permanently.
  That is the design, and it is also the one request a user may plausibly make
  ("let the model see it") that this extension refuses.
- ThinkRail needs one web change to show the card: the entry arrives in
  `getSessionMessages` (whose transcript roles include `custom`) but the live
  `entry_appended` event carries only `{ entryType }`.
- Every future feature is cheap to evaluate: "does it add anything to the model
  context?" is a yes/no gate, and the answer is no.
- The extension is a `pi-*` package like the rest of the family, so installing,
  trusting and removing it are the family's ordinary operations (docs/d100,
  docs/d116).

## Alternatives rejected

- **Thinking-block replacement at `message_end`** (the first draft). Mechanically
  works in pi 1.5.0 and is cache-free, but it makes a paraphrase the reasoning
  that produced the answer, which every later turn then re-reads as the model's own.
- **Chain rewrite through `context_edit` at `turn_end`** (the second draft).
  Preserves meaning and shrinks the context, and is the one design whose cost is
  invisible in a diff — it pays a full re-prefill per turn (see the cache rule).
- **A `custom_message` digest fed back as a `user` message.** The summary is
  bookkeeping for a person; injecting it every turn asks the model to reason around
  noise, and cheap models may read it as fresh instructions.
- **An external-only sidecar tool.** Attractive (retroactive coverage, model
  comparison, absolute no-leak guarantee) but it lives beside the chat, needs
  credentials and polling, and cannot present a card in the transcript. Kept as a
  second delivery over the same core instead of as the architecture.
- **An in-process-only extension with the summary as thinking.** Reuses pi's own
  rendering path for free, at the cost of the entire cache argument above.

## Verification status

Source-level only, and that is all that exists: the entry semantics, the boundary
draft contract, the compaction projection and ThinkRail's event/transcript paths
were read in pi 1.5.0 and ThinkRail source (citations in
`../pi-summarized-thinking/FINDINGS.md`). No runtime behaviour has been observed,
because nothing is built. Two upstream assumptions are explicitly unresolved
there (`getApiKeyAndHeaders` field names on 1.5.0; whether `syn:small:text`
resolves against the generated catalogue).

## Open decisions

Tracked in `../pi-summarized-thinking/TODO.md`, not decided here: whether the
generator should emit the `syn:*` alias; whether the ThinkRail row is worth the
web change or the sidecar delivery alone suffices; and the exact schema of the
sidecar file. None of them can break the decisions above — that is the point of
listing them separately.
