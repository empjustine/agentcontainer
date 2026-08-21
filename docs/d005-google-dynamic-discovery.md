# d005: Google model discovery approach

## Context

The official `@google/genai` JavaScript SDK (v1.52.0+) is a direct dependency
of `@earendil-works/pi-ai` (v0.80.6). It exposes `models.list()` for dynamic
discovery. Pi currently ships a hardcoded static `google.models.js` that must
be regenerated before each release.

## Decision

### Dynamic discovery for standard Gemini models via REST API

The generated config fetches the Gemini models via REST
(`GET {baseUrl}/models`) instead of using the `@google/genai` SDK, for
consistency with all other providers (which also use REST `/models` endpoints).

This means:
- When Google adds a new Gemini model, it appears automatically after the next
  generation run.
- No need to update `google.models.js` or depend on the SDK for discovery.
- The generic `fetchProviderModels()` helper handles all providers uniformly.

### Static definitions only for Gemma models with special metadata

Only Gemma 4 models need static handling because they have non-standard
properties the REST API doesn't expose (zero cost, custom thinking level maps,
smaller context windows). These are covered by `PI_MODEL_METADATA`.

### Filtering

The `google-free` filter keeps:
- All Gemma 4 variants (always free)
- Gemini Flash models excluding Pro/Enterprise/Preview variants

## Rationale

Using REST `/models` over `@google/genai`'s SDK keeps the codebase uniform
across providers, avoids an extra SDK import, and makes the Google integration
follow the same fetch→filter→emit pipeline as OpenRouter, OpenCode, Mistral,
etc.
