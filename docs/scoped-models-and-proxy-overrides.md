# Scoped models and proxy overrides

The coding-agent container is configured on the host ahead of pi by
`./coding-agent/run.sh`, which copies `settings.json` and `auth.json` into the
agent dir mounted at `~/.pi/agent`. This replaces the earlier, fragile
"generate a full model list" workflow with a **scoped models** approach.

## Approach

Instead of fetching live `/models` endpoints from each provider, filtering for
`:free` / `-free` variants, computing virtual costs, and re-generating a model
list client-side, the generators emit **only provider overrides** (`baseUrl` +
`apiKey`) for pi's built-in providers. pi then uses its **own** built-in model
catalog for each provider (kept fresh via `pi update --models`), simply
re-routed through the configured proxy/endpoint.

The specific models the agent actually uses are **not enumerated** by the
generator. They are the "scoped models" set, configured via the
`enabledModels` setting in `settings.json` — the set cycled by Ctrl+P and
matched with minimatch on `provider/modelId`:

```json
"enabledModels": [
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/mimo-v2.5",
  "opencode-go/hy3"
]
```

`run.sh` pins the active scope to these four opencode-go subscription models.

## auth.json

`run.sh` copies `auth.json` (pi's canonical credentials store) into
`~/.pi/agent/auth.json`; pi resolves provider API keys from it at runtime. This
replaces the old `.env` + generated `models.json` flow (which baked `$VAR`
api-key references that pi had to resolve from the container env). Credentials
stay out of `settings.json`; an `example.auth.json` template is provided.

## settings.json

Static `settings.json`, copied by `run.sh` into `~/.pi/agent/settings.json`.
(Default-model pinning is no longer generated dynamically.)

> **Deprecated:** the `OPENCODE_GO_API_KEY` name below is retired — OpenCode
> now uses the unified `OPENCODE_API_KEY` (rationale in
> **[d001](d001-proxy-env-and-namespace.md)** §3).

- The default model is pinned to the opencode-go subscription (DeepSeek V4
  Flash) **only** when `OPENCODE_GO_API_KEY` is present. When the key is absent
  the default fields are omitted so pi falls back to its built-in default
  model selection instead of failing on an unconfigured provider.
- `enabledModels` is the "scoped models" set described above.

## Related decision records

- [`d001-proxy-env-and-namespace.md`](d001-proxy-env-and-namespace.md) — proxy
  env vars, plain un-prefixed key naming, `baseUrl` baking.
- [`d006-virtual-cost-estimation.md`](d006-virtual-cost-estimation.md),
  [`d009-custom-auth-and-prefix.md`](d009-custom-auth-and-prefix.md),
  [`d010-opencode-go-pricing.md`](d010-opencode-go-pricing.md) — the older
  full-catalog generation decisions, superseded by the scoped-models approach.
- `d002-model-id-filters.md` / `d008-api-key-gating.md` — same generation, but
  they describe code that no longer exists (`MODEL_FILTERS`, `requireApiKey`);
  their essence is covered below.

## Spirit of the retired notes (survives their removal)

The legacy design notes d004–d015 describe the retired full-catalog pipeline;
this approach replaced it. The one-line essence of each, kept here so the notes
can be removed without losing the law they recorded:

- **d004 (provider-id renaming, metadata maps)** — obsolete by construction:
  generated layers now *override pi-native provider ids* instead of inventing
  suffixed ones, so there is no collision and no metadata bridge to maintain.
- **d005 (Google dynamic discovery)** — retired with the client-side catalog:
  pi's own built-in Google catalog is used (`pi update --models`), not a
  generated REST-discovered list.
- **d006 / d010 (virtual cost, documented pricing overrides)** — the cost
  tracker now reflects pi's built-in catalog pricing; no client-side estimation
  or pricing tables exist in this repo.
- **d012 (raw JSON dumps)** — the principle survives in the vendored, committed
  catalogs: `lib/models.dev.api.json` (models.dev) is the one raw model-id
  source of truth the current generators read; nothing fetches and filters
  live `:free` lists client-side any more.
- **d013 / d014 (remove non-working / paid-only "free" providers)** — moot in
  the scoped approach: generators enumerate no free tiers at all; provider
  reachability is probed, not assumed (d021: an unreadable catalog skips a
  provider rather than aborting the layer).
- **d015 (api-gateway)** — retired from the tree. Pattern of record
  for limited-network environments: a basic-auth, UUID-routed API *gateway*
  (terminating TLS, injecting provider keys) rather than a transparent proxy.
  Nothing in the current tree implements it; revisit only if a
  no-direct-cloud host needs key injection again.

Still in force and self-sufficient: `d001` (proxy env / plain key naming /
`baseUrl` baking — cited directly by `lib/peer-probe.mjs`,
`lib/refresh-models-dev.mjs`, `gen-lib.mjs`) and `d003` (generation-time
context-window embedding).
