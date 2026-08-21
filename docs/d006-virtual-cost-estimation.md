# d006: virtual cost estimation

## Context

Free-tier (`:free`, `-free`) and subscription-backed models (OpenCode Zen,
OpenCode Go) report zero pricing from their `/models` endpoints. Without costs,
pi's cost tracker shows $0 for every request, which is misleading — these
models have real operational costs even if the user isn't billed per-token.

## Decision

Apply a **virtual cost** heuristic when the API returns zero or missing pricing.

### Strategy

1. **Real pricing preferred:** If the provider returns non-zero `pricing`
   (OpenRouter) or `cost` (OpenCode / models.dev), use it verbatim.

2. **Virtual fallback:** Otherwise estimate from the model ID.

### Virtual cost formula

```js
output = max(minOutput, perBillionOutput × sizeB) × variantMultiplier
input  = output × inputRatio
cacheRead  = input × cacheReadRatio
cacheWrite = input × cacheWriteRatio
```

### Tunable constants

| Constant            | Value  | Meaning                                               |
|---------------------|--------|-------------------------------------------------------|
| `perBillionOutput`  | 0.012  | USD per 1M output tokens per billion parameters       |
| `minOutput`         | 0.02   | Floor output cost (USD/1M tokens)                     |
| `inputRatio`        | 0.25   | Input cost as fraction of output                      |
| `cacheReadRatio`    | 0.10   | Cache read as fraction of input                       |
| `cacheWriteRatio`   | 1.25   | Cache write as fraction of input                      |
| `fallbackBillions`  | 30     | Default parameter count when none is parseable        |

### Variant multipliers

| Variant      | Multiplier | Example IDs                              |
|--------------|------------|------------------------------------------|
| `:free`      | 1.0×       | `openai/gpt-4o:free`                     |
| `:nitro`     | 2.5×       | `anthropic/claude-3.5-sonnet:nitro`      |
| `:throughput`| 0.5×       | `openai/gpt-4o:throughput`               |
| `:online`    | 1.2×       | (web-search surcharge)                   |

The multiplier is chosen so free and paid siblings of the same base model
share the same intrinsic cost — freeness is a billing artifact, not a
capability difference.

### Parameter size estimation

The heuristic parses `NNNB` or `NNNM` from the model ID:
- `Qwen3.6-35B-A3B` → 35B
- `llama-3.1-8b`    → 8B
- `gpt-oss-120m`    → 0.12B

## Rationale

The virtual estimate prevents all models from collapsing to a $0 price floor,
which would make pi's cost tracking useless. The constants are tuned so that
estimated costs are in the same ballpark as real published prices for
similarly-sized models.
