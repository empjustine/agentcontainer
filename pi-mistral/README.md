# pi-mistral — mistral as a catalog freshness watchdog

`pi -e ./pi-mistral/index.ts` (or `pi -c` with the absolute path) adds a
provider extension for `mistral` — **without carrying any model data of its
own**.

## Why there is no catalog here

mistral is built into pi-coding-agent: the host ships the provider, the wire
format and the auth. In pi's composer an extension layer without `models`
passes the built-in catalog through UNTOUCHED, while a returned model list
REPLACES the whole provider catalog — so any "backup" copy here could only
be a downgrade (docs/d097, applied to mistral by docs/d100).

So the extension registers ONLY `refreshModels`, and its one job is
freshness:

| State                                    | This extension does          | You see                                                                                |
| ---------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| listing reachable (key set)              | `return undefined`           | pi's built-in catalog, untouched                                                       |
| listing fails (key set, network allowed) | **throws**                   | "Could not refresh mistral; showing cached models." — pi's built-in rows keep standing |
| no `MISTRAL_API_KEY`                     | `return undefined`, no fetch | silence — the provider is unconfigured; pi hides it from `/model` anyway               |
| offline init (`allowNetwork=false`)      | `return undefined`, no fetch | silence — pi already knows it is offline                                               |

plus a 4-hour interval gate (`force` bypasses). The no-key row is the ONE
deliberate divergence from `../pi-opencode/`: mistral's listing answers 401
before any key is sent, so keyless means only "no key" — while the opencode
listings are public, where a keyless failure means the endpoint moved and is
worth the warning.

## Layout

| file           | role                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`     | the entire extension: `registerProvider("mistral", { refreshModels })`; the listing probe and the warn/fall-through rules (WHY: fileoverview) |
| `package.json` | `pi.package`, `pi.extensions: ["./index.ts"]`; optional peerDep on `@earendil-works/pi-coding-agent` (host-provided, never vendored)          |

There are no generated artifacts, no `generate.sh`, no `--check` — the
folder has nothing to regenerate. `tests/pi-mistral.test.mjs` pins the rules
(all fetches injected — no network in `node --test`).

## Provenance

Everything this folder knows comes from two places: the fact table
(`lib/cloud-providers.mjs` — the canonical upstream and the key env,
docs/d024/d070) and the live listing itself. It carries no catalog, so it
makes no behavioral copy of anything. The same family-wide caveat as
`../pi-opencode/` applies: pi-ai's built-in mistral catalog was never
row-verified by this repo, and the watchdog catches outages, not drift
between the built-in catalog and the live lineup.

## Contrast: pi-synthetic, pi-hyper, pi-verboo

Those folders are NOT built into pi, so they carry their own generated
catalogs (docs/d096, d100). The general rule, tracked in docs/d097, is about
substitution, not contribution: **a built-in provider's extension must not
substitute its own model data for pi's**.
