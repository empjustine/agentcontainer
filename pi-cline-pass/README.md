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

### Candidate third source: `@cline/llms` (documented, not wired)

Cline publishes its own machine-readable catalog inside its SDK,
`@cline/llms` (public npm, Apache-2.0; `@cline/core` re-exports it): a
generated `cline-pass` section carrying lineup, context/output limits,
capabilities (incl. `prompt-cache`), effort enums (`reasoningOptions`) and
zero-filled subscription pricing — plus the recommended/free/clinePass
group snapshot, the machine twin of the docs table. It runs *ahead* of
models.dev (e.g. `cline-pass/kimi-k3.1-pro`, video input, exists there
first), which makes it the best candidate for a third, independent
cross-check opinion in the reconciliation.

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
- **Cross-check, never third authority.** Parsing a minified bundle is not
  reading published data: the docs table and models.dev stay the reconciled
  authorities, and this source can only add a warning when the union
  disagrees with Cline's own rendering of it.

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

## Provenance

Every cross-repo reference this folder makes is either LIVE DATA or an
ATTRIBUTION — never a code dependency (the only package dependency is the
host itself, @earendil-works/pi-coding-agent, an optional peerDep that is
never vendored):

- **The fact table** (lib/cloud-providers.mjs) — the canonical upstream
  and key env (docs/d024/d070). Live data, one home.
- **models.dev** (https://models.dev/api.json) — the METADATA source:
  prices, limits, modalities, effort enums. Live data, public, no key, and
  deliberately not redirectable by env.
- **Cline's published docs table** (clinepass.mdx in the cline/cline repo)
  — the SUBSCRIPTION CONTRACT: which ids ClinePass serves. Live data when
  fetched from the raw-file URL; a pinned local copy via CLINE_PASS_MDX or
  the git-mirror farm otherwise. Nothing behavioral is copied from that
  repo — only the table is parsed, and the committed fallback lineup is a
  transcription of it that a deliberate lineup contraction must update in
  both places (fleet CLINE_PASS_LINEUP and sources.mjs's, siblings by
  provenance).
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
sh -c '. ../lib/node-run.sh && node_run --test ../tests/pi-cline-pass.test.mjs'
```

Network-free (injected fetch, `CLINE_PASS_MDX` for the docs file) and
rule-pinning: they assert the guards, the floor, the cost/compat projections
and the artifact contracts — never today's lineup.
