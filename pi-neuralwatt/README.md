---
id: pi-neuralwatt
type: module-design
status: active
title: "pi-neuralwatt — the Neuralwatt adapter as a pi package: two tier providers, catalog from /v1/models, compat from the published docs"
parent: architecture
references: [d057, d070, d074, d096, d100, d190, d191, d192]
tags: [pi, extensions, providers, neuralwatt, adapter, compat, flex]
---

# pi-neuralwatt — the Neuralwatt adapter as a pi package

Two registrations, one vendor: `neuralwatt-flex` and `neuralwatt-standard`
serve the same models at the two tiers the provider sells. The catalog comes
from `GET https://api.neuralwatt.com/v1/models` on every refresh, and the
fields that listing cannot express come from the vendor's published
documentation, cited per field. This file is the design record; `AGENTS.md`
carries the folder rules.

## What the package registers

| Provider id           | Lineup                                                                | Prices         | Request body                                        |
| --------------------- | --------------------------------------------------------------------- | -------------- | --------------------------------------------------- |
| `neuralwatt-flex`     | chat rows the listing proves Flex-capable (a `<id>-flex` twin exists) | the twin's own | `samplingParams: { service_tier: "flex" }`          |
| `neuralwatt-standard` | every served chat row, including the Flex-capable ones                | the row's own  | nothing — absence of the field IS the standard tier |

Both publish the **standard** model id. The tier is a request field, not a name,
so the wire model name — and the shared server-side prefix cache — is unchanged
across a tier switch (`/guides/flex-tier#prompt-caching-and-model-names`). The
split is the extension's own pick, not a user decision per model; two
registrations from one entry follow the pi-opencode precedent (docs/d100).

**Is not**, deliberately, each for a reason already paid for elsewhere:

- **no energy or cost tracking.** The host's `pi-ai` has no energy field, so a
  display would mean a custom `api` plus a per-request fetch tee — the
  mechanism that resurrects the stale-cache, tee-cancellation and replay bugs
  the other provider extensions carry. Out of scope entirely.
- **no quota command, no settings UI, no status widget.** Account reads
  (`/v1/quota`) are a UI feature, not a provider capability.
- **no committed lineup, no seed, no fallback.** The listing is the only source
  and an unreadable source throws (d190/d192).
- **no decision or embedding models.** `metadata.capabilities.task` present
  means the row is not a chat model — the docs say so and that
  `/v1/chat/completions` answers it with a 400. pi has a classifier arm
  (`typesafe-system-one`, and Neuralwatt's `/v1/systemone` is documented as
  System One-compatible), but the composer requires the extension to supply that
  transport itself: a second wire surface for a model this folder does not need.
  Registered as an open item, not built.
- **no `/v1/messages` or `/v1/responses` surface.** Both exist upstream; a
  second wire surface is a second adapter.
- **no request-shaping stream wrapper**, except the one documented merge in
  [The one request-shaping step](#the-one-request-shaping-step).

## Documentation references

Neuralwatt publishes a documentation MCP server. It is a **reference for what to
build**, not a feature of the extension: nothing here reads it at runtime. Both
endpoints resolve (verified: `GET` + JSON-RPC `initialize`/`tools/list` over
HTTP, no auth):

| Reference                                     | What it answers                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `https://docs.neuralwatt.com/.well-known/mcp` | the discovery document — `{"version":"1.0.0","transport":"http","url":"https://docs.neuralwatt.com/mcp","servers":[{"name":"public","url":"https://docs.neuralwatt.com/mcp","transport":"http","authentication":"none"}]}`     |
| `https://docs.neuralwatt.com/mcp`             | the MCP server itself (`2025-06-18`, stateless): `search_neuralwatt`, `query_docs_filesystem_neuralwatt` (read-only docs pages + `/openapi/openapi.yaml`), `submit_feedback`, plus the `mintlify://skills/neuralwatt` resource |

Every `docs.neuralwatt.com/…` URL below is a page read through that server,
plus the vendor's own pi page (`/integrations/pi`). They are cited as
**fixtures** for the fields the catalog cannot express — documentation, not a
behavioral copy of another client (d100's provenance rule).

Two community plugins (`monotykamary/pi-neuralwatt-provider` and
`aliou/pi-neuralwatt`) were read for the business rules of `/v1/models` —
which rows are chat rows, what a null limit becomes, how a tracking alias is
keyed. Their code was not copied (see Provenance), and where this folder
diverges it says so.

## Drawn from the listing, never remembered

One `GET /v1/models` per refresh is the whole catalog. Derived, never flagged:

| pi field                                             | Neuralwatt field                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `contextWindow`                                      | `max_model_len` (else `metadata.limits.max_context_length`)                                                      |
| `maxTokens`                                          | `metadata.limits.max_output_tokens`; when `null` (or `0`) the context window, because prompt and output share it |
| `cost.input` / `cost.output` / `cost.cacheRead`      | `metadata.pricing.input_per_million` / `output_per_million` / `cached_input_per_million` (`null` → 0)            |
| `input`                                              | `architecture.input_modalities` ∩ `{text, image}` (chat completions takes no video; audio has no pi arm)         |
| `reasoning` + `compat.supportsReasoningEffort`       | `metadata.capabilities.reasoning` / `metadata.capabilities.reasoning_effort`                                     |
| `thinkingLevelMap`                                   | `metadata.reasoning`, alias-expanded — see [Thinking levels](#thinking-levels)                                   |
| `inputLimits.images.maxPerMessage` / `maxPerRequest` | `metadata.limits.max_images` / `max_images_total`                                                                |

`cost.cacheWrite` is 0 because `cached_output_per_million` is documented as
always `null` (no cache-write price) — the one zero the adapter asserts, and it
is the provider's own statement.

**Which rows are chat rows.** Three drop rules, in order:

1. `metadata.capabilities.task` present — the docs: "Present only on models
   that do not generate text … Such a model rejects `/v1/chat/completions` with
   a `400`". Covers `decision` today and any future value, because the field's
   presence is the statement.
2. `metadata.deprecated`.
3. `metadata.pricing.pricing_tbd` — placeholder prices, and pi's `cost` block
   is mandatory on a registered model.

**Tier rows are dropped.** `-flex`, `-speed` and `-fast` are tier artifacts,
so a suffix that encodes the tier in the model name is noise in the picker. Only
`-flex` is derivable from data (the sibling's
`pricing.service_tier: "flex"`); the other two are this folder's policy, and
must stay the only remembered strings in it:

- `-speed` is the Speed lane: energy-billed only, and an account billed at
  listed token prices is refused with `403
  speed_tier_requires_energy_accounting` (`/guides/speed-tier`). It also cannot
  be requested through `service_tier` at all — the request enum is
  `auto/default/flex`, and only the response reports `speed`.
- `-fast` is a legacy thinking-off alias of a served model (`qwen3.6-35b-fast`
  is `qwen3.6-35b` with thinking pinned off, at the same price). The parent row
  publishes `none` in `accepted_efforts`, so the `off` level reaches exactly
  that state — nothing is lost.

**Flex capability is read, never assumed.** A standard row is Flex-capable iff
the listing carries `<id>-flex` with `pricing.service_tier: "flex"`. That twin's
four prices are the ones the flex lineup publishes — already discounted, so
`flex_discount_multiplier` is never applied again (it is `null` when no
discount is in force, and the numbers are then the undiscounted ones). A model
with no twin appears only in `neuralwatt-standard`; `gemma-4-31b` is one today.

## Compat decisions

The four fields the catalog cannot answer. Each is a statement about request
handling, not about a model.

| pi `compat` field                             | Value                                                | Citation                                                                                                                                                                                            | Why the catalog cannot carry it                                                                                                |
| --------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `supportsDeveloperRole`                       | `false`                                              | `/api-reference/inference/create-a-chat-completion`: roles are `system, user, assistant, tool`; "`developer` is not in this list. **It is forwarded verbatim rather than mapped, so use `system`**" | the capability flag says the model refuses it; only the docs say the gateway passes it through unmapped instead of translating |
| `requiresReasoningContentOnAssistantMessages` | `false`                                              | `/api/chat-completions#preserving-reasoning-across-turns`: "Avoid appending an empty companion field just to satisfy a client compatibility toggle"                                                 | the flag's whole effect is that appended empty field, which the docs forbid                                                    |
| `maxTokensField`                              | @"max_completion_tokens"@                            | `/api/chat-completions`: "`max_completion_tokens` … OpenAI's newer name for `max_tokens`; **wins when both are sent**"                                                                              | field precedence is server behaviour; it is not a model property                                                               |
| `supportsReasoningEffort`                     | `metadata.capabilities.reasoning_effort` (per model) | `/api/models#metadata-capabilities`: "Honors the `reasoning_effort` parameter on chat completions"                                                                                                  | this one IS per model, so it is read from the catalog rather than fixed here                                                   |

`supportsUsageInStreaming` needs no entry: pi's default is `true` and
`/guides/streaming` documents `stream_options.include_usage`.

### Unpublished means off

`store`, tool-definition `strict`, and mid-conversation system messages are
documented nowhere: the request table has no `store` field, `strict` appears
only inside `response_format.json_schema`, and no page describes system messages
after the first turn. They stay unset.

Note the host's defaults, which are not "off": pi detects
`supportsStore: true` and `supportsLongCacheRetention: true` for an unknown
base URL, so leaving them unset makes pi send `store: false` and — under
`PI_CACHE_RETENTION=long` — `prompt_cache_retention: "24h"`. The request
schema is `additionalProperties: true`, so both are tolerated; they are hygiene,
not a 422 risk, and they are registered open items (see below) rather than
silently "fixed" here.

## Thinking levels

`thinkingLevelMap` is **alias-expanded**: every pi level resolves to a wire
value the model accepts, or `null` (hidden). `effort_aliases` wins over
identity because it names the level the model is served at, which is what keeps a
legacy pick working — `:high` on `qwen-3.8-27b` (four distinct levels) resolves
to `xhigh` instead of disappearing. An alias whose target the provider does not
publish falls back to the accepted literal, and a level neither accepted nor
aliased is `null` so the request can never carry a value the gateway rejects.
`off` is `"none"` only when the model both accepts it and can stop reasoning:
`mandatory: true` models (GLM-5.3 today) publish no `none`, and their `off`
is `null`.

Both community plugins instead map identity over `supported_efforts` and hide
every collapsed rung. That is defensible, but it breaks picks users already type,
so this folder rejects it.

A model that reports `reasoning: true` without a `metadata.reasoning` block
gets no map: pi's own fallback then applies, rather than a wire value invented
here.

## The one request-shaping step

Reasoning history survives a turn boundary only if the client echoes prior
assistant reasoning **and** the model's template keeps it. Which kwarg does that
is per family and documented (`/api/chat-completions#per-model-behavior`). The
table is keyed by `metadata.huggingface_id`, not by model id, because the
`nw-*` rows are tracking aliases that move between models
(`/guides/tracking-aliases`): a table keyed by id would keep applying one
family's kwarg to whatever the alias points at next.

| Family (`huggingface_id`)              | Default                   | This folder sends                                   | Why                                                    |
| -------------------------------------- | ------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `Qwen/Qwen3.6-35B-A3B-FP8`             | suffix-only               | `chat_template_kwargs: { preserve_thinking: true }` | full history is the opt-in                             |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | suffix-only without tools | `chat_template_kwargs: { drop_thinking: false }`    | tools already override it, so the value is harmless    |
| `zai-org/GLM-5.3`, `…/GLM-5.3-Flash`   | full history              | nothing                                             | already the default                                    |
| `Qwen/Qwen3.8-27B-FP8`                 | full history              | nothing                                             | already the default                                    |
| anything else                          | undocumented              | nothing                                             | absent means "no kwarg", never "unknown family, guess" |

Two constraints decide the mechanism:

- pi sends `compat.chatTemplateKwargs` **only when `thinkingFormat` is
  `chat-template`, and that format sends the effort through the template
  instead of `reasoning_effort` — but the page above requires
  `reasoning_effort` to keep working alongside the kwarg. So the compat route is
  closed (it is still the right route for toggling thinking, which is what one
  plugin uses it for).
- `samplingParams` are "fields merged into every request body", free-form,
  OpenAI-compatible APIs only, applied last. The kwarg rides there:
  `samplingParams: { chat_template_kwargs: { … } }`, in the same object as the
  flex tier's `service_tier`.

## Open items (registered, not resolved)

Each is a decision waiting on evidence this folder does not have yet. None is a
silent assumption: where a rule would be invented, the field stays unset.

- **`content: null` on replay.** The OpenAPI types `Message.content` as required
  with `oneOf [string, array]` and the reasoning example sends `""`, while pi
  sends `null` by default unless `requiresNonNullAssistantContent` is set.
  Both community plugins leave the flag unset and ship, so the wire fact is
  genuinely unprobed: a keyed probe decides it.
- **`supportsStore` / `supportsLongCacheRetention`.** Detected `true` by pi for
  an unknown base URL (see above), unset here, tolerated by the provider. Decide
  whether to stop sending them.
- **`thinking_token_budget`.** It is a documented per-model vLLM passthrough, and
  `gemma-4-31b` returns `400` for it (`/api/chat-completions#support-per-model`).
  Neither the flex nor the standard lineup sets the field today, which is the
  safe shape; enabling it means a per-model compat, not a provider-wide one.
- **`scope`.** `/v1/models` answers 200 with the public catalog when a key is
  missing or dropped. This folder reads the listing with the key when one is set
  and does not branch on `scope`; a "public while a key is configured" warning
  is the open decision.
- **The host version pin.** The types are checked against
  `pi-coding-agent@1.5.2`; the vendor's pi page says it tested 1.6.0, where
  `supportsDeveloperRole` defaults to `isOpenAI` (false for this provider) —
  making the explicit `false` redundant but still correct.
- **Decision models as classifiers.** pi's arm exists and Neuralwatt is System
  One-compatible; the transport is the work. Deferred deliberately.

## Files

| File          | Role                                                                             |
| ------------- | -------------------------------------------------------------------------------- |
| `index.mjs`   | the extension entry: two `registerProvider` calls + `refreshModels` per tier     |
| `sources.mjs` | the fact row, the base-url override, the ONE `GET /v1/models`                    |
| `merge.mjs`   | the ONE shaping step: one listing in, both lineups out                           |
| `compat.mjs`  | the documented compat fields and the `huggingface_id`-keyed thinking-kwarg table |
| `log.mjs`     | the JSONL log lines `sources.mjs` emits (docs/d045)                              |
| `tests/`      | the rules, network-free (injected `fetch`)                                       |

Nothing is generated and nothing is committed as data: `generate` is a stub
that prints its own name (d190's amendment), so there is no artifact for a drift
gate and `freshness.sh` skips the unit.

## Install

`sh
pi install ./pi-neuralwatt -l # local package from this repo

# or point pi straight at the entry:

pi -e ./pi-neuralwatt/index.mjs
`

| Var                   | Meaning                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `NEURALWATT_API_KEY`  | the key pi sends as `Authorization: Bearer`; unset leaves both providers unconfigured. The listing is read with it when set |
| `NEURALWATT_BASE_URL` | optional upstream override, derived from the key env the way Azure OpenAI spells the pair                                   |

Network rides the environment's forward proxy (`NODE_USE_ENV_PROXY=1` + the
forwarded `HTTP(S)_PROXY`, docs/d074). No relay ladder, no route files.

The vendor's pi page documents `neuralwatt/nw-flash` and
`defaultProvider: "neuralwatt"`; this package splits the id, so the operator's
default is `neuralwatt-flex/nw-flash` (or the `-standard` twin when price
beats latency tolerance).

## Tests

`sh
./npm-run.sh pi-neuralwatt test    # from the repo root
`

Network-free (injected `fetch`) and rule-pinning: the filter order, the tier
suffixes, the twin-derived flex capability and prices, the null/0 output-limit
fallback, cost fills, modalities, image limits, alias-expanded thinking levels,
the `huggingface_id`-keyed kwargs, the two-registration shape, the
throw-on-unreadable-source contract and the store TTL. Never today's lineup.

## Provenance

- **LIVE DATA** — `/v1/models` (catalog, prices, limits, effort ladders, flex
  markers) returned in band. Self-correcting every run.
- **ATTRIBUTION** — every `docs.neuralwatt.com` page cited above, read through
  the vendor's MCP server, plus `/integrations/pi` and the two community
  plugins' catalog code, read for the business rules of `/v1/models` (which rows
  are chat rows, the null-limit fallback, alias keying). Quoted and cited, not
  transcribed.
- **BEHAVIORAL COPY — none.** No table, compat block or parser is taken from
  `monotykamary/pi-neuralwatt-provider`, `aliou/pi-neuralwatt` or any other
  client. Two lessons are credited: the `chat-template`/effort trap, and the
  fact that energy capture needs a fetch tee this folder refuses.
