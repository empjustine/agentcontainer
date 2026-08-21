# llama-swap Response vs pi Agent Expectations

## Your current response from llama-swap

```json
{
  "id": "03a-4q2-8k08v0-200ctx-byteshape/Qwen3.6-35B-A3B-GGUF:Q4_K_S",
  "object": "model",
  "created": 1785007343,
  "owned_by": "llama-swap",
  "meta": {
    "llamaswap": {
      "type": "model"
    }
  },
  "status": {
    "value": "unloaded"
  }
}
```

## What pi's `GET /models` endpoint expects

The pi agent processes each entry in the `data` array through two functions:

### 1. `isModelInfo` — validation gate (client.js:10)

```js
function isModelInfo(value) {
    return typeof candidate.id === "string"
        && typeof candidate.status?.value === "string";
}
```

| Field | Your response | Status |
|-------|--------------|--------|
| `id` (string) | `"03a-4q2-8k08v0-200ctx-byteshape/Qwen3.6-35B-A3B-GGUF:Q4_K_S"` | ✅ Present |
| `status.value` (string) | `"unloaded"` | ✅ Present |

**Your response passes this check.** It would not trigger the "not in router mode" error.

### 2. `toPiModel` — model conversion (provider.js:14)

```js
function toPiModel(model, serverUrl) {
    const reportedContextWindow = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
    const contextWindow = reportedContextWindow && reportedContextWindow > 0
        ? reportedContextWindow : 128000;
    return {
        id: model.id,
        name: model.id,
        api: "openai-completions",
        provider: LLAMA_PROVIDER_ID,
        baseUrl: llamaInferenceUrl(serverUrl),
        reasoning: false,
        input: model.architecture?.input_modalities?.includes("image")
            ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: Math.min(16384, contextWindow),
        compat: { /* ... */ },
    };
}
```

## Missing fields

| Expected field | Purpose | Your llama-swap response |
|---------------|---------|--------------------------|
| `meta.n_ctx` | Configured context window size | ❌ **Missing** — `meta` only contains `{"llamaswap": {"type": "model"}}` |
| `meta.n_ctx_train` | Fallback native context window size | ❌ **Missing** |
| `architecture` | Object describing model capabilities | ❌ **Missing entirely** |
| `architecture.input_modalities` | Array like `["text"]` or `["text", "image"]` | ❌ **Missing entirely** |

## Impact of missing fields

| Missing field | Consequence |
|---------------|------------|
| `meta.n_ctx` / `meta.n_ctx_train` | Context window defaults to `128000` for every model, regardless of its actual capability. `maxTokens` gets clamped to `min(16384, 128000) = 16384`. This may over-allocate context and lead to OOM or under-report available context. |
| `architecture.input_modalities` | Falls back to `["text"]` for all models. Multimodal vision models will **not** be detected as image-capable. |

## Why refresh still fails (the error you're seeing)

Your response passes `isModelInfo`, so the error `"Could not refresh llama.cpp; showing cached models."` is **not** caused by these missing fields. It means the **HTTP request** to the server itself failed — most likely:

1. **The llama-swap server is not running or not reachable** at the configured URL.
2. **Network timeout** — the 15-second `AbortSignal.timeout` fired before a response arrived.
3. **Non-2xx HTTP status** returned by llama-swap.
4. **The response JSON didn't have a `data` array** at the top level (e.g., if llama-swap returns a plain array or an object without a `data` key).

Check the **top-level response shape** from llama-swap:

```bash
curl http://your-llama-swap-url:port/models | jq type
```

pi expects:
```json
{ "data": [ ... ] }
```

If llama-swap returns:
```json
[ { "id": "...", "status": { "value": "..." } } ]
```
(i.e., a bare array without the `{ data: ... }` wrapper), then the `Array.isArray(payload.data)` check in `list()` will fail and throw `"llama.cpp returned an invalid model catalog"`, which surfaces as the "Could not refresh" error.

## Summary for llama-swap compatibility

To work fully with pi, llama-swap's `/models` endpoint should:

1. Wrap the array in `{ "data": [...] }`
2. Include `meta.n_ctx` or `meta.n_ctx_train` per model
3. Optionally include `architecture.input_modalities` for multimodal models

A compatible minimal response entry:

```json
{
  "id": "03a-4q2-8k08v0-200ctx-byteshape/Qwen3.6-35B-A3B-GGUF:Q4_K_S",
  "status": { "value": "unloaded" },
  "meta": { "n_ctx": 20480, "n_ctx_train": 32768 },
  "architecture": { "input_modalities": ["text"] }
}
```
