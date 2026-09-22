---
id: d049
type: architecture-design
status: proposed
title: "d049 — modality/input capability as allowlists everywhere, not name filters/denylists"
parent: coding-agent
depends-on: [coding-agent, lib]
references: [d033, d046b, d047, d040]
tags: ["coding-agent", "modalities", "allowlist", "filter", "models.json"]
---

# d049 — modality/input capability as allowlists everywhere

status: proposed (nothing decided, nothing implemented) · relates-to:
d033, d046b, d047

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

## Current state (as implemented)

| Layer | Where | Vocabulary | Effect |
|---|---|---|---|
| Eligibility | `PEER_MODEL_FILTERS` `(id, record?) => boolean` | name-shaped for openrouter, mistral; modality allowlist for google | whether the id enters the emitted layer at all |
| Projection | `toInput()` × 2 | text+image allowlist applied to whatever survived | emitted `input` array is schema-legal |

The projections already agree. The **eligibility** gate does not: it is
per-provider, name-shaped, and mixes a modality allowlist (google) with a
name denylist (mistral) and a name allowlist (openrouter). A new non-chat
category on a denylist provider has to be discovered after it leaks into a
generated `models.json` (d046b's failure mode).

## Proposed change (not scheduled)

Make **modality capability the primary, uniform allowlist axis**, with name
checks demoted to declared, named exceptions:

1. **One allowlist declaration of the driving client's capability** — the
   accepted input-modality set and output-modality set the agent can drive
   (for the pi pipeline: `input ⊆ {text, image}`, `output == {text, and only
   text}`), applied to **every** model of **every** provider. The provider
   spec only supplies the records to judge; `PEER_MODEL_FILTERS` stops being
   a bag of `(id) => boolean` regexes and becomes "does this record's
   `modalities.{input,output}` fit the client allowlist?".
2. **Name checks become explicit exceptions**, not the mechanism — each one
   annotated with the metadata gap it papers over (today: `/embedding/`
   for google, below), so the exceptions are the visible set and everything
   else is allowlist-driven.
3. **`toInput()` collapses to one shared projection** derived from the same
   declaration the eligibility gate reads (d046b already flags the two
   implementations as "possible future cleanup"). Eligibility and emission
   then cannot disagree about what a provider admits.
4. **The fail mode flips closed.** An unrecognized modality or a new
   non-chat endpoint is refused by default (the d047 "deny-by-absence"
   philosophy) instead of leaking until a strict consumer rejects the file.
   The cost is the mirror image: a legitimate new chat model whose modality
   label is not in the allowlist is dropped until the generator learns it.
   That "cost" is smaller than it sounds — see the next section.

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

To be concrete about what is *not* being asked for: any model whose
declared input or output modality does not fit the driving agent's schema is
out, whatever its id, family, or provider; a model is admitted only when its
declared modality fits. That is the whole rule.

## The known blocker: metadata that lies

models.dev labels the embedding endpoints' output modality `["text"]` (they
return text-ish vectors, not chat). A pure modality allowlist therefore
**admits embeddings**, which is why google's allowlist still carries the
`/embedding/` name denylist first (d033). Any "allowlists everywhere" change
must resolve this, in one of:

- a declared non-chat marker in the fact table (a `family`/kind the allowlist
  can refuse) so the name check is retired rather than generalized; or
- an explicit, documented per-provider name exception (the status quo,
  generalized) — cheaper, but keeps the denylist the thing drift hides in.

A second, smaller gap: the live-listing path calls the filter with the id
only (`listingModels` → `filter?.(e.id)`), so a modality allowlist cannot
judge it unless the listing carries reliable `architecture.input_modalities`.
`piModel()` already reads that field, so the data exists — resolving whether
it is trustworthy for every provider is part of the work.

## Open questions

- Is the client capability (`input ⊆ {text, image}`, out `{text}`) one
  pipeline-wide constant for the main agent, or derived per target harness
  (pi vs opencode vs cline differ)? Today the main agent is pi-coding-agent,
  so it is the pi schema — but which client the emission serves is the thing
  that decides it.
- Does the embedding-metadata gap get fixed upstream-first (contribute a
  kind/marker to the vendored catalog) or papered over here?
- Does eligibility (drop the model) and projection (drop the modality) ever
  need to differ, or can one declaration serve both (item 3 above assumes
  one)?
- `openrouter`'s `:free` scoping and `d040`'s curated `modelAllowlist` are
  *access/price* allowlists, not modality ones — confirm they stay out of
  this change rather than being folded into one "allowlist" concept.

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
  `catalogPiModel`), `coding-agent/gen-lib.mjs` (`piModel`, `toInput`).
