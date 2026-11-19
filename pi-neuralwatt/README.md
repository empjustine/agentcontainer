---
id: pi-neuralwatt
type: module-design
status: draft
title: "pi-neuralwatt — the Neuralwatt inference adapter as a pi package: catalog from /v1/models, compat from the published docs"
parent: architecture
references: [d057, d070, d074, d096, d100, d190, d191, d192]
tags: [pi, extensions, providers, neuralwatt, adapter, compat]
---

# pi-neuralwatt — the Neuralwatt adapter as a pi package

**Status: specification only — no code in this folder.** It records what a
pi extension that registers `neuralwatt` as a chat provider must do, with every
compat decision traced to the one source that can settle it: Neuralwatt's own
`/v1/models` payload where the field is published, and the vendor's
documentation where it is not.

## What the adapter is, and what it is not

**Is:** one `registerProvider` call whose catalog is rebuilt from
`GET https://api.neuralwatt.com/v1/models` on every refresh, plus the compat
fields a request needs to be spoken correctly. That is the whole extension.

**Is not** — deliberately, each for a reason already paid for elsewhere:

- **no energy or cost tracking.** The host's `pi-ai` has no energy field
  (nothing for `joules`/`kwh` in pi 1.5.2), so a display would mean a
  custom `api` plus a per-request fetch tee, re-parsing SSE comment lines and
  reconciling billed-against-list price — the mechanism that resurrects the
  stale-cache, tee-cancellation and replay bugs the other provider extensions
  carry. Out of scope entirely.
- **no quota command, no settings UI, no status widget.** Account reads
  (`/v1/quota`) are a UI feature, not a provider capability.
- **no committed lineup, no seed, no fallback.** The listing is the only
  source and an unreadable source throws (d190/d191).
- **no `/v1/messages` or `/v1/responses` surface.** Both exist upstream
  (`/api/overview`); a second wire surface is a second adapter and buys
  nothing until a caller needs it.
- **no request-shaping stream wrapper**, except the one documented merge in
  [The one request-shaping step](#the-one-request-shaping-step).

## Documentation references

Neuralwatt publishes a documentation MCP server. Both references resolve
(verified: `GET` + JSON-RPC `initialize`/`tools/list` over HTTP, no auth):

| Reference                                     | What it answers                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `https://docs.neuralwatt.com/.well-known/mcp` | the discovery document — `{"version":"1.0.0","transport":"http","url":"https://docs.neuralwatt.com/mcp","servers":[{"name":"public","url":"https://docs.neuralwatt.com/mcp","transport":"http","authentication":"none"}]}`     |
| `https://docs.neuralwatt.com/mcp`             | the MCP server itself (`2025-06-18`, stateless): `search_neuralwatt`, `query_docs_filesystem_neuralwatt` (read-only docs pages + `/openapi/openapi.yaml`), `submit_feedback`, plus the `mintlify://skills/neuralwatt` resource |

Every `docs.neuralwatt.com/…` URL below is a page read through that server.
They are cited as **fixtures for the four compat fields the catalog cannot
express** — documentation, not a behavioral copy of another client (d100's
provenance rule), so nothing in this folder is transcribed from a third-party
provider repo.

## Two sources of truth

| Question                                                       | Source                           | Why                                                                                                   |
| -------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| which models, what they cost, what their limits and levels are | `GET /v1/models` at refresh time | published per model; keyless returns `scope: public`, a key returns `scope: customer` (`/api/models`) |
| how a request must be spelled                                  | the docs pages cited below       | not expressible in the catalog                                                                        |

`/api/models` publishes `architecture.input_modalities`,
`metadata.pricing`, `metadata.capabilities`, `metadata.reasoning` and
`metadata.limits`, so the following are **derived, never flagged**:

| pi field                                             | Neuralwatt field                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `contextWindow`                                      | `max_model_len` (equals `metadata.limits.max_context_length`)                                                            |
| `maxTokens`                                          | `metadata.limits.max_output_tokens`; when `null`, no separate cap applies — prompt and output share `max_context_length` |
| `cost.input` / `cost.output` / `cost.cacheRead`      | `metadata.pricing.input_per_million` / `output_per_million` / `cached_input_per_million`                                 |
| `input`                                              | `architecture.input_modalities` ∩ `{text, image}` (chat completions takes no video; audio has no pi arm)                 |
| `reasoning` + `compat.supportsReasoningEffort`       | `metadata.capabilities.reasoning` / `metadata.capabilities.reasoning_effort`                                             |
| `thinkingLevelMap`                                   | `metadata.reasoning.effort_aliases` over `accepted_efforts`; `mandatory: true` maps `off` to `null`                      |
| `inputLimits.images.maxPerMessage` / `maxPerRequest` | `metadata.limits.max_images` / `max_images_total`                                                                        |
| `compat.supportsDeveloperRole`                       | `metadata.capabilities.developer_role`                                                                                   |

`cost.cacheWrite` is `0` because `cached_output_per_million` is documented as
always `null` (no cache-write price) — the one zero the adapter asserts, and it
is the provider's own statement.

## Compat decisions

### From the documentation

The four fields the catalog cannot answer. Each is a statement about request
handling, not about a model.

| pi `compat` field                             | Value                                                              | Citation                                                                                                                                                                                                                 | Why the catalog cannot carry it                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `supportsDeveloperRole`                       | `false`                                                            | `/api-reference/inference/create-a-chat-completion`: roles are `system, user, assistant, tool`; "`developer` is not in this list. **It is forwarded verbatim rather than mapped, so use `system`**"                      | the capability flag says the model refuses it; only the docs say the gateway passes it through unmapped instead of translating |
| `requiresReasoningContentOnAssistantMessages` | `false`                                                            | `/api/chat-completions#preserving-reasoning-across-turns`: "`reasoning` … `reasoning_content` are **request-side aliases** … **Avoid appending an empty companion field just to satisfy a client compatibility toggle**" | the flag's whole effect is that appended empty field, which the docs forbid                                                    |
| `maxTokensField`                              | `"max_completion_tokens"`                                          | `/api/chat-completions`: "`max_completion_tokens` … OpenAI's newer name for `max_tokens`; **wins when both are sent**"                                                                                                   | field precedence is server behaviour; it is not a model property                                                               |
| `thinkingTokenBudgetField`                    | `"thinking_token_budget"` (only if pi's thinking budgets are used) | `/api/chat-completions#reasoning-token-budget`: "a **vLLM passthrough** … a top-level field on the chat completion request"                                                                                              | same                                                                                                                           |

`supportsUsageInStreaming` needs no entry: pi's default is `true` and
`/guides/streaming` documents `stream_options.include_usage`.

### Unpublished means off

`store`, tool-definition `strict`, and mid-conversation system messages are
documented nowhere: the request table has no `store` field
(`/api/chat-completions`), `strict` appears only inside
`response_format.json_schema` (`/api/chat-completions#structured-outputs`), and
no page describes system messages after the first turn. So `supportsStore`,
`supportsStrictMode` and `supportsMidConvoSystemMessages` stay at pi's
`false` — a flag enabled on absence-of-evidence changes what pi SENDS (d100).

## The one request-shaping step

Reasoning history survives a turn boundary only if the client echoes prior
assistant reasoning **and** the model's template keeps it. Which kwarg does that
is per family and documented
(`/api/chat-completions#per-model-behavior`):

| Family                | Default                   | Full-history opt-in                               |
| --------------------- | ------------------------- | ------------------------------------------------- |
| GLM-5.2 (all aliases) | suffix-only               | `chat_template_kwargs: {"clear_thinking": false}` |
| GLM-5.3 (all aliases) | full history              | `{"clear_thinking": true}` opts **out**           |
| Qwen3.6-35B           | suffix-only               | `{"preserve_thinking": true}`                     |
| Qwen3.8-27B           | full history              | `{"preserve_thinking": false}` opts out           |
| DeepSeek V4.1-Flash   | suffix-only without tools | `{"drop_thinking": false}`                        |

Two constraints decide the mechanism:

- pi sends `chatTemplateKwargs` **only when `thinkingFormat` is
  `chat-template`** (`models-configuration.md`), and that format sends the
  effort through the template instead of `reasoning_effort` — but the page
  above requires `reasoning_effort` to keep working alongside the kwarg. So the
  compat route is closed.
- `samplingParams` are "fields merged into every request body", free-form,
  OpenAI-compatible APIs only (`models.md`, "Configure sampling by thinking
  level"). The kwarg rides there:
  `samplingParams: { chat_template_kwargs: { … } }`.

The table above is therefore data in the folder, keyed by the model id the
listing serves, with the page URL beside each row.

## Probes, not flags

Three documented behaviours that a test must confirm before the folder claims
them, because each is a client-side consequence rather than a server-side field:

1. **Context overflow.** Neuralwatt publishes `code: context_length_exceeded`
   (`/guides/error-handling`); pi 1.5.2's overflow matcher knows the prose
   ("context length", "maximum context length", "input is too long") but not
   that code. If an overflow arrives unrecognised, a guarded `message_end`
   normalisation is needed — verified first, per `custom-provider.md`.
2. **`content: null` vs `""`** on a replayed tool-call-only assistant message:
   the messages table types `content` as required, and the reasoning example
   sends `"content": ""`. Probe decides `requiresNonNullAssistantContent`.
3. **Reasoning response spelling.** `/api/chat-completions` records (verified
   upstream 2026-09-19) that `qwen3.6-35b`, `qwen-3.8-27b` and
   `deepseek-v4.1-flash` answer in `choices[].message.reasoning` /
   `delta.reasoning`, `kimi-k3.1-pro` in `reasoning_content`, and "other
   backends may use either spelling". If pi reads only one, thinking from those
   families disappears — a normalisation in the adapter, not a compat flag.

## Folder contract when code lands

`index.mjs` (registration + `refreshModels`), `sources.mjs` (the fact row and
the one `GET /v1/models`), `merge.mjs` (listing row → `ProviderModelConfig`),
`compat.mjs` (the four fields and the kwarg table, each with its URL),
`log.mjs`, `tests/`, `AGENTS.md`, `package.json` + `pnpm-lock.yaml`. Folder
is the package (d096/d192): `.mjs` entry typed by the host's own
`@earendil-works/pi-coding-agent` devDependency, tests importing the entry by
literal specifier, network-free (injected fetch). A source that cannot answer
throws (d190). Requests ride `NODE_USE_ENV_PROXY=1` + the forwarded
`HTTP(S)_PROXY` (d074); canonical upstream committed verbatim (d070);
`$NEURALWATT_API_KEY`, sent as `Authorization: Bearer`
(`/authentication`).

`knip.jsonc` gains `pi-neuralwatt/index.mjs` and this row enters the
`README.md` layout when the entry exists; `tsconfig.json` and `test.sh` pick
the folder up by glob. No `coding-agent/` fleet row: the provider has no
models.dev layer today, and the seam is d100's open item.

## Provenance

- **LIVE DATA** — `/v1/models` (catalog, prices, limits, effort ladders) and
  `/v1/models?scope` returned in-band. Self-correcting every run.
- **ATTRIBUTION** — every `docs.neuralwatt.com` page cited above, read through
  the vendor's MCP server; quoted, not transcribed into code, with the URL
  beside each use.
- **BEHAVIORAL COPY — none.** No model table, no compat block and no parser is
  copied from `monotykamary/pi-neuralwatt-provider`,
  `aliou/pi-neuralwatt` or `neuralwatt/energy-aware-pi-mono`. Those trees are
  cited for two lessons only: the `chat-template`/effort trap, and the fact
  that energy capture needs a fetch tee this folder refuses.
