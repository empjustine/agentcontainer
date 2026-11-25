---
id: d239
type: module-design
status: active
title: "d239 — generator/extension parity: every provider the pi generator emits has an extension, and what stays generator-only"
parent: coding-agent
depends-on: [d100, d190, d235]
references: [d024, d036, d049, d057, d061, d064, d070, d096, d113, d118, d189, d191, d192, d238]
tags: [providers, pi, extensions, coding-agent, parity, generator, inferx, llama-swap]
---

# d239 — generator/extension parity

The pi generator and the `pi-*-provider` extensions describe the same providers
through two different mechanisms: committed artifacts on one side, a
`registerProvider` + `refreshModels` package on the other. This record states the
coverage those two must keep, closes the two provider gaps it found, and names
the rest so a later reader does not have to reconstruct "why is this missing".

## Problem

A host that has a generated agent dir sees every fleet provider; a host that has
none (a bare host, `pi -e`, a container that mounts only a work directory) sees
only what an installed extension registers. Nothing compared the two sets, so a
provider could exist in one surface and silently not in the other:

- **`model-017-cloud-inferx.json` had no extension folder at all.** InferX is a
  full row (pi does not ship it), so without the generated dir the provider does
  not exist for that session.
- **`pi-coding-agent-provider` registered four of the fact table's six
  `PI_NATIVE_CLOUD_IDS`.** `google` and `nvidia` had a canonical base-URL layer in
  `model-012-cloud-pi-native.json` and no override env in the extension, so an
  operator retargeting them worked in one surface only (docs/d235).
- **The local farm had two price stories and no price source.** `gen-lib.mjs`'s
  `piModel` read `meta.llamaswap.cost` through `piCost`, while the unit that
  serves those rows — `llm-local-inference/30-generate.mjs` — writes exactly
  four metadata keys (`reasoning`, `input`, `contextWindow`, `maxTokens`) and no
  price at all. The extension filled the mandatory zeros, which was the correct
  output from a branch the producer never feeds.

## Decision

### The provider sets, by generator layer

| Generator artifact                | Provider id(s)                                             | Extension                  | Parity                     |
| --------------------------------- | ---------------------------------------------------------- | -------------------------- | -------------------------- |
| `model-010-local-default.json`    | `llama-swap`                                               | `pi-tlalocayotl-provider`  | same upstream, two ids     |
| `model-012-cloud-pi-native.json`  | google, mistral, nvidia, opencode, opencode-go, openrouter | `pi-coding-agent-provider` | base URL only (docs/d235)  |
| `model-015-cloud-cline-pass.json` | `cline-pass`                                               | `pi-cline-pass-provider`   | one source, one shaping    |
| `model-016-cloud-hyper.json`      | `hyper`                                                    | `pi-hyper-provider`        | one source, one shaping    |
| `model-017-cloud-inferx.json`     | `inferx`                                                   | none                       | **open** (see below)       |
| `model-018-cloud-verboo.json`     | `verboo`                                                   | `pi-verboo-provider`       | one source, one shaping    |
| `model-019-cloud-synthetic.json`  | `synthetic`                                                | `pi-synthetic-provider`    | one source, one shaping    |
| `models.json` (merged layer cake) | all of the above                                           | pi's own provider registry | not applicable             |
| `default-model.json`              | the operator's default pair                                | none                       | generator-only (docs/d036) |
| `opencode.jsonc`                  | opencode's own providers                                   | none                       | different harness          |
| `mcp.json`                        | MCP servers, not providers                                 | none                       | not a provider surface     |

The rule the table encodes: **every provider the pi generator emits needs an
extension folder**, and a new `PI_NATIVE_CLOUD_IDS` row needs a row in
`pi-coding-agent-provider`. The reverse is not required — the extension family
may lead (docs/d100's provenance rule and `pi-neuralwatt-provider` do).

### What this change closes

- **`pi-coding-agent-provider` covers all six pi-native ids**: `google`
  (`GEMINI_API_KEY` → `GEMINI_BASE_URL`) and `nvidia` (`NVIDIA_API_KEY` →
  `NVIDIA_BASE_URL`) join the four existing rows. The names are pi's own provider
  env names (`getApiKeyEnvVars` in the installed host), so the gate reads the
  variable pi itself would use.
- **The local farm's price path is one path, and it is empty.** The serving unit
  publishes no prices by construction, so `gen-lib.mjs`'s `piModel` lost its
  `meta.llamaswap.cost` branch and `route-probe.mjs`'s `LlamaSwapMeta` lost the
  field: a price reaches pi only from a rich gateway listing (`listingCost`,
  docs/d048). `pi-tlalocayotl-provider` keeps filling the registration's
  mandatory zeros, which is the honest rendering of "this farm charges nothing"
  (docs/d057).

### What stays generator-only, on purpose

Each line here is a decision with an owner, not an omission:

- **The committed lineup and its freshness gate.** No extension commits a
  lineup; `refreshModels` is the only source (docs/d190), and the d190 amendment
  deleted the per-folder `models.json`. The layer cake, the lexical merge order
  and `models.json` are the generator's review surface (docs/d050, d191).
- **The model-data cascade** — models.dev, catwalk, the live-listing probe that
  only picks the lineup source, `catalogOptional`/`lineupFromFacts`/`lineupOnly`,
  the `deprecated` filter and the modality gate. Each extension reads one
  provider-owned source and applies the same shaping rules to it (docs/d049,
  d096, d189, d190, d191); the cascade exists because one generator writes many
  providers, which no folder does.
- **Routing.** Both surfaces read the canonical upstream verbatim and ride the
  environment proxy (docs/d070, d074). No extension carries route machinery.
- **The default-model overlay** (the operator's hardcoded pair, docs/d036) and
  **the `mcp.json` merge** (docs/d061) are install state for an agent dir, not
  provider claims a package can make.
- **The opencode config** is another harness's file; the pi extensions are not
  clients of it.
- **Model data for pi-native providers.** A list on the registration REPLACES
  pi's catalog (docs/d097, d235), so `pi-coding-agent-provider` forwards
  `baseUrl` only. The fleet's prices, limits and `cost.tiers` for
  opencode/opencode-go exist only in the generated artifact; a host without the
  agent dir gets pi's built-in catalog (`pi update --models`), which is the
  substitution d235 chose.
- **OpenRouter's lineup is keyed on pi's side and keyless on the generator's.**
  pi refreshes `openrouter` from `{baseUrl}/models/user` with the caller's
  bearer, so the ids, limits and prices a user sees are the ones that key may
  use (`withPersonalizedCatalog`, `docs/providers.md` in the installed host).
  The generator probes the keyless `/models` and scopes it to `:free`
  (`MODEL_SCOPES`), so `model-012`'s openrouter slice is a different set by
  construction. Both are correct for their surface; the extension changes
  neither, because it forwards `baseUrl` and `provider-composer` keeps the
  built-in `refreshModels` underneath.

### The open gaps

- **InferX has no extension.** The provider's listing is at its canonical
  upstream's `/models` with the fleet's bearer (the generator probes it and
  recorded 11 ids, docs/d115), and it answers `401` to a keyless probe. A keyed
  verification run from this host returned `401 invalid auth token`, so the
  folder was not written: the family's one-source rule needs a listing this repo
  can actually observe, and inventing the payload shape from `piModel`'s rich
  vocabulary would be a wire claim nobody checked. Landing it needs a working
  `INFERX_API_KEY` and follows `pi-verboo-provider`'s shape.
- **The synthetic compat divergence.** `pi-synthetic-provider` sets
  `compat.supportsReasoningEffort` from the published effort enum; `model-019`'s
  row carries no compat block, so the fleet artifact leaves that flag to pi's URL
  auto-detection. The extension is the side with evidence (the listing publishes
  the enum); aligning the generator is a regeneration, recorded in
  `pi-synthetic-provider/README.md`.
- **One farm, two provider ids.** The fleet layer registers `llama-swap`, the
  extension registers `tlalocayotl` (docs/d238 keeps both names). A host with
  the agent dir AND the extension installed sees two providers for one upstream.
  Renaming either is a user-visible change to a committed artifact and was not
  taken here.
- **The local layer states no `authHeader`.** The extension sends the measured
  `Authorization: Bearer` for the gateway; `model-010-local-default.json`
  carries no `authHeader`, so pi there falls back to its default. The extension
  states the fact the artifact omits; fixing the artifact is a regeneration.
- **Nothing compares the two copies of a row.** Each `pi-*` folder carries its
  provider row as a literal (docs/d113) and `coding-agent/lib/cloud-providers.json`
  carries the generator's copy; a base-URL or key-env edit in one place is caught
  only by that folder's own pinned test. A cross-unit check would have to live
  outside every folder (a root script), and no such gate exists.

### Where the extensions lead

Parity is not one-directional, and these are the reasons a generator change is a
separate, later decision:

- `pi-neuralwatt-provider` (a provider with no fleet row) reads `inputLimits` and
  emits `samplingParams`; the generator emits neither anywhere.
- The extension family throws on an unreadable source (docs/d192); the generator
  writes an empty layer and logs.
- Several extensions state compat or thinking facts the corresponding artifact
  omits, each named at its folder (hyper's transcribed mirror, tlalocayotl's
  `authHeader`, synthetic's `supportsReasoningEffort`).

## Consequences

- A bare host and a generated agent dir now cover the same provider SET for
  every provider that has an extension; InferX is the one stated exception.
- The pi-native extension's row table is now the fact table's
  `PI_NATIVE_CLOUD_IDS` set, so the two move together (both lists are pinned by
  their own tests).
- The local farm has ONE price story: the serving unit publishes none, and both
  renderings state pi's mandatory zeros. A price in that metadata block is no
  longer read anywhere, so re-adding one changes nothing (the producer's own
  comment says why the absence stays).
- InferX remains missing by decision. It is the only provider with no path to a
  bare host, and the reason is a credential this repo cannot exercise.

## Verification

- `node --test pi-coding-agent-provider/tests/*.test.mjs` — 7 passing, the row
  table and every override env pinned.
- `node --test coding-agent/tests/pi-cost.test.mjs` — 4 passing; the metadata
  block is asserted NOT to be a price source, and the rich-listing path still
  builds `cost.tiers`.
- `./node-run.sh --test ./*/tests/*.test.mjs` — 434 passing; `biome lint`,
  `oxlint`, `./check-types.sh` and `docs/spec-check.mjs` green.

## Alternatives rejected

- **Write `pi-inferx-provider` from the generator's row vocabulary.** The
  listing is auth-gated, this host's key is rejected, and the family's rule is
  that the provider's own answer is the source (docs/d096/d190). A guessed
  payload shape is exactly the "invented facts" the folders' AGENTS.md files
  forbid.
- **Give `pi-coding-agent-provider` model data so tiers and prices match the
  layer.** A returned list replaces pi's catalog (docs/d097), which is the
  downgrade d235 rejected; the fleet artifact keeps that data.
- **Read `coding-agent/lib/cloud-providers.json` from the extensions.** A folder
  is a copy unit and may not reach into a sibling (docs/d113,
  `docs/architecture.md`).
- **Rename one of the farm's two provider ids in this change.** Both are
  user-visible strings in a committed artifact or a registered provider, and the
  rename belongs with a regeneration and its own record.
