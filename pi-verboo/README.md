# pi-verboo — the Verboo provider as a pi package

Registers the **Verboo** gateway (`https://code.verboo.ai/router/v1`, the fact
table's canonical upstream — `../lib/cloud-providers.mjs`) with
[pi](https://github.com/earendil-works/pi), seeded from committed artifacts
and refreshed at runtime from the provider's own `/models` listing.

## Install

```sh
pi install ./pi-verboo -l    # local package from this repo
# or point pi straight at the entry:
pi -e ./pi-verboo/index.ts
```

## Environment

| Var              | Meaning                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERBOO_API_KEY` | the key pi sends as `Authorization: Bearer` — and the key a regeneration needs (the listing is auth-gated; an unset key leaves the provider unconfigured) |

Network rides the environment's forward proxy
(`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY`, docs/d074). No relay
ladder, no route files.

## The lineup contract in one screen

One source, and necessarily so: models.dev carries no verboo row (the fleet's
catalogOptional case, docs/d057) — the provider's `/models` listing is the
only lineup there is. It publishes capabilities (context window, vision,
effort enums) but NO prices and NO output limits, so the committed artifacts
assert neither: the manifest omits `cost` and `maxTokens` entirely
(docs/d057), and the extension fills the mandatory zero cost and the schema's
own 16384 default. The committed pair was seeded from the fleet's facts cache
of the same listing (see AGENTS.md); `./generate.sh --check` is the drift
gate, and both forms need the key.

## Files

| File                           | Role                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `index.ts`                     | the extension entry: `registerProvider` + `refreshModels` (the listing at runtime) |
| `sources.mjs`                  | the ONE source read: the provider's `/models` listing at the canonical upstream    |
| `merge.mjs`                    | the ONE shaping step + both projections (manifest entry, registered-model entry)   |
| `generate.mjs` / `generate.sh` | one fetch in, two artifacts out; `--check` verifies without writing                |
| `models.json`                  | GENERATED: the pi-`models.json`-shaped verboo block (canonical upstream, d070)     |
| `models.js`                    | GENERATED: the extension's offline seed                                            |

Regenerate with `./generate.sh` (the git diff is the review).

## Provenance

Everything this folder knows comes from two places, both live data: the fact
table (`lib/cloud-providers.mjs` — the canonical upstream and key env,
docs/d024/d070) and the provider's own listing, fetched at generation and at
refresh. It makes NO behavioral copy of any third-party repo — no compat
flags, no transcribed tables: a plain OpenAI-compatible gateway where pi's
defaults are correct as-is, so every wire claim this folder makes is either
the provider's own publication or pi's own schema default. The committed
artifacts' one non-live input is the seeding provenance recorded in
AGENTS.md (the fleet's facts cache of the same listing).

## Tests

```sh
sh -c '. ../lib/node-run.sh && node_run --test ../tests/pi-verboo.test.mjs'
```

Network-free (injected fetch) and rule-pinning: the source contract, the
auth-gated bearer, the no-price/no-maxTokens rules, the reasoning-object
presence rule, and the committed artifacts — never today's lineup.
