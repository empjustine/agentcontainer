# pi-opencode — opencode and opencode-go as catalog freshness watchdogs

`pi -e ./pi-opencode/index.ts` (or `pi -c` with the absolute path) adds
provider extensions for **both** opencode.ai surfaces — `opencode` (zen)
and `opencode-go` — **without carrying any model data of their own**. One
folder for the family because they share the key env (`OPENCODE_API_KEY`),
the watchdog rules and the built-in-provider constraint (docs/d100).

## Why there is no catalog here

Both providers are built into pi-coding-agent: the host ships every model
with its api dialect, its per-family base URL, the OpenCode
`x-opencode-session` header wiring and the auth. A committed backup copy
would be a strict downgrade — in pi's composer an extension that returns a
model list REPLACES the whole provider catalog, inheriting only
`api`/`baseUrl`, not names, limits, prices or thinking maps (docs/d097).

So each registration carries ONLY `refreshModels`, and its one job is
freshness:

| Upstream answer                     | This extension does          | You see                                                                                      |
| ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| listing reachable                   | `return undefined`           | pi's built-in catalog, untouched                                                             |
| listing fails (network allowed)     | **throws**                   | "Could not refresh opencode(-go); showing cached models." — pi's built-in rows keep standing |
| offline init (`allowNetwork=false`) | `return undefined`, no fetch | silence — pi already knows it is offline                                                     |

plus a 4-hour interval gate per provider (`force` bypasses) so an offline
session warns once per provider, not on every model-selector open.

## Layout

| file           | role                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`     | the entire extension: two `registerProvider(<id>, { refreshModels })` registrations, the shared listing probe and the warn/fall-through rules (WHY: fileoverview) |
| `package.json` | `pi.package`, `pi.extensions: ["./index.ts"]`; optional peerDep on `@earendil-works/pi-coding-agent` (host-provided, never vendored)                              |

There are no generated artifacts, no `generate.sh`, no `--check` — the
folder has nothing to regenerate. `tests/pi-opencode.test.mjs` pins the
rules: each config carries only `refreshModels`, no model data exists in
the folder, the upstream URLs match the fact table
(`lib/cloud-providers.mjs`), and every failure path leaves pi's defaults in
place (all fetches injected — no network in `node --test`).

## Provenance

Everything this folder knows about the providers comes from two places: the
fact table (`lib/cloud-providers.mjs` — the canonical upstream URLs and the
key env, docs/d024/d070) and the live listings themselves. It carries no
catalog, so it makes no behavioral copy of anything — the watchdog observes
and warns, nothing else. The one upstream-design debt recorded against the
FAMILY (not this folder): pi-ai's built-in opencode-go catalog was verified
row by row against d048's research when d097 landed, and that verification
has no tripwire — a pi release can change the built-in rows silently. The
watchdog's "listing reachable" check catches outages, not drift between the
built-in catalog and the live lineup.

## Contrast: pi-synthetic, pi-hyper, pi-verboo

Those folders are NOT built into pi, so they carry their own generated
catalogs (docs/d096, d100). The general rule, tracked in docs/d097, is about
substitution, not contribution: **a built-in provider's extension must not
substitute its own model data for pi's** — no backup catalog, no silent
fallback on fetch failure. Contributing what can only _enrich_ pi's rows —
freshness signals today, fresh listing ids if an additive composer hook ever
lands — is welcome.
