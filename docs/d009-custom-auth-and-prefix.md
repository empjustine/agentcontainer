# d009: custom auth schemes & model ID prefix stripping

## Context

Most OpenAI-compatible providers use `Authorization: Bearer <token>`. Google's
Gemini API uses `X-Goog-Api-Key` instead. Additionally, Google returns model
IDs prefixed with `models/` (e.g. `models/gemini-2.0-flash`), but
`PI_MODEL_METADATA` keys and pi's own model references use the bare ID
(`gemini-2.0-flash`).

## Decisions

### 1.  Per-provider `fetchAuth` option

The `fetchProviderModels()` helper accepts an optional `opts.fetchAuth`
parameter:

| Value            | Behaviour                                 |
|------------------|-------------------------------------------|
| `"bearer"`       | `Authorization: Bearer ${apiKey}` (default)|
| `"x-goog-api-key"` | `X-Goog-Api-Key: ${apiKey}`             |
| `"none"`         | No auth header                            |

Set per-provider in `BUILDIN_PROVIDERS`:
```js
{ id: "google-free", fetchAuth: "x-goog-api-key", ... }
```

### 2.  Per-provider `modelIdPrefix` stripping

When set, the prefix is stripped from every model ID returned by the `/models`
endpoint before any further processing:

```js
{ id: "google-free", modelIdPrefix: "models/", ... }
```

`models/gemini-2.0-flash` → `gemini-2.0-flash`

This ensures model IDs match `PI_MODEL_METADATA` keys and pi's internal
references.

## Rationale

Both workarounds are provider-specific quirks that don't justify a custom
fetch function. Making them per-provider options keeps the generic
`fetchProviderModels()` reusable while handling the Google Gemini API's
non-standard behaviour.
