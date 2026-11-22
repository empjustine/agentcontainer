---
id: pi-verboo
type: module-design
status: active
title: "pi-verboo — the Verboo provider as a pi package"
parent: architecture
depends-on: [d096]
references: [d100, d118]
tags: [pi-extensions, providers, verboo]
---

# pi-verboo — the Verboo provider as a pi package

Registers the **Verboo** gateway (`https://code.verboo.ai/router/v1`, the
fact-table row `sources.mjs` carries) with
[pi](https://github.com/earendil-works/pi), seeded from committed artifacts and
refreshed at runtime from the provider's own `/models` listing.

## Install

```sh
pi install ./pi-verboo -l    # local package from this repo
# or point pi straight at the entry:
pi -e ./pi-verboo/index.mjs
```

## Environment

| Var              | Meaning                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERBOO_API_KEY` | the key pi sends as `Authorization: Bearer` — and the key a regeneration needs (the listing is auth-gated; an unset key fails the refresh before `refreshModels` runs) |

Network rides the environment's forward proxy
(`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY`, docs/d074). No relay
ladder, no route files.

## The lineup contract in one screen

One source, and necessarily so: models.dev carries no verboo row (the fleet's
catalogOptional case, docs/d057) — the provider's `/models` listing is the
only lineup there is. It publishes capabilities (context window, vision,
effort enums) but NO prices and NO output limits, so it asserts neither: the
extension fills the mandatory zero cost and the schema's own 16384 default
(docs/d057). Reading it needs the key.

## Files

| File          | Role                                                                               |
| ------------- | ---------------------------------------------------------------------------------- |
| `index.mjs`   | the extension entry: `registerProvider` + `refreshModels` (the listing at runtime) |
| `sources.mjs` | the ONE source read: the provider's `/models` listing at the canonical upstream    |
| `merge.mjs`   | the ONE shaping step: a listing row becomes the registered-model entry             |
| `log.mjs`     | the JSONL log lines `sources.mjs` emits (docs/d045)                                |

Nothing is generated and nothing is committed: `./npm-run.sh pi-verboo
generate` prints a stub line. The script stays because a unit's `package.json`
is its entrypoint table (docs/d113) — there is no artifact left for a drift gate
to compare, and the extension registers no lineup of its own (docs/d190).
The extension registers no lineup of its own (docs/d190): `refreshModels` is
the only source, so the
artifact has no runtime reader — it is the drift gate's subject.

## Provenance

Everything this folder knows comes from two places, both live data: the
fact-table row in `sources.mjs` (the canonical upstream and key env,
docs/d024/d070) and the provider's own listing, fetched at generation and at
refresh. It makes NO behavioral copy of any third-party repo — no compat
flags, no transcribed tables: a plain OpenAI-compatible gateway where pi's
defaults are correct as-is, so every wire claim this folder makes is either
the provider's own publication or pi's own schema default. The committed
artifacts' only non-live input was the seeding at landing, recorded in
AGENTS.md — the fleet keeps no cache of the listing (docs/d191).

## Tests

```sh
./npm-run.sh pi-verboo test     # from the repo root
```

Network-free (injected fetch) and rule-pinning: the source contract, the
auth-gated bearer, the no-price/no-maxTokens rules, the reasoning-object
presence rule, and the committed artifacts — never today's lineup.

## Base URL override

- `VERBOO_BASE_URL` — optional upstream override, derived from the key env the way Azure OpenAI spells the pair (`VERBOO_API_KEY` → `VERBOO_BASE_URL`). Absolute http(s) only; a trailing slash is trimmed; unset keeps `https://code.verboo.ai/router/v1`. A malformed value makes the extension fail to load loudly rather than silently use the canonical upstream.
