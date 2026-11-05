# TODO — pi-summarized-thinking

Open items, in the order they can be worked. Nothing is implemented: the package
is a skeleton validated against pi and ThinkRail source, not a running extension.
The design rationale is [`summarized-thinking.md`](summarized-thinking.md),
the decisions are [`../docs/d125-summarized-thinking-decisions.md`](../docs/d125-summarized-thinking-decisions.md)
(settled — an item below that needs one of them changed says so), and the
contracts are [`FINDINGS.md`](FINDINGS.md). Each item says what "done" looks like
and what is already settled, so a future session does not re-derive it.

## 1. The core, with no pi in the tests

`summarizeTurn(entries, options) → { summary, coveredEntryIds, model }` as a pure
function over session entries: it picks the turn off a branch, builds the
prompt from thinking + a truncated tool ledger + a grounding snippet, and returns
text. **Done** = unit tests over fixture entries (no model call, no pi import)
covering: a turn with three tool calls, a turn with no thinking at all, a turn cut
short by an abort (`outcome: "aborted"` → no summary), a turn whose thinking is
already a summary of an older one.

Settled: one call per turn, `coveredEntryIds` for write-once, the entry shape
`{ turnId, coveredEntryIds, summary, model }`.

## 2. The extension itself

`index.ts` with `package.json`, following `../pi-synthetic/`. **Done** = a real
pi turn writes a `custom` entry (`customType: "reasoning-summary"`), the TUI
renders it through `registerEntryRenderer`, and the three commands work
(`/reasoning-summary`, `/reasoning-summary-test`, `/reasoning-summary-model`).

Settled: append via a `turn_end` boundary draft of kind `custom` (atomic with the
boundary, `pi.appendEntry` equivalent); config precedence env >
`.pi/summarized-reasoning.json` > builtin; the model chain order in `README.md`.

Watch: `_refreshFinalizedContext()` re-derives `agent.state.messages` from the
projection after drafts are committed — confirm a `custom` draft neither shifts
an existing entry id nor reorders the transcript.

## 3. The regression test that justifies the whole design

A test that runs one turn twice, extension on and extension off, and asserts the
serialized `llmMessages` handed to the provider are identical. **Done** = it
fails if anyone later adds a `custom_message`, a `context_edit`, or a
system-prompt fragment. This is the test the design exists to keep green.

## 4. ThinkRail: one row, and the live payload

A summary written at `turn_end` is **invisible in ThinkRail** until two web
pieces exist: `apps/web/src/store/appStore.ts` (map the new `customType`) and
`apps/web/src/chat/hydrate.ts` (`messagesToRuntime`, same mapping for reloads).
The live event is thin — `sessionEventProjection.ts` emits `entry_appended` with
`{ entryType }` only — so either widen that payload or refetch on settle
(`getSessionMessages` already returns `custom` roles via
`TRANSCRIPT_MESSAGE_ROLES`).

**Done** = a turn's card appears in the web transcript, survives reload, and the
entry is not double-rendered by both the entry path and the message path.

Also unresolved by docs/d125 on purpose: whether the card is worth this web change
at all, or the sidecar delivery (item 5) is enough for the audit use it serves. If
the answer is "not worth it", this item closes as rejected and docs/d125's `Open
decisions` shrinks by one — a re-plan, not a new record.

Decide: `packages/server/src/extensions/catalog.ts` records tool names through an
inert proxy, so a command-only extension has nothing to catalog — confirm it
still appears sensibly in Settings → Extensions, or ship it as a plain package
loaded from the agent dir with no ThinkRail wrapper at all.

## 5. Sidecar / backfill CLI

Read sessions with `SessionManager.open(path)`, walk to the leaf, summarize every
completed turn, write `<session>.reasoning.jsonl` beside the file. **Done** = it
runs over a directory of existing sessions without touching them, and a
re-summarization with a different model produces a second sidecar rather than an
edit. Re-read the read-only rule in `AGENTS.md` before writing any of it.

Blocked on item 1 (the core must be importable without pi's extension runtime —
that is the point of keeping it dependency-free).

## 6. Verify the two upstream assumptions

- `ctx.modelRegistry.find("synthetic", "syn:small:text")` on the container's own
  generated `models.json` — expected to **miss** (the alias is absent from
  `../coding-agent/model-019-cloud-synthetic.json`) and fall through to
  `hf:zai-org/GLM-4.7-Flash`. If it resolves, the fallback rung is dead weight
  and `FINDINGS.md` needs correcting.
- `getApiKeyAndHeaders(model)` on pi **1.5.0** (ThinkRail's pin). `getApiKey` is
  gone; the replacement's field names were reported upstream, not read off 1.5.0
  typings.

## 7. The catalogue gap, if it is one

`coding-agent/lib/catwalk-facts.json` publishes `syn:small:text` as the
provider's `default_small_model_id`, but `generate-pi-coding-agent.mjs` emits only
the canonical `hf:…` row. Either the alias should be emitted too (a generator
change, with its own tests) or the alias-first order is permanently a miss and
should be documented as such. **Do not** hand-edit the generated
`model-019-cloud-synthetic.json`.
