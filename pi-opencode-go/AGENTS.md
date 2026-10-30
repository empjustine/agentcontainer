# AGENTS.md — pi-opencode-go

The folder IS the pi package (`pi.package` in `package.json`) and its
`index.ts` is the extension entry (like `examples/extensions/`).

opencode-go is built INTO pi-coding-agent: the host ships the catalog —
per-model api dialects, per-family base URLs, the OpenCode session-header
wiring and the auth (pi-ai's `data/opencode-go.json`). This extension is a
CATALOG FRESHNESS WATCHDOG, not a catalog — the bullets below pin why,
and what would have to change before it could become one:

- **No model data may be added to this folder** — no seed, no committed
  `models.json`, no generator. A returned model list REPLACES the whole
  provider catalog in pi's composer (only api/baseUrl are inherited), so any
  copy here could only downgrade pi's own data (docs/d097).
- **`registerProvider` gets ONLY `refreshModels`** — `models`, `api`,
  `baseUrl`, `apiKey`, `authHeader`, `headers` all override the built-in
  provider and are forbidden. `tests/pi-opencode-go.test.mjs` pins the
  config shape and the absence of model data; keep both honest.
- **A failed listing fetch THROWS** — that is pi's catalog-warning channel
  (`ModelsRefreshResult.errors` → "Could not refresh opencode-go; showing
  cached models."). Every other path returns `undefined` so pi's built-in
  catalog stands. Never substitute rows on failure.
- `index.ts` deliberately has zero `../lib` imports: a copied package must
  stand alone. The upstream URL is a pinned constant (fact table:
  `lib/cloud-providers.mjs`, docs/d070); the tests assert the pin.
- Network access rides the environment's forward proxy
  (`NODE_USE_ENV_PROXY=1`, docs/d074). Keys are read from
  `OPENCODE_API_KEY` (the built-in's own env — the shared client-side
  auth path, docs/d092) only to authenticate the listing probe, never
  logged (docs/d086).
- Deliberately absent: OAuth flows, quota/status UI, request shaping.

`../pi-synthetic/` is the contrast case: NOT built into pi, so it DOES
carry its own catalog (docs/d096). The general rule is about
substitution, not contribution: a built-in provider's extension must not
substitute its own model data for pi's — no backup catalog, no silent
fallback on fetch failure. Contribution that can only ENRICH pi's rows
(freshness signals today; fresh rows if an additive composer hook ever
lands, d097 Open seams) is welcome, and would change this folder's job —
and with it the strict bullets above.
