# d004: provider ID renaming & metadata mapping

## Context

Generated provider entries use distinct IDs to avoid collision with pi's
built-in provider names. Pi ships its own `openrouter`, `google`, `mistral`,
etc. providers. If the generated config uses the same IDs, the two definitions
would clash.

Pi's `PI_MODEL_METADATA` (from `pi-model-metadata.json`) is keyed by the
**standard** provider names (`openrouter`, `google`, `opencode`, `mistral`),
not the generated ones.

## Decisions

### 1.  Generated providers use suffixed IDs

| Built-in pi name   | Generated provider ID |
|--------------------|-----------------------|
| `openrouter`       | `openrouter-free`     |
| `opencode`         | `opencode-zen-free`   |
| `opencode-go`      | `opencode-go-sub`     |
| `google`           | `google-free`         |
| `mistral`          | `mistral-free`        |

This prevents the generated config from overriding pi's built-in providers
and makes the tier/filter explicit in the name.

### 2.  `METADATA_PROVIDER_MAP` bridges the gap

```js
const METADATA_PROVIDER_MAP = {
  "openrouter-free":   "openrouter",
  "opencode-zen-free": "opencode",
  "opencode-go-sub":  "opencode-go",
  "google-free":       "google",
  "mistral-free":      "mistral",
};
```

When looking up per-model metadata (compat, reasoning, thinkingFormat,
thinkingLevelMap) from `PI_MODEL_METADATA`, the script maps the generated
provider ID back to pi's standard name so the metadata keys match correctly.
