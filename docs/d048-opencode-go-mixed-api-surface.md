---
id: d048
type: module-design
status: active
title: "d048 — opencode-go's mixed api surface: the live listing declares each model's route"
parent: coding-agent
depends-on: [coding-agent, workload-api]
references: [d033, d040, d049, d057, d064, d115]
tags: ["coding-agent", "opencode-go", "models.json", "api-shape"]
---

# d048 — opencode-go's mixed api surface

**Status:** implemented — the route comes from the listing, in gen-lib's
`piModel` (`PI_API_BY_DIALECT` / `listingRoute`) and
`coding-agent/generate-pi-coding-agent.mjs` (`parseDocsModelIds`,
`reportOpencodeGoDocsDrift`). Both mixed-surface rows use it, zen included
(d064). The earlier package-table resolver is retired (see "The retired
resolver").

## Problem

opencode-go is the one pi-native provider whose single base URL
(`https://opencode.ai/zen/go/v1`, the fact-table row) serves a **mixed api
surface**: one provider speaks `/chat/completions`, `/responses`,
`/messages` and `/v1beta` per model. pi's provider-level `api` is one
value; whatever it is, most of the lineup would receive wrong-shaped requests.
A model needs its own `api` **and** its own `baseUrl`, because the surface
lives at a path per dialect
(`…/inference/go/openai/v1`, `…/inference/go/anthropic`,
`…/inference/go/google/v1beta`) rather than at the provider root.

## Sources

**The live listing is authoritative.** `GET {baseUrl}/models` answers with
one rich row per model, and each row declares exactly one dialect under
`api: { <dialect>: { base_url, sdk } }`. That key is the wire shape; the
ai-sdk package in `sdk.aisdk` is not — `@ai-sdk/openai` serves both
`/chat/completions` and `/responses`, which is the whole reason a package
table cannot route this provider. The row also carries `limit`,
`modalities`, `capabilities` and `cost.text` (with context-triggered
`overrides`), so the listing is the metadata source too, and a faithful
emitted record is byte-identical to pi's own bundled one.

**opencode's `go.mdx` is a reference.** The `## Endpoints` table
(`| Model | Model ID | Endpoint | AI SDK Package |`) is read only for its id
column, and only to log the two directions of disagreement. It never decides
the lineup:

- the listing is set by what this key can call. A model the provider blocks
  for the key is **absent from the keyed listing even though the docs table
  and the unkeyed listing carry it** (measured: `grok-4.7`,
  `gpt-5.6-luna`, `gpt-6-luna`, `claude-haiku-5-5`, `gemini-4-argon`).
  That absence is the provider's answer, so the id is reported and never
  added;
- a wrong bearer does not error, it returns `{data: []}` — a silently empty
  offering. An empty listing is a degrade to the catalog, never an empty
  provider.

The path is the site tree, `services/site/src/docs/content/console/go.mdx`;
the pre-Astro path `packages/web/src/content/docs/go.mdx` is kept as the
second candidate, so a later move costs the reference, not the read.

## Decision

1. **Route per model, from the listing.** `piModel` reads the single
   dialect key of `entry.api` and emits `{ api, baseUrl }` together
   (`PI_API_BY_DIALECT`): `chat-completions` → `openai-completions`,
   `responses` → `openai-responses`, `messages` →
   `anthropic-messages`, `generate-content` → `google-generative-ai`.
   pi appends the endpoint to the base, so the anthropic base drops the
   listing's trailing `/v1` (pi's catalogs carry `…/anthropic`, the base of
   `/v1/messages`); the openai and google bases keep their version segment.
   No dialect, or more than one, is no answer: the model keeps the
   provider-wide default rather than a guessed route.
2. **Metadata from the listing, pi's default otherwise.** `name`,
   `limit.context` → `contextWindow`, `limit.output` → `maxTokens`,
   `modalities.input` (MIME types mapped onto `text`/`image` and trimmed
   by the shared `toInput`, d049), and `cost.text` → the four prices plus
   `cost.tiers` for each `when.context.gt` override. The block stays
   complete-or-absent (d057): an unpriced model publishes no `cost`.
3. **Retired catalog entries never publish.** Where models.dev is the lineup
   source (`nvidia`'s superficial slice and every full-mode row), `status
   === "deprecated"` is filtered out (`catalogModelLive`); `beta` and
   `alpha` are availability stages of live models and stay.
4. **A docs source carries candidate paths.** `readMirrorFile` takes an
   ordered path list, so the moved document degrades to "no reference" — one
   warning — instead of losing the read.
5. **A mixed surface with no listing publishes the reroute only.** The rows
   `MIXED_SURFACE_IDS` names (`opencode`, `opencode-go`) emit
   `{ baseUrl }` and no `models` key when no listing answered — no key, a
   dead route, or an empty offering:
   pi's merge keeps its own described records (their api, limits, prices)
   and the override only changes WHERE requests go. An id-only catalog
   record would replace a described model with a stub and route it through
   the wrong shape — the downgrade this record exists to remove. This is the
   FALLBACK rule: both rows are listing-driven, zen included (d064).

## The retired resolver

The first implementation mapped the ai-sdk **package** column to pi's api
(`OPENCODE_GO_API_BY_PACKAGE`), unioned it with the catalog's per-model
`provider.npm` above an agreement floor of 0.8
(`OPENCODE_GO_MATCH_FLOOR`), and attached the result to model records at
emit time (`resolveOpencodeGoApi` + `applyModelApi`).

Three things made it dead rather than merely stale:

- the package table cannot express the split (`@ai-sdk/openai` covers both
  openai dialects), so the mapped route was a guess for half the lineup;
- it emitted `api` with no `baseUrl`, which addresses the provider root and
  not the dialect path — a wrong-shaped request with a plausible look (d048's
  own `api`-without-`baseUrl` rule);
- the docs read pointed at the pre-Astro path only, so on a current mirror it
  never parsed, the resolver fell back to the catalog, and the google dialect
  had no column entry at all — the "31/31 verified" figure was measured
  before the docs move.

## Consequences

- `PiModel` gains `baseUrl` and a `PiCost` with `tiers` (gen-lib);
  `RawModelEntry` grows the rich-listing fields (`limit`, `modalities`,
  `cost`, `api`) so the shape the listing really sends is typed where it
  arrives.
- The emitted `opencode-go` records replace pi's built-in ones **faithfully**
  — same name, limits, prices, tiers and route — instead of the previous
  `{ id, reasoning, input }` stub that made pi show every model as
  128K/16.4K/no-images.
- `generate-opencode.mjs` (the opencode-harness renderer) consumes
  opencode-go too. Its config shape has no per-model api field, so the route
  work stops here; the retired-entry filter does not (zen publishes 84 ids
  instead of 134), because a dead catalog entry is dead for every consumer.
- **Zen (`opencode`) is listing-driven too** (d064: best-effort, no longer
  superficial). Its keyed `/models` answers 35 rich rows against 86 keyless
  and 134 catalog (84 alive), so pi emits 35 described records where it used
  to emit 88 stubs; pi keeps its built-in records for the ids the listing
  never offers. A keyless or dead-route run publishes the reroute alone.
  zen calls themselves answer `402 Insufficient balance` — the Go
  subscription does not fund zen — so the listing describes the key's
  visible set, not a paid one.

## Verification

Measured against the live surfaces (`https://opencode.ai/zen/go/v1/models`):

| source                       | ids |
| ---------------------------- | --- |
| keyed listing (this account) | 25  |
| unkeyed listing              | 30  |
| `go.mdx` `## Endpoints`      | 32  |
| pi's bundled `opencode-go`   | 32  |

`docsOnly` = the five key-blocked ids above plus `mimo-v2.5` /
`mimo-v2.5-pro` (also absent from the keyed listing); `liveOnly` = 0.
`pi --list-models opencode-go` prints the listing's own limits (1.0M /
384K / images) where the previous stub printed 128K / 16.4K / no-images, and
`pi -p` answers through two dialects (`deepseek-v4-pro` on
`openai-completions`, `minimax-m3` on `anthropic-messages`).

Zen (`https://opencode.ai/zen/v1/models`) reads the same way, one tier down
(d064):

| source               | ids |
| -------------------- | --- |
| keyed listing        | 35  |
| unkeyed listing      | 86  |
| catalog (alive)      | 84  |
| pi's bundled records | 89  |

Each of the 35 declares exactly one dialect (28 `chat-completions`, 4
`responses`, 3 `messages`), so the route is per model there too; the 54 ids
pi bundles but the keyed listing omits keep pi's records, and `pi -p` on a
zen id answers `402 Insufficient balance` — a key that SEES a model need not
be able to pay for it, which is why the tier is best-effort.

`piModel` output is byte-identical to pi's bundled record for
`glm-5.3`, `grok-4.7` (500K limits, `>200K` tier 4/12/1),
`minimax-m3` (`>512K` tier 0.6/2.4/0.12), `gemini-4-argon`,
`qwen3.8-max` and `beam-free` — except `beam-free`'s all-zero price block,
which pi publishes and d057 omits.
