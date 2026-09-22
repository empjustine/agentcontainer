---
id: d046b
type: bugfix
status: implemented
title: "d046b — live-listing input schema poisoning and the committed-snapshot writeback"
parent: coding-agent
depends-on: [lib, coding-agent]
references: [d040, d033, d027, d045]
tags: ["coding-agent", "gen-lib", "models.json", "schema", "input-modalities"]
---

# d046b — live-listing input schema poisoning and the committed-snapshot writeback

**Status:** implemented (the `piModel()`/`toInput()` guard in
`coding-agent/gen-lib.mjs`); the WSL2 machine's already-generated
`~/.pi/agent/models.json` must be regenerated with the fixed generator.

## Symptom

On the WSL2 box, cline-pass consumers (models keyed under `openrouter` in
the strict models.json schema) failed with

```
Error: models.json error: Invalid models.json schema:
- providers.openrouter.models.0.input.2: must be equal to constant
- providers.openrouter.models.0.input.2: must be equal to constant
- providers.openrouter.models.0.input.2: must match a schema in anyOf
- providers.openrouter.models.5.input.2: must be equal to constant
- providers.openrouter.models.10.input.2: must be equal to constant
…
```

The same three paths (`models.0`, `models.5`, `models.10`) repeat →
*three* models carried a 3+ element `input` array whose 3rd element
(`input.2`) was `"video"`/`"audio"`/`"pdf"` — a value the strict schema
does not allow (its `input` items are a const `anyOf` of `"text"`/`"image"`).

## Root cause

1. **The WSL2 run generated from LIVE listings** (uploads/logs.txt,
   2026-09-18 13:59Z): the peer path-route cascade probed the funnel front
   (`http://10.90.17.23:8080/<provider>`) and emitted provider overrides
   from the provider's live `/models` listing — `openrouter=22 models`,
   `cline-pass=13`, `hyper=23`, `inferx=11`, all `baseUrl =
   http://10.90.17.23:8080/<provider>`.
2. **`piModel()` did not schema-filter live modality arrays.**
   `coding-agent/gen-lib.mjs`'s `piModel(entry)` fed
   `entry.architecture.input_modalities` **verbatim** into the emitted
   model entry. OpenRouter's live `/v1/models` carries
   `["image","text","video"]` (gemma-4-31b-it:free), `["text","image",
   "video","audio"]` (nvidia nemotron-3-nano-omni-…-reasoning:free),
   `["text","image","video"]` (qwen3.8-27b, viele andere) — the 3+
   element arrays landed in `models.json` under
   `providers.openrouter.models[0|5|10].input`.
3. **The committed snapshot writeback amplified it.** `generate.mjs`
   (container-host branch, docs/d041) copies the fresh `models.json`
   **into the repo's committed snapshot** (`committed snapshot refreshed —
   /home/CS423512/agentcontainer/coding-agent`) — so a generation run that
   happened to emit invalid `input` arrays also rewrote the repo's
   committed artifact, which the next host read. The schema failure on one
   model invalidates the *entire* `models.json` for strict consumers
   (cline's validator rejects the whole file).

Why pi/opencode themselves did not hit it: pi rebroadcasts the file
tolerantly / opencode's config is a different schema with no `input`
arrays at all (its providers carry `models: { name: id }` only). The
strict reader is cline.

## Fix

`coding-agent/gen-lib.mjs`: `piModel()` now runs the same
`toInput()` text+image-only filter that `catalogPiModel()`'s `toInput()`
applies to catalog records —

```js
function toInput(modalities) {
  const input = [];
  if (modalities?.includes("text")) input.push("text");
  if (modalities?.includes("image")) input.push("image");
  return input.length ? input : ["text"];
}
```

- emitted `input` is always `["text"]` or `["text","image"]`, canonical
  order, regardless of what the live listing reports (video/audio/pdf
  dropped, order normalized — the committing shape never changes).
- Applies to **all** three `piModel()` consumers: the local llama-swap
  layer, the peer-listing override layer, and the catalog-fallback
  override layer (`generate-pi-coding-agent.mjs` uses `piModel`
  everywhere the raw-listing path is touched).
- `catalogPiModel()` keeps its own `toInput()` (the two implementations
  are now contract-identical; consolidation is a possible future
  cleanup, not needed for the fix).

Verified with the repo's own check gate: `./check-types.sh` green; a
reproduction of the live-listing path (22 openrouter `:free` entries with
raw `input_modalities`) now yields **0 schema-invalid outputs**.

## Operational note

- The WSL2 box's already-generated `~/.pi/agent/models.json` (and the
  committed snapshot it wrote back to that host) still carry the invalid
  arrays for that one run — **re-run `./generate.sh` (via
  `./lib/environment.sh ./generate.sh`) with the fixed generator**; the
  next generation emits only `["text"]`/`["text","image"]`.
- The `uploads/logs.txt` file is the WSL2 run's structured log — it pins
  the `models.json installed ... providers 7` + `committed snapshot
  refreshed` lines.
