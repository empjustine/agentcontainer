# AGENTS.md — pi-opencode

The folder IS the pi package (`pi.package` in `package.json`) and its
`index.ts` is the extension entry (like `examples/extensions/`). It covers
the whole opencode.ai vendor family — `opencode` (zen) and `opencode-go`
— as TWO registrations in one entry, because they share the key env, the
watchdog rules and the built-in-provider constraint (docs/d100).

Both providers are built INTO pi-coding-agent: the host ships the catalogs —
opencode-go's per-model api dialects, per-family base URLs, the OpenCode
session-header wiring and the auth (pi-ai's `data/opencode-go.json`); the
zen lineup likewise. This extension is a CATALOG FRESHNESS WATCHDOG, not a
catalog — the bullets below pin why, and what would have to change before it
could become one:

- **No model data may be added to this folder** — no seed, no committed
  `models.json`, no generator. A returned model list REPLACES the whole
  provider catalog in pi's composer (only api/baseUrl are inherited), so any
  copy here could only downgrade pi's own data (docs/d097).
- **Each `registerProvider` gets ONLY `refreshModels`** — `models`,
  `api`, `baseUrl`, `apiKey`, `authHeader`, `headers` all override
  the built-in provider and are forbidden. `tests/pi-opencode.test.mjs`
  pins the config shape and the absence of model data; keep both honest.
- **A failed listing fetch THROWS** — that is pi's catalog-warning channel
  (`ModelsRefreshResult.errors` → "Could not refresh <provider>; showing
  cached models."). Every other path returns `undefined` so pi's built-in
  catalog stands. Never substitute rows on failure.
- **Per-provider interval state**: one provider's outage must not silence
  the other's — each watchdog keeps its own clock (`force` bypasses both).
- `index.ts` deliberately has zero `../lib` imports: a copied package must
  stand alone. The upstream URLs are pinned constants (fact table:
  `lib/cloud-providers.mjs`, docs/d070); the tests assert the pins.
- Network access rides the environment's forward proxy
  (`NODE_USE_ENV_PROXY=1`, docs/d074). Keys are read from
  `OPENCODE_API_KEY` (the built-ins' own env — the shared client-side
  auth path, docs/d092) only to authenticate the listing probes, never
  logged (docs/d086). Both listings are PUBLIC, so a keyless failure is a
  warning worth raising — the contrast is `../pi-mistral/`, whose listing
  is auth-gated and therefore stays silent without a key.
- Deliberately absent: OAuth flows, quota/status UI, request shaping.

`../pi-synthetic/`, `../pi-hyper/` and `../pi-verboo/` are the contrast
case: NOT built into pi, so they DO carry their own catalogs (docs/d096,
d100). The general rule is about substitution, not contribution: a built-in
provider's extension must not substitute its own model data for pi's — no
backup catalog, no silent fallback on fetch failure. Contribution that can
only ENRICH pi's rows (freshness signals today; fresh rows if an additive
composer hook ever lands, d097 Open seams) is welcome, and would change this
folder's job — and with it the strict bullets above.
