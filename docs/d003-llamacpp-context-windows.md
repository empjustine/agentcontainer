# d003: llama.cpp context window resolution

## Context

The llama.cpp / llama-swap server returns model entries with no context-window
metadata.  The canonical context windows are defined in
`openai-completions-gfx1030/llamacpp-model-data.json` via each model's
`maxDesiredContext` field.  The local-llm generator reads this field, converts it
to a compact `NNNctx` slug for the model ID (e.g. 200000 → `200ctx`), and
writes `--fit-ctx NNNN` **directly** into the model's `cmd` — no runtime macro
parsing needed.

## Decision

### Embed `--fit-ctx` directly in each model cmd at generation time

`generate-config.yaml.js` reads `maxDesiredContext` from each model entry in
`llamacpp-model-data.json`, formats it into a `NNNctx` slug for the model ID
(e.g. 200000 → `200ctx`, 32768 → `032ctx`), and writes `--fit-ctx NNNN`
directly into the model's `cmd`:

```
03a-4q2-8k08v0-200ctx-byteshape/Qwen3.6-35B-A3B-GGUF:Q4_K_S
  cmd: ${LLAMA_SERVER} ${qwen36} ${k80v80} --fit-ctx 200000 --parallel 2 ...
```

The config file is stored as JSON (with a `.yaml` extension) so it is directly
parsable by any standard JSON library. No YAML dependency is needed.

### No runtime macro parsing required

Since `--fit-ctx` is already in the cmd, nothing at runtime needs to extract
or look up context windows. The `NNNctx` slug in the ID is purely
human-readable — a quick way to see the context window at a glance.

### Slug derivation

The `ctxSlug(contextWindow)` function (in `generate-config.yaml.js`):
- Divisible by 1024 → KiB form: `131072 → "128"`
- Otherwise → nearest thousand: `200000 → "200"`
- Zero-padded to 3 digits, appended as `NNNctx` before the repo segment.

## Rationale

This eliminates the old `ctxNNN` macro table and the `resolveLlamaSwapContextWindow()`
runtime helper that were needed when context windows lived as `macros` entries
in the config. The generation-time approach is simpler (one write, no
lookups), more explicit (each model's cmd says exactly what it uses), and
avoids the sync step between a macro table and model definitions.
