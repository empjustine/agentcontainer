# AGENTS.md — pi-tlalocayotl-provider

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
(a folder is a copy unit) is in `../docs/architecture.md`. What follows is only
what is specific here. The folder contract is `../pi-verboo-provider/AGENTS.md`'s,
applied to this gateway — read that one first, then this.

## One source of truth, and it is the gateway

- **`GET <base>/v1/models` is the only input** — llama-swap's own listing, and
  the only place this provider's lineup exists. Do not add a models.dev
  fallback "to be safe": the gateway swaps backends, and a second catalog can
  only lag or contradict it.
- **The listing is AUTH-GATED** (measured: `401 unauthorized: invalid or
  missing API key` without the bearer). A failure throws with no committed
  copy behind it, so the provider is unconfigured for that run (docs/d190).
- **`status.value` is never a filter.** llama-swap loads a backend on demand,
  so `unloaded` / `sleeping` rows are routable rows. Publishing only the
  resident model would hide the catalog the gateway exists to serve.
- **No price is ever asserted.** The gateway is the operator's own inference
  host and publishes no prices, so the extension fills the mandatory zeros
  (docs/d057). Inventing one would be a vendor fact nobody published.
- **No display name is invented.** The listing carries none, so the id — GGUF
  repo plus quant tag, exactly what the gateway routes on — is the name.
- **`meta.llamaswap.reasoning` is the reasoning declaration**, never the model
  id or family. Unstated means a non-reasoning registration, not a guess.

## The compat mirror is a TRANSCRIPTION, not a published fact

`merge.mjs`'s `LLAMA_CPP_WIRE_COMPAT` and `LLAMA_CPP_THINKING_LEVEL_MAP` copy
`@earendil-works/pi-coding-agent@1.5.2`
`dist/extensions/llama/provider.js` (`toPiModel`) — llama-swap starts and
fronts llama-server backends, so pi's own llama.cpp binding is the right table
for the same OpenAI surface rather than a guessed one. Upstream can revise it
and this mirror has no tripwire: re-read that file before changing a value on a
hunch, and re-measure the live gateway when it matters (the README's
verification status records what was actually sent). The tests pin today's
values so a silent local edit is caught.

## Nothing is committed

No lineup, no fallback, no manifest. `refreshModels` reads the gateway's
listing on every run, and `generate` is a stub that prints its own name — so
there is no artifact to hand-edit, no `--check` drift gate, and no generated
file in `biome.jsonc`'s ignore list. A stub rather than a deleted script keeps
the unit's entrypoint table whole (docs/d113).

**The last verified read is persisted, not remembered.** `refreshModels` answers
pi's cache-only phase with the catalog `context.stored` holds, and stores every
successful read through `context.publish({ persist })` (docs/d190's amendment) —
a snapshot of what the server actually answered, never a seed: a failed read
still throws and stores nothing, so an offline start shows the last verified
catalog and a first run still shows nothing.

The extension registers no lineup of its own (docs/d190): `refreshModels` is
the only source. Do not add a `models` field or a committed seed to make an
offline start look populated.

## The gateway's own MCP endpoint

`/api/mcp` is llama-swap's docs/config MCP server, not this extension's
business, but it is the same deployment: the gateway's `apiKeys` (set to
`${env.TLALOCAYOTL_API_KEY}` in `../llm-local-inference/config.d/00-general.yaml`)
gate both surfaces. The fleet entry in `../coding-agent/mcp.json` ships
`enabled: false` + `exposure: hidden` because the server speaks MCP
`2026-07-28` only and pi 1.5.2's client tops out at `2025-11-25` (measured:
`-32022`, docs/d061). Do not "fix" that by enabling it, and do not add MCP
registration code here — this folder registers a provider and nothing else.

## Not registered here

- **No classifier arm.** llama.cpp reports decision models by publishing
  `decisions` in `architecture.output_modalities`; those rows are dropped
  because a decision model rejects `/v1/chat/completions` and this folder has
  no `typesafe-system-one` binding to give them (the host's `llama.cpp`
  provider does).
- **No warm-up, no `/props` probe.** The gateway states the resolved window in
  `meta.llamaswap`, so the extension never loads a backend to ask it — a cold
  start is the gateway's business and must not happen during a refresh.
