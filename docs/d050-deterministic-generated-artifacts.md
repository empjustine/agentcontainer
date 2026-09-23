---
id: d050
type: architecture-design
status: implemented
title: "d050 — deterministic (canonical) generated artifacts: stable ordering for manifests and caches"
parent: coding-agent
depends-on: [coding-agent, lib]
references: [d023, d024, d033, d037, d040, d041, d048]
tags: ["generators", "artifacts", "canonical-json", "determinism", "models.json"]
---

# d050 — deterministic (canonical) generated artifacts

status: implemented 2026-09-23 (decisions recorded below) · relates-to:
d023, d024, d033, d041

## Motivation

Every generated manifest is declared to be the source of truth
(`lib/artifact.mjs` `@fileoverview`: "generators are the source of truth; a
rerun overwrites the deployed artifact"). But a rerun over unchanged inputs
does **not** produce unchanged bytes, because the order of the container and
of the collection arrays is incidental to how the data was assembled rather
than part of what the file means. The consequences are all review and drift
problems:

- **Noisy diffs.** One upstream model change re-serializes an entire
  provider block because the surrounding ids shifted, so the real change is
  buried; a reviewer cannot tell "content changed" from "order changed".
- **False change signals.** Install/merge stages, vaultless reruns, and
  cross-host snapshots treat an ordering permutation as a change, so
  "regenerate and compare" stops being a useful drift detector.
- **Unreviewable commits.** The one-time reformat that any canonicalization
  causes is indistinguishable from a content change under the current
  format.

The repo already values append-only, reviewable artifacts (d042) and the
generator-as-source-of-truth contract (d023). Deterministic output is the
missing half of that contract: the same inputs should mean the same bytes.

## Current state at decision time — where the churn came from (now fixed by this change)

### Provider-map key order

| Artifact | How the provider map is built | Deterministic? |
|---|---|---|
| `model-012-cloud-pi-native.json` | shared `providers` object mutated by concurrent `emitOverrideOnly` tasks under `Promise.allSettled` | **No — completion-order, can permute per run** |
| `model-010/015/016/017-*.json` | `providerBlock()` writes a single-provider object | Yes (one key) |
| `models.json` (merged) | `deepMerge()` over filename-sorted layers; key order = first layer that defines it | Yes, but reflects layer order, not any intent |
| `coding-agent/opencode.jsonc` | provider object built during the opencode cascade | Yes, insertion order |
| `llm-reverse-proxy/llm-reverse-proxy.json` | `allowHosts` follows the `CLOUD_PROVIDERS` fact-table order (plus hand-added rows) | Yes, but not sorted |

The `model-012` row is the only *genuinely nondeterministic* one: the
assembly is parallel by design (d034), and `emitOverrideOnly` writes into a
shared object, so the key order is the order the promises happened to settle.
An otherwise identical run can emit `google, openrouter, mistral, …` or any
permutation of it.

### Model-array order (never sorted; always source order)

Every `models` array is a projection of whichever source won the cascade,
and none of the sources promise an order:

| Path | Array order inherited from |
|---|---|
| catalog path (`catalogPiModel`, `emitFullAt`) | `Object.entries(provider.models)` — the models.dev JSON key order |
| live listing (`enrichWithLiveListing`, `listingModels`) | the provider's `/models` listing order |
| facts cache (`enrichWithFacts`) | upstream `/provider` order |
| minimal override (`emitMinimalCatalogOverride`, `catalogModelIds`) | models.dev keys then catwalk ids (`Set` insertion) |
| d040 union (`resolveClinePassAllowlist`) | docs order then catalog-only ids |
| local GGUF (`generateLocalLlamaSwap`) | the peer listing order |

Field order *inside* a model record is not a problem: records are built by
object literals in `catalogPiModel`/`piModel`, so their keys are already
stable and in a deliberate human order (`id`, `name`, `reasoning`, …).

### Caches

`lib/catwalk-facts.json`, `coding-agent/hyper-facts.json`, and
`lib/models.dev.api.json` are provenance copies. They carry `fetchedAt`/
`ageMs` and mirror upstream order, so they can never be byte-stable and are
not targets of this change (a cache that reorders is still the same cache).

## What "canonical" means here

Two concerns that must not be conflated:

1. **Serialization stability** — whitespace and object-key order. This is
   mechanical and safe: `JSON.stringify` is already deterministic for a
   given object; the only instability is insertion order.
2. **Semantic collection order** — which arrays are *sets* (order carries no
   meaning) versus *sequences* (order does). This is schema-aware. A generic
   recursive "sort all arrays" rewrite would silently reorder `modalities.
   input` (`["text","image"]`) and `thinkingLevelMap` value arrays, so it is
   rejected.

## Change (implemented 2026-09-23)

Canonicalize the manifests with one schema-aware helper and route every
manifest write through it.

### 1. One shared helper in `lib/`

`lib/` is the copy unit (AGENTS.md), and `lib/artifact.mjs` already owns the
atomic-write contract, so the canonicalizer lives beside it in a sibling
`lib/canonical-json.mjs` (decided: sibling module, not inside
`artifact.mjs`); `artifact.mjs` adds `writeJsonArtifact` and re-exports the
pure helpers:

```js
// Sort only the DYNAMIC maps and the set-shaped collection arrays.
// Record field order and inner modality/effort arrays are left as
// constructed — they are already deterministic and semantically ordered.
export function canonicalizeManifest(doc) { … }

export function writeJsonArtifact(out, value) {
  return writeArtifact(out, `${JSON.stringify(canonicalizeManifest(value), null, 2)}\n`);
}
```

### 2. Rules

| Location | Rule |
|---|---|
| `doc.providers` keys (pi/opencode manifests) | sort ascending |
| `doc.provider` keys (opencode's outer shape) **and each entry's `models` record keys** | sort ascending |
| `doc.allowHosts` keys (`llm-reverse-proxy.json`) | sort ascending |
| `providers[*].models` arrays | sort by `id` |
| `default-model.json` (`{defaultProvider, defaultModel}`) | no collection — unchanged |
| everything else (record fields, modality/effort arrays, `headers`) | untouched |

Use a **code-unit comparator** (`a < b`), not `localeCompare`, so the result
does not depend on the host locale.

### 3. Why not a generic deep key-sort

Sorting every object key recursively would move `id` out of first position in
each model record (alphabetically it would sit after `cost`/`contextWindow`),
which is a readability regression for a human-reviewed artifact. Sort only
the maps whose key order is incidental; leave the record schema alone.

### 4. Write-time, not construction-time

Every builder assembles its doc and hands it to one writer, so the single
choke point is the write. Sorting at construction would have to be repeated
in each emit path (`emitFullAt`, `emitMinimalCatalogOverride`,
`emitOverrideOnly`, `generateLocalLlamaSwap`, `mergeModels`, the opencode and
proxy generators) and would allow the next builder to forget.

## Format: pretty, one-line-per-model, or NDJSON

True NDJSON (`{…}\n{…}`) is **not valid JSON**, so it cannot be the manifest:
`readJson`/`deepMerge`, pi's own `models.json` parser, and every downstream
consumer would break. A true NDJSON artifact is at most an optional
**sidecar** for diff tooling, and is not proposed here.

The diff-stability that motivates NDJSON is available while staying valid
JSON, because JSON treats newlines between tokens as insignificant:

- **sorted + pretty** (the minimum): removes ordering churn and localizes a
  one-model change to roughly one model block.
- **sorted + one-line-per-model** (the maximum): emit each element of a
  `models` array compact on its own line, so a one-model change is exactly
  one line in the diff.

Both are valid JSON. **Decided:** sorted + pretty; the one-line-per-model
variant is discarded — the extra serializer complexity is not worth a
diff-granularity gain, and `JSON.parse` consumers never see either shape.

## Determinism boundary

Canonicalization makes the **ordering** deterministic; it cannot make the
**content** reproducible across time or hosts. Output remains live data — a
new upstream model, a price change, or a refreshed listing still changes the
file, and that is correct (the generator is the source of truth). "Stable"
here means "a rerun over unchanged inputs is byte-identical", not
"reproducible without the network".

## Scope

**In:** the pi model manifests (`model-*`, `models.json`),
`coding-agent/opencode.jsonc`, and
`llm-reverse-proxy/llm-reverse-proxy.json`.

**Out:** the provenance caches (`catwalk-facts.json`, `hyper-facts.json`,
`models.dev.api.json`) and `refresh-models-dev.mjs`'s catalog dump, which
should mirror upstream rather than be reordered; `default-model.json`
(**decided: out of scope** — it has no collections, so nothing to sort);
and `llm-local-inference/`'s config.d layers (never in scope; candidate
follow-up if their ordering churns).

Note the existing partial determinism this builds on: `mergeModels` already
discovers layers through `readdirSync(...).sort()`, so layer *precedence* is
stable today; only the provider and model orders inside the merge are not.

## Migration (landed 2026-09-23)

- One-time reformat of all 8 committed in-scope files through
  `serializeArtifact`: 6 reordered, `model-010` and `opencode.jsonc` were
  already canonical; per-file content-preservation (canonical-vs-canonical
  deep-equal) and idempotency were checked before each write.
- Tests: `tests/canonical-json.test.mjs` (`node --test`) — the unit
  test for `canonicalizeManifest` plus a **committed-manifest canonicity
  guard** over the 8 files. The guard supersedes the golden double-run this
  doc originally proposed: it needs no pinned `MODELS_DEV_JSON` and still
  fails loudly when a write path bypasses the choke point or a hand edit
  reorders a manifest.
- Staging lists: the new `lib/canonical-json.mjs` had to be added to both
  hand-maintained lib/ staging lists — `coding-agent/generate.mjs`'s
  scratch-lib copy loop and `coding-agent/run.sh`'s `/opt/lib` mounts —
  or every staged run dies on `artifact.mjs`'s import of it (the failure
  `run.sh`'s comment already records for `artifact.mjs` itself, repeated).
  `tests/lib-staging.test.mjs` derives what must be staged from the code
  (`${LIB_DIR}` refs ∪ transitive sibling imports) and fails if either list
  drifts.
- Pointers: `lib/artifact.mjs`'s `@fileoverview` CANONICAL bullet → this
  doc; this doc → `lib/canonical-json.mjs` and the test in References.

## Decisions (settled 2026-09-23; were open questions)

- **Scope.** All three artifact families: pi manifests, `opencode.jsonc`,
  `llm-reverse-proxy.json`. `default-model.json` out (no collections).
- **Format.** Sorted + pretty. One-line-per-model discarded.
- **Field order.** Left as constructed (the recommendation) — `id` stays
  first in every model record.
- **Caches.** Confirmed out — they carry timestamps and mirror upstream
  order regardless.
- **Sort key.** Plain code-unit `id` sort, no natural/semver awareness.
- **`models.json` provider order.** Sorted; the "pi does not treat provider
  order as meaningful" assumption was accepted as the decision rather than
  re-verified against pi's merge semantics before the reformat.
- **Helper shape.** Sibling `lib/canonical-json.mjs` exporting pure
  `canonicalizeManifest`/`serializeArtifact`, with `writeJsonArtifact` on
  `lib/artifact.mjs` fusing serialization into the one write choke point.

## References

- `lib/canonical-json.mjs` — the canonicalizer (rules in code).
- `lib/artifact.mjs` — the atomic-write + `writeJsonArtifact` contract
  (d023) this extends.
- `tests/canonical-json.test.mjs` — unit rules + committed-manifest
  canonicity guard.
- `tests/lib-staging.test.mjs` — staging-list drift guard (see Migration).
- `docs/d023-generators-dedup.md`, `docs/d024-generators-split-and-provider-facts.md`
  — the generator/artifact standards.
- `docs/d033-generator-cascade.md`, `docs/d034-parallel-probing-and-multi-hop-peerBase.md`
  — the cascade and the parallel assembly that makes `model-012` key order
  nondeterministic.
- `docs/d037-generator-merge-verdict.md`, `docs/d041-unified-generate-build-entrypoints.md`
  — which generators exist and how the merge stage runs.
- `docs/d040-cline-pass-curated-lineup.md` — the union path whose `Set`
  insertion order ends up in the models array.
- `coding-agent/generate-pi-coding-agent.mjs` (`providerBlock`, `deepMerge`,
  `mergeModels`, `emitFullAt`, `emitMinimalCatalogOverride`,
  `emitOverrideOnly`, `generateLocalLlamaSwap`),
  `coding-agent/generate-opencode.mjs`, `llm-reverse-proxy/generate.mjs`.
