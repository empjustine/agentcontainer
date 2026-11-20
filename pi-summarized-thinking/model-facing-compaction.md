---
id: model-facing-compaction
type: module-design
status: draft
title: "model-facing compaction — the verified pi and LLMLingua contracts for the other audience"
parent: pi-summarized-thinking
depends-on: [d125]
references: [summarized-thinking]
tags: ["design", "pi-extensions", "compaction", "llmlingua"]
---

# Model-facing compaction — the other audience

This note records the verified contracts for the opposite audience: compression that
shrinks what the model reads, rather than a card for the person reading the
transcript. This package refuses that design — its one rule is that nothing enters
the model context — so the facts live beside the refusal, and a model-facing
compressor would be another package. It is not a build order: `TODO.md` owns this
package. The reader is deciding whether context compression belongs anywhere near
this folder, and arrives knowing the cache rule in
[`summarized-thinking.md`](summarized-thinking.md).

## Status

Research. The pi facts were checked against `packages/codemode` and
`docs/extensions.md`; the LLMLingua facts against its upstream source. Nothing is
implemented.

## Two audiences, one word

|                     | This package                        | A model-facing compressor           |
| ------------------- | ----------------------------------- | ----------------------------------- |
| What is written     | `custom` entry, `reasoning-summary` | the messages the provider receives  |
| Who reads it        | the person                          | the model                           |
| Provider bytes      | identical to running nothing        | fewer tokens, a different prefix    |
| Cost of being wrong | a missing or dull card              | a wrong edit the model reasons from |

The design note argues that a paraphrase of the model's own reasoning is worse
input than no input. That argument is about _replacing reasoning the model
produced_; it does not forbid _shortening tool output the model never needed
verbatim_. The distinction is content, not vocabulary, and it changes nothing in
this package: its summaries stay invisible to the model either way.

## The pi surface that path uses

- **Rewrite points.** `context` receives the conversation before each LLM call
  and may return a changed list; `context_with_system` receives the full
  transcript including the prompt; `tool_result` rewrites one result in place.
  A compression step fits at `tool_result` or `context`; both run before the
  request is sent.
- **Ordering against built-in compaction.** pi projects the context after tool
  results are appended, checks the threshold there, and compacts in
  `prepareNextTurn`. Shrinking a result at `tool_result` therefore moves the
  trigger instead of racing it, and the projection sees the shrunken text.
- **The tool surfaces.** `pi.registerTool()` and `pi.registerCommand()` are how a
  restore or a manual compaction becomes callable.
- **The sandbox.** Codemode runs QuickJS compiled to WASM (`quickjs-wasi` 3.6.2),
  a fresh VM per call, with no filesystem, network or timers; `store`/`load`
  carry small JSON between calls, and a call's output is what the script adds
  through `text()`, `image()`, `console.log` and its top-level `return`.

## LLMLingua, as verified

| Fact                | Value                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Language            | Python only; no TypeScript binding upstream                                                                                  |
| Entry point         | `PromptCompressor(model_name=…, device_map=…, use_llmlingua2=…)`                                                             |
| LLMLingua-2         | `use_llmlingua2=True` with a classifier checkpoint                                                                           |
| Checkpoints         | README's primary `microsoft/llmlingua-2-xlm-roberta-large-meetingbank`; smaller `…-bert-base-multilingual-cased-meetingbank` |
| Tuning per call     | `rate`, `force_tokens`                                                                                                       |
| Force-token ceiling | the LLMLingua-2 path asserts `len(force_tokens) <= max_force_token` (default 100)                                            |
| Device              | the constructor defaults `device_map` to `cuda`; a CPU sidecar passes `device_map="cpu"`                                     |
| Default model       | `NousResearch/Llama-2-7b-hf` for the non-LLMLingua-2 path; `microsoft/phi-2` is the lighter option                           |
| Per-section rates   | `structured_compress_prompt` exists; it was a later increment in this research                                               |

## The cache bill

The rule in the design note is not a preference: provider caching is a prefix
hash, so every token after the first change is processed and billed again.
Compression at `tool_result` lands before the bytes are sent, so that edit costs
nothing at the moment it happens and becomes the prefix every later turn reuses.
A restore does the opposite — it changes content the provider has already seen —
and that is a re-prefill of the suffix, worth stating in the tool result that
performs it. Determinism is the precondition for any of it: the same input must
yield the same bytes, or the compressed prefix is never reusable.

This package pays none of that bill, and that is the whole reason it writes a
`custom` entry instead of editing messages.

## What does not transfer

- **The word.** A human-facing summary is an overlay; a model-facing compaction is
  a replacement for input. Neither is evidence for the other.
- **The corpus.** LLMLingua is trained on natural language (MeetingBank for the
  LLMLingua-2 classifier). Code, unified diffs and JSON tool payloads are out of
  distribution, so exempting them may consume the savings entirely.
- **The force list.** With a 100-token ceiling, protecting every identifier a diff
  needs is not possible; the ceiling is the design constraint, not a tuning knob.
- **The ledger.** Restore-on-failure and a provenance ledger are model-facing
  features. They belong to the other package, and they must not appear here.

## References

- pi: `packages/codemode/package.json` (`quickjs-wasi`), `docs/codemode.md`,
  `docs/extensions.md` (`context`, `context_with_system`, `tool_result`),
  `docs/compaction.md` (threshold, `prepareNextTurn`)
- LLMLingua: [README](https://github.com/microsoft/LLMLingua),
  [`prompt_compressor.py`](https://github.com/microsoft/LLMLingua/blob/main/llmlingua/prompt_compressor.py)
- The refusal this note sits beside: [`summarized-thinking.md`](summarized-thinking.md) and
  [`TODO.md`](TODO.md)
