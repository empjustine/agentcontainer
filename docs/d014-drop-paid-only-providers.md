# d014: drop paid-only "freeish" providers

## Context

`generate-config.yaml.js` originally registered a set of third-party providers
that nominally offered free-tier access but in practice provided unreliable
service — excessive rate-limiting, intermittent 429s, or models that were
effectively unusable without a paid subscription.  These providers added
fetch latency, maintenance surface, and user confusion without delivering
working free models.

The affected providers:

| Provider ID     | Status in script before removal | Why it was dropped                                         |
|-----------------|----------------------------------|------------------------------------------------------------|
| `zenmux`        | commented out                    | Unreliable free tier; excessive rate-limiting               |
| `crofai`        | commented out                    | Unreliable free tier; excessive rate-limiting               |
| `deepinfra`     | commented out                    | Trial-credit model; $5 one-time credit exhausted quickly   |
| `together`      | commented out                    | Trial-credit model; $1 credit exhausted quickly             |
| `novita`        | commented out                    | Unreliable free tier; excessive rate-limiting               |
| `routeway`      | active override                  | Mix of free and paid models; paid models were leaking       |

## Decision

1. **Comment out `routeway`** from `BUILDIN_PROVIDERS` (the only provider from
   this set that was still active).  This stops the script from probing
   Routeway's `/models` endpoint and including paid models alongside the
   `:free` variants.

2. **Leave the supporting metadata entries** (`DEFAULT_BASE_URLS`,
   `MODEL_FILTERS`, `METADATA_PROVIDER_MAP`, `PROVIDER_PRICING_MULTIPLIER`)
   in place but unused.  This is consistent with how the other providers
   (`zenmux`, `crofai`, etc.) were already handled — their entries remain
   commented out in `BUILDIN_PROVIDERS` while the metadata tables keep the
   entries for traceability.

3. **Do not add `b.ai`** — this provider was never registered in the script
   and does not need removal.

## Rationale

- **User experience**: free-tier users hit rate limits immediately, making
  these providers useless in practice.
- **Maintenance cost**: each provider adds filter logic, metadata mappings,
  pricing multiplier entries, and raw-model dump files — all for zero
  benefit when the free tier is non-functional.
- **Consistency**: the remaining active providers (openrouter-free,
  opencode-zen-free, google-free, mistral-free, clinepass, ollama-cloud,
  fastrouter) all provide reliably usable free models.

## Consequences

### Positive
- Fewer fetch attempts at generation time (one fewer HTTP request per run).
- Cleaner model list — users see only providers that actually work on the
  free tier.
- Reduced maintenance surface for filter logic and pricing metadata.

### Negative
- Users who had custom `ROUTEWAY_BASE_URL` / `__ROUTEWAY_API_KEY` env vars
  will no longer see Routeway models.  They can uncomment the entry manually
  if they have a working subscription.

### Mitigations
- The commented-out entry is preserved in `BUILDIN_PROVIDERS` with clear
  documentation, so re-enabling is a one-line change.
- Raw model dumps (`routeway-raw-models.json`) are retained for offline
  inspection.

## Related

- [d013-removed-non-working-free-providers.md](d013-removed-non-working-free-providers.md) — prior cleanup of providers that never worked
- [`openai-completions-peer/generate-config.yaml.js`](../openai-completions-peer/generate-config.yaml.js) — the unified config generator where these providers were registered
