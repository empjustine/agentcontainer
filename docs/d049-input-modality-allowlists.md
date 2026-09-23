---
id: d049
type: architecture-design
status: implemented
title: "d049 — modality/input capability as allowlists everywhere, not name filters/denylists"
parent: coding-agent
depends-on: [coding-agent, lib]
references: [d033, d046b, d047, d040]
tags: ["coding-agent", "modalities", "allowlist", "filter", "models.json"]
---

# d049 — modality/input capability as allowlists everywhere

status: implemented (2026-09-23) — pipeline-wide constant, metadata-rich
sources only, opencode out of scope, documented name exception for the
embedding gap, admit-but-trim · relates-to: d033, d046b, d047

## Change (implemented 2026-09-23)

- **`coding-agent/gen-lib.mjs`** owns the single declaration now:
  `PI_MODALITY_CAPABILITY` (frozen: input `{text, image}`, output `{text}`),
  `modalitiesEligible` — the admit-but-trim **gate** (judge only the
  dimensions the record carries: declared input must include the drivable
  core, declared output must stay inside the capability; unjudgeable
  dimensions pass, per the scope decision above) — and the one exported
  **`toInput`** projection (intersection with the capability, capability
  order, drivable-core fallback). The second, contract-identical copy in
  `generate-pi-coding-agent.mjs` was deleted; both former callers read the
  export.
- **`generate-pi-coding-agent.mjs`** composes the gate **first** at every
  record-backed eligibility site — `catalogModelIds`' catalog slice,
  `emitMinimalCatalogOverride`'s catalog slice, `listingModels` on the typed
  input surface — and inside `catalogPiModel`, the full-mode choke. What
  stays in `PEER_MODEL_FILTERS` are the annotated exceptions and access
  scopes: google's `/embedding/` and `catalogPiModel`'s embedding
  family/id check (the documented name exception above), mistral's
  `/embed|tts/` (kept as the reviewed exception set), openrouter's `:free`
  (access, runs after the gate). Google keeps its full modality predicate
  so the filter stays correct when called without the gate composition.
- **Trust check (the one item this doc previously left open):** a full
  dry-run regeneration, every drop attributed against
  `lib/models.dev.api.json` — **17 ids dropped, all gate-justified**
  (audio-only in: `voxtral-mini-latest`, whisper; video in/out: nvidia's
  detection/cosmos/sparsedrive lines; image or audio out: flux,
  qwen-image, magpie-tts), **zero chat-capable models refused**, and
  **zero input-array changes** against the committed manifests — the two
  projections really were behavior-identical, as d046b guessed. The
  catalog's known lie (embeddings labeled `output:["text"]`) is covered by
  the name exceptions, as decided.
- **Contract test:** `tests/modality-allowlist.test.mjs` pins the gate's
  three halves (refuse / admit-and-trim / pass-unjudgeable), the
  capability-order projection, and the agree-by-construction property.
- Not written back: the real regeneration lands with the next full
  generator run — the working tree carries unrelated in-flight manifest
  edits this change must not tangle with. Audit note: under `DRY_RUN`,
  `mergeModels` merges the *committed* layer files (previews do not match
  its `model-*.json` glob), so audit the layer previews directly, as this
  check did.

## Motivation

Today a model's *right to be in a generated lineup* is decided in two
different vocabularies, and only one provider uses the safer one:

- **Name-based filters** (`PEER_MODEL_FILTERS`,
  `coding-agent/generate-pi-coding-agent.mjs`): `mistral` is admitted iff its
  id does **not** match `/embed|tts/i` (a denylist); `openrouter` iff its id
  **ends with** `:free` (a name allowlist, but still a name, not a
  capability). A denylist names a category to exclude, so a category nobody
  thought of is admitted by default. That is exactly the leak d033 records:
  the pre-`catalogOnly` `^gemini-` regex dropped image/tts/live ids by
  accident and admitted other non-chat ids by accident.
- **One modality allowlist** (`google`): admitted iff the models.dev record
  takes `text` in and produces exactly `["text"]` out. This names the
  property that actually matters — pi drives text chat, so a model is
  eligible iff its modality set is a chat set — and one rule drops
  imagen/veo/lyria/tts/live/omni and the audio-only live-translate at once,
  independent of their ids.

The `google` rule is not a google fact. It is the general rule: "does this
model deliver a modality set the client can actually drive?" Every other
provider only approximates it with a name regex over its own id dialect.
The two `toInput()` implementations (`coding-agent/gen-lib.mjs` and
`coding-agent/generate-pi-coding-agent.mjs`, contract-identical per d046b)
are the same rule expressed a third time, as a hard schema projection rather
than an eligibility gate.

## Current state before this change (name-shaped eligibility)

| Layer | Where | Vocabulary | Effect |
|---|---|---|---|
| Eligibility | `PEER_MODEL_FILTERS` `(id, record?) => boolean` | name-shaped for openrouter, mistral; modality allowlist for google | whether the id enters the emitted layer at all |
| Projection | `toInput()` × 2 | text+image allowlist applied to whatever survived | emitted `input` array is schema-legal |

The projections already agree. The **eligibility** gate does not: it is
per-provider, name-shaped, and mixes a modality allowlist (google) with a
name denylist (mistral) and a name allowlist (openrouter). A new non-chat
category on a denylist provider has to be discovered after it leaks into a
generated `models.json` (d046b's failure mode).

Scope note (decided 2026-09-23): `generate-opencode.mjs` carries its own
`PEER_MODEL_FILTERS` (openrouter `:free` only) and is **out of scope** —
this change is the pi pipeline only; the table above lists pi-side layers.

## Proposed change (decided and implemented 2026-09-23)

Make **modality capability the primary, uniform allowlist axis**, with name
checks demoted to declared, named exceptions:

1. **One allowlist declaration of the driving client's capability** — the
   accepted input-modality set and output-modality set the agent can drive
   (for the pi pipeline: `input ⊆ {text, image}`, `output == {text, and only
   text}`), applied to **every** model of **every** provider. **Decided
   2026-09-23: one pipeline-wide constant**, not a per-harness derivation —
   with the opencode emission out of scope, the driving client is pi alone.
   The provider
   spec only supplies the records to judge; `PEER_MODEL_FILTERS` stops being
   a bag of `(id) => boolean` regexes and becomes "does this record's
   `modalities.{input,output}` fit the client allowlist?".
2. **Name checks become explicit exceptions**, not the mechanism — each one
   annotated with the metadata gap it papers over (today: `/embedding/`
   for google, below), so the exceptions are the visible set and everything
   else is allowlist-driven.
3. **`toInput()` collapses to one shared projection** derived from the same
   declaration the eligibility gate reads (d046b already flags the two
   implementations as "possible future cleanup"). **Decided:
   admit-but-trim** — one declaration, two defined roles (the gate admits
   what is drivable after trim, the projection performs the trim), so
   eligibility and emission read one source of truth instead of two copies
   of the same rule.
4. **The fail mode flips closed.** The gate refuses what cannot be driven —
   declared input with no drivable text, declared output not exactly
   `{text}` — and the projection refuses what must not be emitted: under
   deny-by-absence (the d047 philosophy) only allowlisted input entries
   survive, so an unrecognized modality is trimmed rather than leaking into
   a schema the consumer rejects. The cost is the mirror image: a
   legitimate new chat model whose modality label is missing or unreadable
   is trimmed or dropped until the generator learns it. That "cost" is
   smaller than it sounds — see the next section.

## The allowlist is the driving client's capability, and it runs FIRST

This allowlist is **not** a judgement about which modalities are legitimate
in the world. It is the capability of the coding agent that will drive the
model — today the main agent is still pi-coding-agent, so the usable
modalities are pi's own input schema (text+image in, text out). A brand-new
modality that the agent cannot drive is **not a loss to the user use case
when it is dropped** — it is a model that could never have been used through
this pipeline anyway. "Legitimately-new labeled modalities" therefore is not
a reason to loosen the gate; the gate's job is to keep exactly the models
the agent can actually drive, and refuse the rest.

Consequence for ordering: this modality gate should run **before any other
filter, for every model, whenever the metadata is available**. Name-based
checks are the fallback for records whose modality is missing (today google's
no-record path), never the first word. Doing it first and uniformly means a
provider can never leak a non-chat model through its own name dialect, and
the "did we remember to deny category X for provider Y?" question disappears.

To be concrete about what is *not* being asked for: a model whose declared
input offers no drivable text, or whose declared output is not exactly
`{text}`, is out — whatever its id, family, or provider. Everything else is
in, and what it offers beyond the driving schema (an extra `audio` input,
say) is trimmed at emission rather than held against it — **admit-but-trim**
(decided 2026-09-23). That is the whole rule.

## The known blocker: metadata that lies (resolved 2026-09-23)

models.dev labels the embedding endpoints' output modality `["text"]` (they
return text-ish vectors, not chat). A pure modality allowlist therefore
**admits embeddings**, which is why google's allowlist still carries the
`/embedding/` name denylist first (d033). Any "allowlists everywhere" change
must resolve this, in one of:

- a declared non-chat marker in the fact table (a `family`/kind the allowlist
  can refuse) so the name check is retired rather than generalized —
  **not taken** (moves the maintenance upstream without removing the
  exception class); or
- an explicit, documented per-provider name exception (the status quo,
  generalized) — **chosen**: each exception sits beside the modality gate,
  annotated with the metadata gap it papers over, so the set is visible and
  reviewed (item 2 above). It stays load-bearing under admit-but-trim: a
  lying `output:["text"]` record passes the gate, and this check is what
  drops it.

Scope decision (2026-09-23): the modality gate judges **metadata-rich
sources only** — the models.dev catalog, the catwalk and hyper facts caches,
and the llama-swap listing. Non-rich sources are not enriched to make them
judgeable: no modality metadata gets appended to their model records, so the
id-only call sites (`listingModels` → `filter?.(e.id)`) are not a gap to
close by fetching or deriving more metadata. What remains before
implementation is only a trust check on the rich sources' own modality
fields. — DONE 2026-09-23 with the implementation: see the Change section
(full-regeneration drop attribution; no chat-capable model refused).

## Decisions (all settled 2026-09-23)

- Is the client capability (`input ⊆ {text, image}`, out `{text}`) one
  pipeline-wide constant for the main agent, or derived per target harness
  (pi vs opencode vs cline differ)? — **decided 2026-09-23: pipeline-wide
  constant** (pi schema); the opencode emission is out of scope.
- Does the embedding-metadata gap get fixed upstream-first (contribute a
  kind/marker to the vendored catalog) or papered over here? — **decided
  2026-09-23: documented per-provider name exception** (see the resolved
  blocker section); the fact-table marker was considered and not taken.
- Does eligibility (drop the model) and projection (drop the modality) ever
  need to differ, or can one declaration serve both? — **decided
  2026-09-23: admit-but-trim** (item 3): one declaration, two roles — the
  gate admits anything drivable (declared input contains text AND declared
  output is exactly `{text}`), the projection trims declared input down to
  `{text, image}` at emission. They cannot drift: both read the same
  constant.
- `openrouter`'s `:free` scoping and `d040`'s curated `modelAllowlist` are
  *access/price* allowlists, not modality ones — **decided 2026-09-23:
  they stay out** of this change; access/price stays orthogonal and runs
  after the modality gate, not folded into one "allowlist" concept.

## References

- `docs/d033-generator-cascade.md` — the filter rationale and the leaked-id
  history; google's modality allowlist.
- `docs/d046b-live-listing-input-schema-poisoning.md` — the schema-projection
  guard and the two-`toInput` note.
- `docs/d047-llm-reverse-proxy-host-allowlist.md` — deny-by-absence as the
  repo's house philosophy.
- `docs/d040-cline-pass-curated-lineup.md` — the curated id allowlist, the
  non-modality allowlist this change does not absorb.
- `coding-agent/generate-pi-coding-agent.mjs` (`PEER_MODEL_FILTERS`,
  `catalogPiModel`), `coding-agent/gen-lib.mjs` (`PI_MODALITY_CAPABILITY`,
  `modalitiesEligible`, `toInput` — the landed declaration, gate, and
  shared projection).
- `tests/modality-allowlist.test.mjs` — the contract the implementation
  must keep (refuse / admit-and-trim / pass-unjudgeable /
  agree-by-construction).
