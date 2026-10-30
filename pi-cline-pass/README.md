# pi-cline-pass — the ClinePass provider as a pi package

Registers the **ClinePass** gateway (`https://api.cline.bot/api/v1`, the fact
table's canonical upstream — `../lib/cloud-providers.mjs`) with
[pi](https://github.com/earendil-works/pi), seeded from committed artifacts
and reconcilable at refresh time against the same two published sources the
generator uses (docs/d040 owns the lineup contract).

## Install

```sh
pi install ./pi-cline-pass -l    # local package from this repo
# or point pi straight at the entry:
pi -e ./pi-cline-pass/index.ts
```

## Environment

| Var | Meaning |
| --- | --- |
| `CLINE_API_KEY` | the ClinePass key pi sends as `Authorization: Bearer` (an unset key leaves the provider unconfigured — pi hides its models from `/model`) |

Network rides the environment's forward proxy
(`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY`, docs/d074) — the
same path for the extension's refresh and `./generate.sh`. No relay ladder,
no route files.

## The lineup contract in one screen

Two published sources, reconciled by `resolveAllowlist`:

1. **Cline's docs table** (`clinepass.mdx`, `## Models`) — the SUBSCRIPTION
   CONTRACT: which ids ClinePass serves, already in the `cline-pass/`
   namespace.
2. **The models.dev `cline-pass` slice** — the METADATA: prices, limits,
   modalities, effort enums; catalog-first additions are adopted from here.

When at least `CLINE_PASS_MATCH_FLOOR` (0.8) of the docs table still appears
in the slice, the published lineup is the union of both; below that, or when
the docs table cannot be read, the committed fallback lineup wins and the run
says so. The provider's OWN `/models` listing is deliberately never consulted:
at api.cline.bot it serves the different `cline` (usage-billing) provider
(`liveSync: false`, docs/d040).

**The `cline-pass/` prefix is a billing contract**: an unprefixed id through
this gateway bills at standard API pricing, so every consumer filters on it
before publishing a row.

## Files

| File | Role |
| --- | --- |
| `index.ts` | the extension entry: `registerProvider` + `refreshModels` (the reconciliation at runtime) |
| `sources.mjs` | the two source reads, the reconciliation floor, the committed fallback lineup |
| `merge.mjs` | the one shaping step and both projections (manifest entry, registered-model entry) |
| `generate.mjs` / `generate.sh` | two sources in, two artifacts out; `--check` verifies without writing |
| `models.json` | GENERATED: the pi-`models.json`-shaped cline-pass block (fleet parity: provider-level compat, canonical upstream) |
| `models.js` | GENERATED: the extension's offline seed (registered before any fresher store exists) |

Regenerate with `./generate.sh` (the git diff is the review); the committed
artifacts are the offline fallback a network-less host reads.

## Tests

```sh
sh -c '. ../lib/node-run.sh && node_run --test ../tests/pi-cline-pass.test.mjs'
```

Network-free (injected fetch, `CLINE_PASS_MDX` for the docs file) and
rule-pinning: they assert the guards, the floor, the cost/compat projections
and the artifact contracts — never today's lineup.
