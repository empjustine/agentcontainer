---
id: d098
type: module-design
status: draft
title: "d098 — hiding models from a builtin pi provider: the filterModels seam, and what the shadow costs"
parent: coding-agent
depends-on: [d096, d097, d105]
references: [d025, d028, d032, d049]
tags: ["providers", "pi", "extensions", "openrouter", "model-catalog", "draft"]
---

# d098 — hiding models from a builtin pi provider

**Status: DRAFT — findings and a spike, nothing shipped.** This record answers
a design question against pi's own source: _what would be necessary, in an
extension, to show only certain models for pi's builtin `openrouter` provider —
never display certain types — without re-implementing (indirectly) what
`coding-agent/generate-pi-coding-agent.mjs` does?_ Source: the reference
farm's `github.com/earendil-works/pi.git` pinned at `d5b3de2` (2026-10-25),
docs at pi 1.4.0 (d043/d044's mirror rule — cite the pin, not "latest"), and
re-read at the installed pi 1.5.0 for the seam the spike exercises. Each part
is named below: the mechanics, the routes that provably fail, the one viable
route, the catalog data a hidden set could key on, and the cost that keeps
this a draft.

## Problem

Pi decides which models `/model` offers from each provider's catalog, and
the builtin `openrouter` provider serves everything upstream does — chat,
image models, free-tier variants. The ask is categorical hiding: certain
families or model types should never appear for that provider, ideally
keyed on the credential (the same shape as synthetic's Big-plan gate —
a model the subscription cannot use should not be selectable, d092).

The constraint that shapes every option below: whatever we do must not
become a second, hand-maintained rendering of a provider catalog — that is
the failure mode `coding-agent/generate-pi-coding-agent.mjs` carries by
necessity (it shapes rows from raw fact-table data) and the one
`pi-synthetic` (d096) exists to avoid. A filter that requires enumerating
and re-declaring every kept model IS that re-implementation, whatever the
file is called.

## Findings — what pi actually does

All line numbers cite the pin above.

- **The list `/model` renders** is `modelRuntime.getAvailableSnapshot()`
  (`modes/interactive/components/model-selector.ts:162`), filled by the
  availability passes from `Models.getAvailable()`.
- **The designed hook** is `Provider.filterModels`
  (`packages/ai/src/models.ts:199-203`), applied per provider at
  `models.ts:721`:

  ```ts
  return provider.filterModels?.(models, credential) ?? models;
  ```

  Two properties make it exactly the right seam: it runs **after the
  provider's auth resolved** (an unconfigured provider contributes nothing
  anyway), and it receives the **credential** — so hiding can be
  subscription-aware, not just id-pattern-aware. The interface contract is
  explicit: `getModels()` stays the complete catalog; the filter is an
  availability policy.

- **The type trap:** `Models.getAllAvailable()` (`models.ts:744-751`)
  uses `filterAllModels` when present; **without it, only chat rows are
  intersected with `filterModels` and every other model type passes
  through.** OpenRouter serves image models under the same provider id
  (docs/models.md:188), so hiding "certain types" requires **both** hooks —
  one hook hides chat models only.
- **The composition** (`core/provider-composer.ts`,
  `composeModelProvider`): builtin base → `models.json` → legacy
  extension overlay → `modelOverrides` (topmost, metadata only). The
  composed provider passes `filterModels`/`filterAllModels` through
  **only from the base** (`provider-composer.ts:641-646`). The extension
  overlay layer has no filter channel of its own.
- **Who is base:** `composeProvider` picks
  `nativeExtensionProviders.get(id) ?? builtins.get(id)`
  (`core/model-runtime.ts:310`). A native `Provider` registration
  (the non-string `pi.registerProvider(provider)` form) lands in
  `nativeExtensionProviders` (`model-runtime.ts:899-910`) and
  **shadows the builtin**; `pi.unregisterProvider(id)`
  (`model-runtime.ts:959`) restores it. `models.json` and legacy
  overlays still compose above the shadow — pi's docs: "Pi composes
  `models.json` overrides above a registered native provider."

## Routes that provably do not work

| Route                                                         | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.json`                                                 | No exclusion exists: `models` upserts by id, `modelOverrides` edits metadata; unknown override ids are ignored (docs/models.md:67). A builtin entry cannot be removed.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Legacy `pi.registerProvider("openrouter", { models: [...] })` | Two failures. (1) `ProviderConfigInput` has **no filter field** (`provider-composer.ts:96-116`), and the composer only forwards a filter from the base (see Findings). (2) Supplying `models` **replaces the whole catalog** (`applyExtension`, `provider-composer.ts:346-356`) and every definition must carry `id/name/input/cost/reasoning/contextWindow/maxTokens` — enumerate-and-redeclare, i.e. exactly the re-implementation the Problem guards against. d097 already relies on this replace semantics from the other side: an omitted id disappears from `/model`. |
| `oauth.modifyModels`                                          | Chat-only, requires taking over the provider's oauth config, and runs only when the active credential came from OAuth — fragile and partial, not a seam.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| An event that filters the list                                | None exists. The event surface (`extensions/types.ts:1601-1668`) has `model_select` (observe a selection) and no list-transform event.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## The viable route (draft proposal)

Register openrouter as a **native `Provider`** that spreads the builtin and
adds **both** filters — no catalog re-declaration, because auth, streaming,
headers and refresh are inherited from the spread object:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export default function (pi: ExtensionAPI) {
  const base = builtinProviders().find((p) => p.id === "openrouter");
  if (!base) return;

  const hidden = (m: { id: string; type?: string }) => m.type === "image" || m.id.endsWith(":free"); // the actual criteria

  pi.registerProvider({
    ...base,
    filterModels: (models, credential) => models.filter((m) => !hidden(m)),
    filterAllModels: (models, credential) => models.filter((m) => !hidden(m)),
  });
}
```

Supporting facts:

- `@earendil-works/pi-ai/providers/all` is a **virtual module** — mapped
  in both source and compiled-binary runtimes (`extensions/loader.ts:98-114`,
  `extensions/virtual-modules.ts:31`), so the spread works wherever pi
  runs; no npm dependency is added.
- Register in the factory: pi waits for async factories, so the provider is
  in place for startup model selection and `pi --list-models`.
- The `credential` parameter is deliberately accepted and unused in the
  sketch — it is where subscription-tier hiding (the Problem's motivation)
  would go.

## What the catalog can and cannot classify

A hidden set is a policy, and the question that decides its shape is where
"proprietary" comes from. Not from a vendor field: a recursive key scan of
`https://models.dev/catalog.json` finds neither `lab` nor `proprietary`. The
document is two halves — `providers` (identical to `/api.json`, 5.97 MB, 235
entries) and `models` (identical to `/models.json`, 0.51 MB, 609 entries keyed
`<lab>/<model>`) — and the repo vendors the first half only
(`coding-agent/lib/models.dev.api.json`, d025).

- **`.models` keys**, complete: `attachment benchmarks description family id
  knowledge last_updated license limit links modalities name open_weights
  reasoning release_date temperature tool_call type weights`. Provider-model
  entries add `canonical_model_id cost interleaved reasoning_options provider
  status`. Both schemas are closed (`ModelMetadata` in
  `packages/core/src/schema.ts`, `LabModelV2` in `packages/core/src/schema-v2.ts`),
  so a new distinction is a schema change, never a payload surprise.
- **Lab is derived from the canonical-id prefix.** models.dev's own `labID()`
  (`packages/core/src/describe.ts`) splits the id on `/` and normalizes an
  alias table (`x-ai`→`xai`, `qwen`→`alibaba`, `mistralai`→`mistral`,
  `meta-llama`→`meta`, …). The per-lab files (`labs/<lab>/lab.toml`) hold a site
  description, and the schema says of them "not part of the v1 or v2 API
  output".
- **Proprietary is `open_weights === false`**: 295 of 609 models closed, 314
  open, none absent. `license` cannot stand in for it — 121 of 609 carry a
  license at all and exactly one says "Proprietary".
- **Both facts already ride the vendored half**: every provider-model entry
  carries `open_weights`, `canonical_model_id` and `family` beside `api`,
  `env` and `cost`. The `.models` half adds per-canonical-model `license`,
  `weights`, `benchmarks`, `knowledge` and `limit` — enrichment detail, not a
  classifier the provider half lacks.

Measured against the composed `opencode` and `opencode-go` catalogs
(2026-11-08), the honest classification is stricter than the requested one:

- the five vendor labs (`anthropic`, `google`, `openai`, `xai`, `meta`) are a
  **strict subset** of closed weights. Over models.dev's own provider blocks that
  is 60 of 134 rows on `opencode` against 70 closed, and 8 of 39 on
  `opencode-go` against 14. pi's composed catalogs hold 134 and 31 rows, and the
  spike's id-prefix predicate hid 60 and 7 of them. The remainder is not an edge case:
  Alibaba `qwen3.8-max`/`qwen3.8-plus`, Xiaomi MiMo, Tencent `hy4`, Moonshot
  `kimi-k3.1-pro`, Meituan longcat, Mistral `mistral-large-4`, ThinkingMachines
  `inkling-2-small`. "The five labs" and "proprietary" are different policies, and
  only one of them is five names long.
- a canonical-id predicate leaves rows it cannot classify: in models.dev's
  blocks, 13 of the 134 `opencode` rows and 4 of the 39 `opencode-go` rows
  carry no `canonical_model_id` (the unpublished `*-free` ids plus
  `big-pickle`). Whoever
  owns the policy owns that decision explicitly.

**The classification cannot reach `filterModels`, which is what decides the
shape.** pi's model rows are a fixed whitelist (`modelFromJson`), so an extra
field on a generated row is dropped silently rather than rejected; and in the
composed catalog every generated row carries
`baseUrl: https://opencode.ai/zen/v1` — the builtin's per-vendor
`/inference/<lab>` prefix is flattened — while `api` spans vendors
(`openai-completions` covers gpt, qwen and mimo alike). `id` and `name` are the
only discriminators the filter receives. A data-driven hidden set therefore has
to be **baked** at one of three points: a generated id list inside the
extension (model data in a folder that carries none, and a list that drifts —
the vendored snapshot classifies 80 opencode rows as closed where the live
catalog says 70, because rows gain canonical links), an upstream
`filterModels` config field (alternative B), or a fetch-and-join at refresh
time (a second network dependency in a freshness path, and fail-open when
offline).

A five-name lab list needs none of that: it is a decision with a natural
encoding, it hides 60 and 7 rows, it leaves the proprietary-but-open-lab rows
visible, and it never regenerates. The cheap way to keep that difference from
rotting is an `--check` over the vendored `open_weights` that lists closed
rows the predicate does not hide — an audit, not a data path.

## The cost — why this stays a draft

openrouter's builtin is **not** what `builtinProviders()` returns: at
construction every builtin is wrapped, and openrouter specially so
(`model-runtime.ts:229-241`):

- `withPersonalizedCatalog` (`core/remote-catalog-provider.ts:195`) —
  on each refresh it fetches pi.dev's catalog, merges it over the bundled
  list, runs `personalizeOpenRouterCatalog` ("narrows the catalog to the
  models, limits and prices of the user's key") and **persists the
  personalized result**; that saved list replaces the catalog even offline.
- other providers get `withRemoteCatalog` — the 4-hourly pi.dev overlay
  with etag revalidation.

Both wrappers are **internal**: not exported through
`@earendil-works/pi-coding-agent` (`src/index.ts`), so a wrapper built
from the raw `builtinProviders()` spread cannot re-apply them. The native
shadow therefore trades:

**key-personalized, periodically refreshed catalog → static bundled
snapshot + the predicate.**

Acceptance of that trade is the open question that gates this record.
Remaining consequences:

- The filter governs **availability surfaces** only (`/model`, the
  `getAvailableOfType` helpers). `ctx.modelRegistry.getAll()` still
  returns the full catalog — "hidden" is not "absent" for a tool that
  asks for everything.
- A session whose **active** model the filter hides is unverified
  (see Verification status) — the snapshot drives the selector, so the model
  may vanish from `/model` while still being the session's model.
- Shadowing is reversible: `pi.unregisterProvider("openrouter")` (or
  `/reload` without the extension) restores the builtin exactly
  (`model-runtime.ts:959-966`).

## Alternatives considered

- **A — chained `refreshModels` overlay (keeps personalization).** The
  composer always runs `base.refreshModels` first and then the
  extension's, and the extension's returned list replaces — so the
  personalized fetch still happens and persists; the overlay then projects
  and filters the models into `ProviderModelConfig[]`. Cost: a field-by-field
  `AnyModel → ProviderModelConfig` projection is a drift surface the day
  pi adds a field — a smaller dose of the very re-implementation the Problem rejects —
  plus `context.stored` is the pre-refresh snapshot, so the projection is
  one cycle behind the personalization it reads.
- **B — upstream filter field (the clean fix).** A
  `filterModels`/`filterAllModels` field on `ProviderConfigInput`,
  forwarded beside the base's in `composeModelProvider`, would make the
  whole request a ten-line overlay: no shadow, no catalog loss, no
  re-declaration. pi is the first-class harness whose config semantics
  define the contract (d105), so shaping this need into an upstream
  contribution is the legitimate route rather than growing a local
  workaround; preferred over the shadow route whenever the work is undertaken.
- **C — do nothing.** openrouter's personalization already narrows to what
  the key can use. Sufficient if the goal is "no unusable models";
  insufficient only for categorical hiding (never image / never `:free` /
  never a family), which personalization does not promise.

## Verification status

- **Done:** every claim from Findings through the cost analysis read from
  source at the pin, with file and line; the docs' own statements
  (custom-provider.md's "Pi composes `models.json` overrides above a
  registered native provider", models.md:67) cross-checked against the
  implementation.
- **Re-read at pi 1.5.0.** The shipped `pi` is one 122 MB non-stripped bundle
  with no `dist/` on disk, so the seam was re-extracted from it: unchanged —
  `Models.getAvailable()` is `provider.filterModels?.(models, credential) ?? models`,
  `getAllAvailable()` prefers `filterAllModels` and falls back to intersecting
  chat ids only, and `composeModelProvider` copies a filter from the base alone.
- **Spike (2026-11-08), which answers (a) for the two opencode providers.** The
  native shadow form of the viable route
  (`{ ...builtinProviders().find(p => p.id === id), filterModels, filterAllModels }`)
  composed `--list-models` from 134 → 74 rows for `opencode` and 31 → 24 for
  `opencode-go`: 60 and 7 hidden, no non-target row lost. The control matters as
  much as the result — the legacy overlay form
  (`registerProvider(id, { refreshModels, filterModels })`) left the listing
  byte-identical at 67 vendor rows, silently, because the overlay layer has no
  filter channel.
- **(c) bounded, not open.** For these two providers the pi.dev remote catalog
  adds only `crouton-alpha-free` and `pulse-alpha-free` (`opencode`; plus
  `hy4` for `opencode-go`) and drops none, so the shadow's catalog loss is the
  4-hourly overlay on three unpublished ids, not a row set.
- **Still open**, which is why the record stays a draft: (b) an image or
  classifier row absent only with `filterAllModels`; (d) the policy for a session
  whose active model the shadow hides; (e) `unregisterProvider`/`/reload`
  restoring the builtin; and the catalog trade itself — static bundled snapshot in
  place of the personalized, periodically refreshed list.
