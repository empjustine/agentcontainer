---
id: pi-cline-pass
type: module-design
status: active
title: "pi-cline-pass — the ClinePass provider as a pi package"
parent: architecture
depends-on: [d096]
references: [d100, d118]
tags: [pi-extensions, providers, cline-pass]
---

# pi-cline-pass — the ClinePass provider as a pi package

Registers the **ClinePass** gateway (`https://api.cline.bot/api/v1`, the
frozen provider row in `sources.mjs`) with
[pi](https://github.com/earendil-works/pi), seeded from committed artifacts
and rebuilt at refresh time from the same two published sources the
generator uses (docs/d189 owns the lineup contract).

## Install

```sh
pi install ./pi-cline-pass -l    # local package from this repo
# or point pi straight at the entry:
pi -e ./pi-cline-pass/index.mjs
```

## Environment

| Var             | Meaning                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLINE_API_KEY` | the ClinePass key pi sends as `Authorization: Bearer` (an unset key fails the refresh instead — pi resolves `$CLINE_API_KEY` before `refreshModels` runs, so `/model` reports "Could not refresh cline-pass") |

Network rides the environment's forward proxy
(`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY`, docs/d074) — the
same path for the extension's refresh and the generator. No relay ladder,
no route files.

## The lineup contract in one screen

One published source (docs/d189 and its amendment):

**Cline's docs table** (`clinepass.mdx`, `## Models`) — the whole model: which
ids ClinePass serves, already in the `cline-pass/` namespace, and the display
name of each. Nothing else adds an id and nothing else describes one; every
other field is pi's own schema default.

models.dev was the second read, and it retired. Its price column is Cline's
reference rate — the same page states the tabulated rates are not what a
subscriber pays — so a published `cost` would report money nobody spends; the
fields it could add disagreed with the vendor's own `@cline/llms` package on
most rows of the table (context window and output limit on 7 of 15, the effort
enum on 6 of 15); and it could never widen the lineup, so an unreadable catalog
cost the provider its whole catalog to protect fields nobody could check.

There is no committed lineup and no fallback: both consumers read the table on
every run, and a read that fails means ClinePass is unavailable for that run
(`CLINE_PASS_MDX` pins a local copy). The provider's OWN `/models`
listing is deliberately never consulted: at api.cline.bot it serves the
different `cline` (usage-billing) provider (`liveSync: false`, docs/d040).

**The `cline-pass/` prefix is a billing contract**: an unprefixed id through
this gateway bills at standard API pricing, so every consumer filters on it
before publishing a row.

### Candidate source: `@cline/llms` (documented, not wired)

Cline publishes its own machine-readable catalog inside its SDK,
`@cline/llms` (public npm, Apache-2.0; `@cline/core` re-exports it): a
generated `cline-pass` section carrying lineup, context/output limits,
capabilities (incl. `prompt-cache`), effort enums (`reasoningOptions`) and
zero-filled subscription pricing — plus the recommended/free/clinePass
group snapshot, the machine twin of the docs table. It runs _ahead_ of
models.dev (e.g. `cline-pass/kimi-k3.1-pro`, video input, exists there first),
which makes it the best candidate for the metadata nothing else carries —
limits, modalities and effort enums for the rows the table names.

It is **not wired in**, and the reason matters: the package ships **no JSON
artifact**. The catalog is a bun-minified JS object literal (unquoted keys)
inside the published tarball's `dist/models.js`. Pulling the metadata means
fetching a pinned tarball (`registry.npmjs.org/@cline/llms/-/…tgz`; the
registry's sha512 `dist.integrity` makes it a checksummed source), extracting
that one file, bracket-slicing from the `"cline-pass":{` marker, and
regex-quoting bare keys before `JSON.parse`. Verified end-to-end on 0.2.0
(20 models) — extraction is ~40 lines of node builtins, no dependency, no
execution of their code — with these caveats:

- **No format contract.** The markers and the minification are bundler
  output, free to change on any release. A bump that breaks extraction must
  surface as a loud degrading warning (fleet parity with the docs-table
  read), never as a thrown generation failure.
- **Pin versions deliberately.** `latest` churns (0.0.38 → 0.2.0 in months,
  plus nightlies); an unpinned read would drift our artifacts on Cline's
  release cadence instead of on source reality. Committed extraction
  fixtures keep the tests network-free.
- **Metadata only, never a lineup.** Parsing a minified bundle is not reading
  published data: the docs table stays the lineup and the display name, and
  this source could only fill fields for ids the table already names — never
  add one.

## Files

| File          | Role                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------- |
| `index.mjs`   | the extension entry: `registerProvider` + `refreshModels` (the reconciliation at runtime) |
| `sources.mjs` | the one source read (the docs table) and its parser                                       |
| `merge.mjs`   | the one shaping step: a published row becomes the registered-model entry                  |

Nothing is generated and nothing is committed: `./npm-run.sh pi-cline-pass
generate` prints a stub line. The script stays because a unit's
`package.json` is its entrypoint table (docs/d113) — there is no artifact left
for a drift gate to compare, and the extension registers no lineup of its own
(docs/d190).

## Documentation references

Cline publishes a documentation MCP server. It is a **reference for what to
build**, not a feature of this extension: nothing here registers it, and nothing
in this tree reads it at runtime. Both endpoints answer keyless (verified:
`initialize` and `tools/list` over streamable HTTP, no auth):

| Reference                                | What it answers                                                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://docs.cline.bot/.well-known/mcp` | the discovery document — `{"version":"1.0.0","transport":"http","url":"https://docs.cline.bot/mcp","servers":[{"name":"public","url":"https://docs.cline.bot/mcp","transport":"http","authentication":"none"}]}`                          |
| `https://docs.cline.bot/mcp`             | the server itself (streamable HTTP, Mintlify-hosted): `search_cline`, `query_docs_filesystem_cline` (read-only `rg`/`cat` over a virtual filesystem of the docs pages) and `submit_feedback`, plus the `mintlify://skills/cline` resource |
| `https://docs.cline.bot/llms.txt`        | the machine-readable docs index, including the `ClinePass` page this folder's lineup comes from                                                                                                                                           |

The `clinepass.mdx` table is git-hosted in the `cline/cline` repository, which
is what `sources.mjs` reads. The fleet list carries the MCP entry inert
(`../coding-agent/mcp.json`: `"enabled": false` with `"exposure": "hidden"`,
docs/d061), so an operator turns it on from `/mcp`.

## Provenance

Every cross-repo reference this folder makes is either LIVE DATA or an
ATTRIBUTION — never a code dependency. The host package
(@earendil-works/pi-coding-agent) is an optional peerDependency at runtime and
an exact devDependency for its types: the runtime instance is pi's own, and the
pin is only what tsc and the tests read (docs/d107).

- **The provider row** (`sources.mjs`, frozen) — the canonical upstream
  and key env (docs/d024/d070). Live data, one home.
- **Cline's published docs table** (clinepass.mdx in the cline/cline repo)
  — the SUBSCRIPTION CONTRACT: which ids ClinePass serves. Live data when
  fetched from the raw-file URL, or a pinned local copy via CLINE_PASS_MDX.
  Nothing behavioral is copied from that repo — only the table is parsed, and
  no copy of it is committed anywhere: a deliberate lineup contraction is one
  regenerated artifact set, not a constant to edit in two places.
- No third-party provider implementation is read or mirrored: the shaping
  rules are the fleet's own (docs/d033/d040/d049/d057), re-derived here as
  a standalone projection.

**The one deployment caveat to know**: raw.githubusercontent.com is a host
OUTSIDE the fact table. Under the third-generation forward proxy
that is fine by design — the egress posture is "any public DNS name on the
policy's ports" (docs/d080), with no route-table coupling. But on a
mode-A-only deployment, where egress is bound to the reverse-proxy's
fact-table allowlist (docs/d047), this folder's refreshes and regenerations
CANNOT reach that source — the committed artifacts are then the only usable
state. That is the decoupling working, not a defect; it is recorded
here so nobody debugs it as one.

## Tests

```sh
./npm-run.sh pi-cline-pass test    # from the repo root
```

Network-free (injected fetch, `CLINE_PASS_MDX` for the docs file) and
rule-pinning: they assert the parser, the prefix guard, the two projections and
the artifact contracts — never today's lineup.

## Base URL override

- `CLINE_BASE_URL` — optional upstream override, derived from the key env the way Azure OpenAI spells the pair (`CLINE_API_KEY` → `CLINE_BASE_URL`). Absolute http(s) only; a trailing slash is trimmed; unset keeps `https://api.cline.bot/api/v1`. A malformed value makes the extension fail to load loudly rather than silently use the canonical upstream.
