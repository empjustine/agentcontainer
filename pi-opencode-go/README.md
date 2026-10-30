# pi-opencode-go — opencode-go as a catalog freshness watchdog

`pi -e ./pi-opencode-go/index.ts` (or `pi -c` with the absolute path) adds
a provider extension for `opencode-go` — **without carrying any model data
of its own**.

## Why there is no catalog here

opencode-go is built into pi-coding-agent: the host ships every model with
its api dialect, its per-family base URL, the OpenCode `x-opencode-session`
header wiring and the auth. A committed backup copy would be a strict
downgrade — in pi's composer an extension that returns a model list
REPLACES the whole provider catalog, inheriting only `api`/`baseUrl`, not
names, limits, prices or thinking maps (docs/d097).

So the extension registers ONLY `refreshModels`, and its one job is
freshness:

| Upstream answer | This extension does | You see |
| --- | --- | --- |
| listing reachable | `return undefined` | pi's built-in catalog, untouched |
| listing fails (network allowed) | **throws** | "Could not refresh opencode-go; showing cached models." — pi's built-in rows keep standing |
| offline init (`allowNetwork=false`) | `return undefined`, no fetch | silence — pi already knows it is offline |

plus a 4-hour interval gate (`force` bypasses) so an offline session warns
once, not on every model-selector open.

## Layout

| file | role |
| --- | --- |
| `index.ts` | the entire extension: `registerProvider("opencode-go", { refreshModels })`; the listing probe and the warn/fall-through rules (WHY: fileoverview) |
| `package.json` | `pi.package`, `pi.extensions: ["./index.ts"]`; optional peerDep on `@earendil-works/pi-coding-agent` (host-provided, never vendored) |

There are no generated artifacts, no `generate.sh`, no `--check` — the
folder has nothing to regenerate. `tests/pi-opencode-go.test.mjs` pins the
rules: the config carries only `refreshModels`, no model data exists in
the folder, the upstream URL matches the fact table
(`lib/cloud-providers.mjs`), and every failure path leaves pi's defaults
in place (all fetches injected — no network in `node --test`).

## Contrast: pi-synthetic

`../pi-synthetic/` is NOT built into pi, so it carries its own generated
catalog (docs/d096). The general rule, tracked in docs/d097, is about
substitution, not contribution: **a built-in provider's extension must not
substitute its own model data for pi's** — no backup catalog, no silent
fallback on fetch failure. Contributing what can only *enrich* pi's rows
— freshness signals today, fresh listing ids if an additive composer hook
ever lands — is welcome.
