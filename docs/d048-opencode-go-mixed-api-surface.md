---
id: d048
type: architecture-design
status: implemented
title: "d048 — opencode-go's mixed api surface: per-model api overrides from the published endpoints table"
parent: coding-agent
depends-on: [coding-agent, lib]
references: [d033, d040, d046b]
tags: ["coding-agent", "opencode-go", "models.json", "api-shape", "resolver"]
---

# d048 — opencode-go's mixed api surface: per-model api overrides

**Status:** implemented (`parseOpencodeGoEndpoints` / `readOpencodeGoDocs` /
`resolveOpencodeGoApi` + `applyModelApi` in
`coding-agent/generate-pi-coding-agent.mjs`).

## Problem

opencode-go is the one pi-native provider whose single base URL
(`https://opencode.ai/zen/go/v1`, the fact-table row) serves a **mixed api
surface**: per opencode's own published endpoints table, the same provider
speaks `/chat/completions` (openai-completions shape — the glm/kimi/deepseek/
mimo/hy lineup), `/responses` (openai-responses — grok, gpt-5.6-luna,
muse-spark) and `/messages` (anthropic-messages — the qwen3.x and minimax
lineup). pi's provider-level `api` is one value; whatever it is, two thirds of
the lineup would receive wrong-shaped requests and fail. The old generator
emitted no api information at all — it worked only for the subset that
happened to match pi's built-in dialect.

## Sources

Two published sources, cross-checked against each other exactly like
d040's cline-pass resolver:

1. **opencode's `go.mdx`** (`packages/web/src/content/docs/go.mdx`, dev branch
   of the `anomalyco/opencode` mirror): the `## Endpoints` GFM table carries
   `| Model | Model ID | Endpoint | AI SDK Package |` — model id AND wire
   shape per row. This is the contract. (The earlier `## Models` bullet list
   and the usage-limits/pricing tables are display-name-only shapes and are
   deliberately not parsed.)
2. **the models.dev catalog's per-model `provider.npm` override** — the
   upstream is the `anomalyco/models.dev` fork's
   `providers/opencode-go/models/*.toml` `[provider] npm = ...` rows, which
   models.dev's api.json already mirrors per model (absent ⇒ the
   openai-compatible default).

The ai-sdk package name is the shared vocabulary of both sources; one table
maps it to pi's api types:

| package | pi `api` |
|---|---|
| `@ai-sdk/anthropic` | `anthropic-messages` |
| `@ai-sdk/openai` | `openai-responses` |
| `@ai-sdk/openai-compatible` | `openai-completions` |

## Decision

1. `resolveOpencodeGoApi(modelsDevModels)` returns a bare-id → pi api map and
   is wired onto the opencode-go override-only spec row as `modelApiResolver`
   (the spec property; every other row leaves it unset). `applyModelApi`
   attaches the map to already-built model records at all three override-only
   emit sites (live peer listing, route catalog fallback, minimal catalog
   override) — pi's model-level `api` overrides the provider-wide dialect for
   exactly the ids the map knows, everything else keeps pi's built-in
   default.
2. Same self-check shape as d040: `|docs ∩ catalog| / |docs| ≥ 0.8`
   (`OPENCODE_GO_MATCH_FLOOR`) adopts the **union** — the endpoints table
   wins per id, the catalog `provider.npm` fills catalog-only ids (verified
   live: 31/31 docs ids matched, `grok-4.5` adopted from the catalog,
   0 conflicts, 32 overrides). Below the floor, or with no readable docs
   source, the map comes back **empty** — which is byte-for-byte the
   pre-resolver behavior (every model on the provider-wide default), the
   safe failure rather than a wrong-shaped request.
3. The docs source is best-effort like `readClinePassDocs`: `OPENCODE_GO_MDX`
   points at a plain file, `OPENCODE_MIRROR` overrides the mirror lookup,
   bounded 15s `git show` per candidate, missing mirror (the normal
   container case) falls back. The lookup order is the shared
   `readMirrorFile` farm search (docs/d040): the env override, then the host
   machine's `~/Downloads/references/github.com/anomalyco/opencode.git` farm
   clone, then the flat `~/anomalyco/opencode.git`; the mirror's HEAD must be
   the dev branch. The models.dev fork clone is NOT required — the catalog's
   per-model npm override already carries the fork's data; a fork mirror
   would only matter for dev-branch-ahead entries and is deliberately not a
   dependency.

## Consequences

- The `PiModel` typedef gains an optional `api` (gen-lib); the
  override-only entries stay provider-reroute-shaped (no provider-level
  `api`) so pi's built-in dialect and auth stay in charge.
- The models.dev `ModelsDevModel` typedef gains the optional per-model
  `provider.npm` — a catalog field the generator previously ignored.
- `generate-opencode.mjs` (the opencode-harness renderer) consumes
  opencode-go too; its config shape has no per-model api field, so nothing
  changes there. If opencode's own config grows one, the same resolver map
  is the source.
