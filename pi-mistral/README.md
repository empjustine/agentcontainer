---
id: pi-mistral
type: module-design
status: active
title: "pi-mistral — mistral as a catalog freshness watchdog"
parent: architecture
depends-on: [d097]
references: [d100, d118]
tags: [pi-extensions, providers, mistral]
---

# pi-mistral — mistral as a catalog freshness watchdog

`pi -e ./pi-mistral/index.mjs` (or `pi -c` with the absolute path) adds a
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

| file           | role                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.mjs`    | the entire extension: `registerProvider("mistral", { refreshModels })`; the listing probe and the warn/fall-through rules (WHY: fileoverview)                      |
| `package.json` | `pi.package`, `pi.extensions: ["./index.mjs"]`; `@earendil-works/pi-coding-agent` as an optional peerDep (the runtime is pi's own) and an exact devDep (its types) |

There are no generated artifacts, no `generate.sh`, no `--check` — the
folder has nothing to regenerate. `tests/pi-mistral.test.mjs` (in this folder)
pins the rules; run it with `./npm-run.sh pi-mistral test` from
the repo root (all fetches injected — no network in `node --test`).

## Provenance

Everything this folder knows comes from two places: the folder's fact-table
row literal in `tests/pi-mistral.test.mjs` (the canonical upstream and the key
env, docs/d024/d070) and the live listing itself. It carries no catalog, so it
makes no behavioral copy of anything. The same family-wide caveat as
`../pi-opencode/` applies: pi-ai's built-in mistral catalog was never
row-verified by this repo, and the watchdog catches outages, not drift
between the built-in catalog and the live lineup.

## Contrast: pi-synthetic, pi-hyper, pi-verboo

Those folders are NOT built into pi, so they carry their own generated
catalogs (docs/d096, d100). The general rule, tracked in docs/d097, is about
substitution, not contribution: **a built-in provider's extension must not
substitute its own model data for pi's**.

## Documentation references

Mistral publishes an MCP server over its Studio workspace. It is a **reference
for what to build**, not a feature of this extension: nothing here registers
it, and nothing in this tree reads it at runtime.

| Reference                               | What it answers                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://api.mistral.ai/mcp`            | the server itself — streamable HTTP, `Authorization: Bearer <MISTRAL_API_KEY>`; a keyless `initialize` answers `401 {"detail":"Invalid API Key"}`. Its tools cover the workspace, not just docs: Documentation (search docs.mistral.ai, read pages as Markdown), Apps (read, plus redeploy/rollback), Billing, Connectors, Evaluations, Knowledge (create/delete), Libraries and Observability |
| `https://docs.mistral.ai/resources/mcp` | the vendor page: endpoint, transport, auth and the per-capability tool list                                                                                                                                                                                                                                                                                                                    |
| `https://docs.mistral.ai/llms.txt`      | the machine-readable docs index                                                                                                                                                                                                                                                                                                                                                                |

The fleet list carries the entry inert (`../coding-agent/mcp.json`:
`"enabled": false` with `"exposure": "hidden"`, docs/d061) and its header is
`Bearer ${MISTRAL_API_KEY}` — an environment reference, not a credential in the
file — so a host that enables it connects only where the key is configured, at
the workspace scope that key already has.

## Base URL override

- `MISTRAL_BASE_URL` — optional upstream override, derived from the key env the way Azure OpenAI spells the pair (`MISTRAL_API_KEY` → `MISTRAL_BASE_URL`). Absolute http(s) only; a trailing slash is trimmed; it points both the registration's `baseUrl` and the freshness listing (`<base>/models`) at the override, and unset leaves pi's built-in provider untouched. A malformed value makes the extension fail to load loudly.
