# AGENTS.md — pi-summarized-thinking

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
(a folder is a copy unit) is in `../docs/architecture.md`. What follows is only
what is specific here.

## The one rule: this extension never changes the model's context

Every other rule below is a consequence. A summary is a `custom` entry; the
model that produced the turn never sees it, in this turn or any later one.

- **No `custom_message`, no `context_edit`, no system-prompt fragment, no
  injected tool result.** If a feature needs the model to read the summary, that
  feature belongs in another extension, and its cost is a full cache re-prefill
  per turn (`FINDINGS.md` → "The cache rule").
- **Append-only, at the tail.** Never prepend, never insert between an assistant
  tool-call message and its results.
- **Write-once.** A summary is immutable once written; a reload, a retry or a
  re-run must not regenerate it.
- **The regression that matters is byte equality.** The sharpest test for any
  change here: run a turn with the extension loaded and off, and compare the
  serialized `llmMessages` the provider would receive. If they differ, the change
  is wrong, however good the card looks.

## The audience is the human

Summaries exist so a person can audit a long turn without reading raw CoT. Do not
"improve the model" by feeding a summary back — the model needs its own reasoning
to produce correct output, and a paraphrase of it is strictly worse input than no
input. This is also why the summarizer runs as a plain `complete()` call and never
as an agent turn: its tokens are not the session's tokens, and nothing about it
needs to be hidden.

## Cheap and bounded

One call per completed turn. A small `maxTokens`, temperature 0, reasoning off,
an abort signal, and a timeout. A failed summary is a missing card — never a
failed turn, never a retry loop, never a fallback to the session's own model
(that silently bills the reasoning model at full price).

## The model chain is data, in one place

Order: explicit pin → local llama-swap → `synthetic/syn:small:text` →
`synthetic/hf:zai-org/GLM-4.7-Flash` → host cheap tier → `ctx.model` → disable.
Candidates live in one list, so adding or reordering a rung is one edit. A
candidate is usable only if `ctx.modelRegistry.find(provider, modelId)`
resolves; never register a provider to make a candidate work. `syn:small:text`
must be tried **first and skipped on miss** — the generated
`../coding-agent/model-019-cloud-synthetic.json` does not emit the alias.

## Reading sessions is read-only

The backfill/sidecar path opens pi JSONL with `SessionManager.open()` and walks
the branch to a leaf. It **never** appends into a session file a live session has
open: the live in-memory leaf would diverge and the tree would corrupt. It writes
beside the session, not into it.

## Render defensively

Entry `data` is a persisted schema read back by a later version of this extension.
Render from the fields that are present, degrade to "summary unavailable", and
never assume a field exists — a session written by today's build is loaded by
next month's.

## `FINDINGS.md` is not `PENDING.md`

`FINDINGS.md` is durable reference: pi/ThinkRail contracts with their source
symbols, the cache argument, and the superseded claims. It is meant to be cited
and kept current. `PENDING.md` does not exist here — create it only for an
in-flight collision (a change rewriting these files while you also need to), not
for ordinary open work, which is `TODO.md`'s job.

## The folder is the package

`index.ts`, `package.json` and this folder's docs at this level ARE the pi
package, like `../pi-synthetic/`. `index.ts` stays out of `tsconfig.json` for the
same reason it is there: it imports `@earendil-works/pi-coding-agent`, which this
repo does not vendor.

The *why* is not written here: `../coding-agent/summarized-thinking.md` is the
design note (a node with `parent: coding-agent`, where docs/d117 places a living
doc for this unit), and this folder's `README.md` is a package README, not a
graph node — the same split `../pi-synthetic/` uses with docs/d096.

The decisions are `../docs/d125-summarized-thinking-decisions.md`, and they are
not advisory. If a change here needs one of them reversed, the record is edited
first (or amended), with the reason — the folder docs and the note follow it, not
the other way around.

Nothing is implemented yet — this folder is the design of record, so a change
that adds code also updates `README.md`'s "Where the summary goes" and `TODO.md`
in the same pass.
