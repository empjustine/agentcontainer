# d003: llama.cpp context window resolution

## Context

The llama.cpp / llama-swap server returns model entries with no context-window
metadata.  The canonical context windows are defined in
`lib/llamacpp-model-data.json` (owner: `llm-reverse-proxy/` — the file was moved
to lib to mark it shared, docs/d025) via each model's `ctx-size` field.  The
local-llm generator reads this field, converts it to a compact `NNNctx` slug for
the model ID (e.g. 200000 → `200ctx`), and writes `--ctx-size NNNN` (+ the
mirroring `--n-predict`) **directly** into the model's `cmd` — no runtime macro
parsing needed.

## Decision

### Embed `--ctx-size` directly in each model cmd at generation time

`generate-local-llm-models.yaml.mjs` reads `ctx-size` from each model entry in
`lib/llamacpp-model-data.json`, formats it into a `NNNctx` slug for the model ID
(e.g. 200000 → `200ctx`, 131072 → `128ctx`), and writes `--ctx-size NNNN`
+ `--n-predict NNNN` directly into the model's `cmd`:

```
03a-4q2-8k08v0-200ctx-byteshape/Qwen3.6-35B-A3B-GGUF:Q4_K_S
  cmd: ${LLAMA_SERVER} ${qwen36} ${k80v80} --fit-ctx 200000 --parallel 2 ...
```

The ctx slug rides on the *active-b* slug (`NNNb-ctxNNN-…`, see
`active-b.json`); the quant itself no longer appears in the id (`repo:revision`
lives in `hf-repo`, kv-cache type is emitted inline). The config file is stored
as JSON (with a `.yaml` extension) so it is directly parsable by any standard
JSON library. No YAML dependency is needed.

### No runtime macro parsing required

Since `--fit-ctx` is already in the cmd, nothing at runtime needs to extract
or look up context windows. The `NNNctx` slug in the ID is purely
human-readable — a quick way to see the context window at a glance.

### Slug derivation

The `ctxSlug(contextWindow)` function (in `generate-local-llm-models.yaml.mjs`):
- Divisible by 1024 → KiB form: `131072 → "128"`
- Otherwise → nearest thousand: `200000 → "200"`
- Zero-padded to 3 digits, appended as `ctxNNN` after the active-b slug.

## Rationale

This eliminates the old `ctxNNN` macro table and any runtime context-window
resolver: generation-time embedding is simpler (one write, no lookups), more
explicit (each model's cmd says exactly what it uses), and avoids the sync step
between a macro table and model definitions. 00-general.yaml still owns the
*family* macro tables (e.g. `${qwen38}` argv fragments); context windows are not
among them.
