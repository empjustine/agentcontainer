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
pi -e ./pi-cline-pass/index.ts
```

## Environment

| Var             | Meaning                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CLINE_API_KEY` | the ClinePass key pi sends as `Authorization: Bearer` (an unset key leaves the provider unconfigured — pi hides its models from `/model`) |

Network rides the environment's forward proxy
(`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY`, docs/d074) — the
same path for the extension's refresh and the generator. No relay ladder,
no route files.

## The lineup contract in one screen

Two published sources, one direction (docs/d189):

1. **Cline's docs table** (`clinepass.mdx`, `## Models`) — the LINEUP: which
   ids ClinePass serves, already in the `cline-pass/` namespace. Nothing else
   adds an id, and a table id models.dev has not caught up to still publishes.
2. **The models.dev `cline-pass` slice** — the METADATA: prices, limits,
   modalities, effort enums. An id only the slice carries is a retired model
   and never publishes.

There is no committed lineup and no agreement floor: both consumers read the
table on every run, and a read that fails means ClinePass is unavailable for
that run (`CLINE_PASS_MDX` pins a local copy). The provider's OWN `/models`
listing is deliberately never consulted: at api.cline.bot it serves the
different `cline` (usage-billing) provider (`liveSync: false`, docs/d040).

**The `cline-pass/` prefix is a billing contract**: an unprefixed id through
this gateway bills at standard API pricing, so every consumer filters on it
before publishing a row.

### Candidate third source: `@cline/llms` (documented, not wired)

Cline publishes its own machine-readable catalog inside its SDK,
`@cline/llms` (public npm, Apache-2.0; `@cline/core` re-exports it): a
generated `cline-pass` section carrying lineup, context/output limits,
capabilities (incl. `prompt-cache`), effort enums (`reasoningOptions`) and
zero-filled subscription pricing — plus the recommended/free/clinePass
group snapshot, the machine twin of the docs table. It runs _ahead_ of
models.dev (e.g. `cline-pass/kimi-k3.1-pro`, video input, exists there
first), which makes it the best candidate for the metadata the slice lacks —
the rows the table names and models.dev has not yet priced.

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
  published data: the docs table stays the lineup and models.dev the metadata
  source, and this source could only fill fields for ids the table already
  names — never add one.

## Files

| File           | Role                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `index.ts`     | the extension entry: `registerProvider` + `refreshModels` (the reconciliation at runtime)                         |
| `sources.mjs`  | the two source reads: the lineup from the docs table, the metadata from models.dev                                |
| `merge.mjs`    | the one shaping step and both projections (manifest entry, registered-model entry)                                |
| `generate.mjs` | two sources in, one artifact out; `--check` verifies without writing                                              |
| `log.mjs`      | the JSONL log lines `generate.mjs` and `sources.mjs` emit (docs/d045)                                             |
| `models.json`  | GENERATED: the pi-`models.json`-shaped cline-pass block (fleet parity: provider-level compat, canonical upstream) |

Regenerate with `./npm-run.sh pi-cline-pass generate` from the
repo root (the git diff is the review). The extension registers no lineup of
its own (docs/d190): `refreshModels` reads the docs table at runtime, so the
artifact is the fleet-parity and drift record and nothing else.

## Provenance

Every cross-repo reference this folder makes is either LIVE DATA or an
ATTRIBUTION — never a code dependency (the only package dependency is the
host itself, @earendil-works/pi-coding-agent, an optional peerDep that is
never vendored):

- **The provider row** (`sources.mjs`, frozen) — the canonical upstream
  and key env (docs/d024/d070). Live data, one home.
- **models.dev** (https://models.dev/api.json) — the METADATA source:
  prices, limits, modalities, effort enums. Live data, public, no key, and
  deliberately not redirectable by env.
- **Cline's published docs table** (clinepass.mdx in the cline/cline repo)
  — the SUBSCRIPTION CONTRACT: which ids ClinePass serves. Live data when
  fetched from the raw-file URL, or a pinned local copy via CLINE_PASS_MDX.
  Nothing behavioral is copied from that repo — only the table is parsed, and
  no copy of it is committed anywhere: a deliberate lineup contraction is one
  regenerated artifact set, not a constant to edit in two places.
- No third-party provider implementation is read or mirrored: the shaping
  rules are the fleet's own (docs/d033/d040/d049/d057), re-derived here as
  a standalone projection.

**The one deployment caveat to know**: models.dev and raw.githubusercontent.com
are hosts OUTSIDE the fact table. Under the third-generation forward proxy
that is fine by design — the egress posture is "any public DNS name on the
policy's ports" (docs/d080), with no route-table coupling. But on a
mode-A-only deployment, where egress is bound to the reverse-proxy's
fact-table allowlist (docs/d047), this folder's refreshes and regenerations
CANNOT reach either source — the committed artifacts are then the only
usable state. That is the decoupling working, not a defect; it is recorded
here so nobody debugs it as one.

## Tests

```sh
./npm-run.sh pi-cline-pass test    # from the repo root
```

Network-free (injected fetch, `CLINE_PASS_MDX` for the docs file) and
rule-pinning: they assert the guards, the lineup direction, the cost/compat
projections and the artifact contracts — never today's lineup.
