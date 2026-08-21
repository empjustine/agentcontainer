# d010: OpenCode Go documented cost overrides

## Context

OpenCode Go is a $10/mo subscription that passes through partner models at
effective per-1M-token rates (see
[cloud-llm/README.md](../cloud-llm/README.md) for the canonical
pricing sources). The `/models` endpoint returns zero pricing
(subscription-backed), so the virtual cost heuristic (d006) applies by
default.

However, OpenCode publishes exact look-alike rates for each model in their
Go catalogue. These are more accurate than any heuristic.

## Decision

### Maintain `opencode-go-pricing.json`

A separate JSON file maps each OpenCode Go model to its documented cost:

```json
{
  "grok-4.5":    { "input": 2.00,  "output": 6.00, ... },
  "kimi-k3":     { "input": 3.00,  "output": 15.00, ... },
  "deepseek-v4-flash": { "input": 0.14,  "output": 0.28, ... }
}
```

The file lives in `cloud-llm/` and is loaded at generation time.

### Override precedence

1. Documented OpenCode Go cost (from `opencode-go-pricing.json`) — **highest**
2. Real provider pricing (`pricing` or `cost` from API response)
3. Virtual cost heuristic (d006) — **lowest**

The documented cost overrides the virtual estimate when the model ID is found
in the table. Model IDs are matched on the bare name (e.g. `grok-4.5`) after
stripping any provider namespace prefix (e.g. `opencode-go:grok-4.5`).

## Maintenance

Edit `opencode-go-pricing.json` when the OpenCode Go docs change. The refresh
procedure (canonical repo, local mirror, transcription steps) is documented
in [cloud-llm/README.md](../cloud-llm/README.md).
