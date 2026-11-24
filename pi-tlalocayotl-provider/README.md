---
id: pi-tlalocayotl-provider
type: module-design
status: active
title: "pi-tlalocayotl-provider — the Tlalocayotl llama-swap gateway as a pi package: catalog from its key-gated /v1/models, compat from the host's llama.cpp binding"
parent: architecture
depends-on: [d096]
references: [d057, d074, d100, d190, llama-swap-response-analysis]
tags: [pi, extensions, providers, llama-swap, llama-cpp, tlalocayotl]
---

# pi-tlalocayotl-provider — one llama-swap gateway as a pi package

Registers **Tlalocayotl** (`https://tlalocayotl.coelacanth-barb.ts.net/v1`, the
frozen row `sources.mjs` carries) with
[pi](https://github.com/earendil-works/pi). The lineup is rebuilt at every
refresh from the gateway's own `/v1/models` listing; nothing is committed.

## Install

```sh
pi install ./pi-tlalocayotl-provider -l    # local package from this repo
# or point pi straight at the entry:
pi -e ./pi-tlalocayotl-provider/index.mjs
```

## Environment

| Var                    | Meaning                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TLALOCAYOTL_API_KEY`  | the key pi sends as `Authorization: Bearer` — and the key the listing itself needs (an unset key fails the refresh before `refreshModels` runs)                                  |
| `TLALOCAYOTL_BASE_URL` | optional upstream override, derived from the key env the way Azure OpenAI spells the pair. Absolute http(s) only; a trailing slash is trimmed; unset keeps the row's tailnet URL |

Network rides the environment's forward proxy (`NODE_USE_ENV_PROXY=1` + the
forwarded `HTTP(S)_PROXY`, docs/d074). No relay ladder, no route files.

## What the gateway publishes, and what the extension reads

One source, and necessarily so: models.dev carries no row for an operator's own
gateway. [llama-swap](https://github.com/mostlygeek/llama-swap) serves an
OpenAI-shaped `data[]` (`internal/server/api.go`: `modelRecord` and
`renderCapabilities`) with its own block on each row, and every fact below comes
from it. `meta.llamaswap` is not a llama-swap schema: the gateway copies the
model's `metadata` block from its config verbatim under that key, so
`contextWindow`, `maxTokens`, `input` and `reasoning` are the operator's own
statement — the fleet writes exactly those keys in
`../llm-local-inference/config.d/`, which is also where the backend
`--ctx-size`, `--n-predict` and `--chat-template-kwargs` flags behind them live.

| pi field        | Read from                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `id`            | the row's `id` — GGUF repo plus quant tag, which is what the gateway routes on                  |
| `name`          | the model's configured `name` when the config sets one, else the id                             |
| `contextWindow` | `meta.llamaswap.contextWindow` → `context_window` → `context_length` → `meta.n_ctx`             |
| `maxTokens`     | `meta.llamaswap.maxTokens`, else the window — llama.cpp draws prompt and output from ONE window |
| `input`         | `meta.llamaswap.input` → `architecture.input_modalities` → `capabilities.vision`                |
| `reasoning`     | `meta.llamaswap.reasoning`                                                                      |
| `cost`          | nothing: the gateway publishes no prices, so the mandatory block is zeros (docs/d057)           |

`status.value` is read by nobody on purpose: llama-swap loads a backend on
demand, so an `unloaded` model is a selectable model — filtering on residency
would leave `/model` showing whatever happens to be warm.

Rows whose `architecture.output_modalities` exclude `text` are decision models
(TypeSafe's System One family): they reject `/v1/chat/completions` and this
folder registers no classifier arm, so they are dropped.

## The wire compat, and why it is a transcription

`merge.mjs` carries `LLAMA_CPP_WIRE_COMPAT` and `LLAMA_CPP_THINKING_LEVEL_MAP`
copied from the host's own llama.cpp provider
(`@earendil-works/pi-coding-agent@1.5.2` `dist/extensions/llama/provider.js`,
`toPiModel`): llama-swap starts and fronts llama-server processes, so that
table describes this surface. It is the folder's ONE behavioral copy, and the
one provenance risk that comes with it — upstream can revise it and this mirror
has no tripwire. Re-read that file before changing a value.

The reasoning half is the template switch, not an effort ladder: `off` and
`medium` are the levels llama.cpp exposes (`chat_template_kwargs` with
`enable_thinking`), everything between is unsupported, and `thinkingFormat:
"qwen-chat-template"` is what sends it.

## Verification status

Measured against the live gateway on 2026-11-24, one chat completion each:

- the full listing (`data[]`, 33 rows) shaped and registered with no parse
  gaps — 33 chat models, 31 of them image-capable, all reasoning-tagged;
- `max_tokens` is accepted and `stream_options.include_usage` returns a final
  usage chunk (the `maxTokensField` and `supportsUsageInStreaming` claims);
- `chat_template_kwargs: {enable_thinking: true}` returns
  `reasoning_content`, `{enable_thinking: false}` returns plain content (the
  `qwen-chat-template` + thinking-map claims).

Loaded by the host itself, not only by the tests: `pi --mode rpc` with
`-e ./index.mjs` refreshed the catalog and `get_available_models` answered 33
`tlalocayotl` entries; `set_model` on one of them resolved, and a `prompt`
reached the gateway with the assistant message streaming under
`provider: tlalocayotl`. The turn was not awaited to completion — this box's
prompt processing is slow enough that a full pi system prompt takes minutes —
and the wire facts above were checked directly instead.

Not measured, and therefore not claimed: `supportsStrictMode`,
`supportsStore` and `supportsDeveloperRole` are carried as `false` because the
transcribed table says so — the surface answers a `developer` role, and no
`store` field was ever sent. A refresh never loads a backend: the window is
read from the listing, not from `/props`.

## The gateway's MCP endpoint

llama-swap serves its own MCP server at `/api/mcp`
([upstream guide](https://github.com/mostlygeek/llama-swap/blob/main/docs/kb/guides/api-integration/mcp-endpoint.md)),
and this gateway's is
`https://tlalocayotl.coelacanth-barb.ts.net/api/mcp`. It answers with llama-swap's
documentation, its source, and the instance's effective configuration
(`docs__*`, `code__*`, `config__get_config`, `sys__now`) — ten tools, no
server instructions — and it is gated by the gateway's `apiKeys`, which this
deployment sets to `${env.TLALOCAYOTL_API_KEY}`, so the same
`TLALOCAYOTL_API_KEY` this extension sends as a bearer is the one it accepts.

The fleet's `../coding-agent/mcp.json` carries it as `tlalocayotl`,
`"enabled": false` with `"exposure": "hidden"` (docs/d061). The gate is a
protocol revision rather than a credential: the endpoint speaks MCP
`2026-07-28` only — the stateless-POST revision, `MCP-Protocol-Version` and
`Mcp-Method` headers, no `initialize` handshake — while pi 1.5.2's MCP client
offers `2025-11-25` and older and is refused with `-32022`. Enabling the entry
before pi speaks that revision buys a `failed` server line and no tool.

## Files

| File          | Role                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `index.mjs`   | the extension entry: `registerProvider` + `refreshModels` (the listing at runtime)                     |
| `sources.mjs` | the ONE source read: the gateway's `/v1/models` listing at the effective upstream                      |
| `merge.mjs`   | the ONE shaping step: a llama-swap row becomes the registered-model entry, plus the transcribed compat |

Nothing is generated and nothing is committed: `./npm-run.sh
pi-tlalocayotl-provider generate` prints a stub line — there is no artifact for
a drift gate to compare, and the extension registers no lineup of its own
(docs/d190).

## Tests

```sh
./npm-run.sh pi-tlalocayotl-provider test     # from the repo root
```

Network-free (injected fetch) and rule-pinning: the source contract, the
auth-gated bearer, the window/output-cap fallback chains, the modality chain,
the decision-row drop, the unread `status`, the transcribed compat block and
thinking map — never today's GGUF lineup.
