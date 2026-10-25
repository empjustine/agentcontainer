---
id: d072
type: architecture-design
status: implemented
title: "d072 — maintainability review: what was folded, what was kept, what is deferred"
parent: goal
depends-on: [d023, d039, d042, d063, d070]
references: [d018, d021, d024, d030, d037, d047, d056, d061, d071]
tags: [maintainability, refactor, generators, docs, review]
---

# d072 — maintainability review

A whole-tree review for four kinds of rot: **ambiguity** (two things sharing
one name, or a document contradicting the code), **untested/untestable
surface**, **single-caller splits** (a helper split out for one caller and
never shared), and **scope that would collapse if it shrank**. This record
carries the verdicts: what was applied, what was examined and deliberately
kept, and what is deferred with the investigation already done.

## Applied

### 1. The two fact generators are one module

`coding-agent/catwalk-facts.mjs` and `coding-agent/provider-facts.mjs` were
siblings with the same shape — relay-fetch a JSON fact source, cache it in
`lib/`, warn-and-serve-stale on failure — split because they were written a
day apart. They are now `coding-agent/catalog-facts.mjs`
(`refresh/loadProviderFacts`, `refresh/loadCatwalkFacts`, `getCatwalkModels`,
`PROVIDER_MAP`), with one `relayFetch`/`writeCache`/`loadCache` helper trio
and one place for the cache-name invariant: **per-provider facts caches must
never be named `model-*.json`** (that glob is the layered merge's own).

`gen-lib.mjs` keeps re-exporting the provider symbols (its consumers already
depended on `gen-lib` as the facts barrel) and `lib/cloud-providers.mjs`
points at the new home. FR-L3 still holds — the two fact *caches* are
distinct files, but they now have one owning module, which is what "exactly
one home" asks for. Neither module had a direct test — they are
network-and-cache code whose observable contract is "warn and serve stale",
so the check for this merge was the baseline generate comparison below
(byte-identical artifacts), not a unit assertion that never existed.

### 2. The scratch staging tree is gone (d023's copy-through)

`coding-agent/generate.mjs` used to copy `coding-agent/` into a `scratch/`
tree, run every generator inside it, and copy artifacts back. That existed
for one reason: **the generators used to write next to their sources in a
read-only `/opt` container** (d023), and only warn about it (d021/d039's
warn-only contract). d056 stopped mounting the tree read-only, and the writes
that remain — the committed layer copy-back and the facts caches — are
deliberately warn-only best-effort, so a failure inside them cannot half-write
an install.

Now the generators run **in place** from `scriptDir` and every artifact goes
to a per-run output dir (`PI_LAYER_DIR`, `mkdtemp` under `RUN_DIR`), which is
removed at the end. What was **not** given up:

- **Atomicity of the install** — unchanged. Artifacts are still written with
  tmp+rename (`lib/artifact.mjs`), the tree is still swapped only after the
  whole cascade succeeds, the run still fails on a missing installed
  artifact (`requireInstallBase`), and `tests/artifact-urls.test.mjs` still
  covers the installed-direction escape detector.
- **The committed layer snapshot** (d037) — unchanged, with one deliberate
  difference: `generate.mjs` seeds `PI_LAYER_DIR` with the *committed*
  `model-*.json` layers before spawning the pi generator, so the merge glob
  and d064's stale-preserve still see previous state on a clean checkout
  (previously they saw whatever `scratch/` had been copied in).
- **`MODELS_DEV_JSON`** — was a symlink into scratch; it is now the committed
  path directly (`process.env.MODELS_DEV_JSON`), same target, no indirection.

`tests/lib-staging.test.mjs` — the guard for that retired mount list — went
with it, and `generate.sh` now just passes the script path while the `.mjs`
derives the rest. What stayed: `LIB_DIR` itself is the d023 **import
convention** (generators resolve `lib/` through `$LIB_DIR` so the bootstrap
logger can be loaded before anything else); only its use as a *path* prefix
for stage directories is gone, because each stage now derives its own
output dir. `coding-agent/DESIGN.md`,
`lib/log.mjs`, `coding-agent/generate.sh`, and the README folder rows follow.

### 3. Decision records are history, not fossils (FR-D2)

The old rule — "d0XX bodies are append-only, never rewritten" — was an
immutable-history stance carried by `docs/requirements.md` FR-D2,
`docs/d042-documentation-taxonomy.md`, and three README sentences. It cost
more than it bought: it is precisely what kept rot like d041's stale
`AGENT_DIR` mentions and a permanent "stale-by-design" pointer clause
alive.

The rule is now: **a record is never rewritten wholesale to change what was
decided or why — supersession points forward through a newer record — but
mechanical upkeep that keeps it honest may be edited in place** (a path
rename, a census count, the file list of the refactor the record itself
describes). d071's rejected alternative ("rewrite historical bodies to mean
something else") still stands; this is narrower, and it is what FR-D2 now
says. The wording was swept through `requirements.md`, `d042`, and README.

Comment style is unchanged and already owned by AGENTS.md: comments explain
**why**, never narrate what the code does — when a comment would explain how,
rename instead, or move the reasoning into JSDoc/`@fileoverview` or a doc.

### 4. Two different merges stopped sharing one name

"The merge contract" meant two unrelated things: llama-swap's additive
`config.d` fragment merge (d018) and pi's per-provider deep merge of
`model-*.json` (the layered cake). The llama-swap one is now **layer-merge
rules** everywhere (`llm-local-inference/generate.mjs` header, its
`DESIGN.md`, the README d018 row); pi's stays **the layered-cake merge**
(single home: the `generate-pi-coding-agent.mjs` header).

### 5. BRD statements reconciled with what the code does

- **Goal** — the "two independent capability axes" paragraph claimed
  generation branches on cloud reachability. It does not: since d063 cloud
  traffic is proxy-only for every host, and capability detection feeds
  generation only for local inference. The Goal now says exactly that, names
  "routing by host" as the accepted method, and records that
  `cloudReachable()` is left with no generation-time consumer.
- **FR-U2** — dropped the "can it reach cloud APIs directly" gate and the
  "falls back to committed static config" clause (d070 §6 removed the
  fallback; generation fails closed).
- **FR-U5** — "no merge logic, no preservation contract" contradicted
  `mcp.json`, which merges committed entries *under* operator state because
  an operator's MCP servers exist nowhere else (d061). Recorded as the
  deliberate, documented exception rather than left as a contradiction.

## Examined and kept

Call-site census (every export in `lib/`, `coding-agent/`,
`llm-reverse-proxy/`, `llm-local-inference/`, `git/`, `tests/` with exactly
one external call site):

| Export | Verdict |
|--------|---------|
| `detectContainerTool`, `detectGpuDevices` (`lib/host-capabilities.mjs` → `llm-local-inference/generate.mjs`) | **kept** — the module's two probes are one host-capability vocabulary; the only real question is its *placement* (`lib/` reads are the allowed direction), and relocating it now would move a tested unit for no behavioural gain |
| `loadCatwalkFacts`, `getCatwalkModels`, `loadProviderFacts` (`catalog-facts.mjs` → pi generator) | **kept** — one module, three stages of the same contract (refresh → load → query); folding them into the generator would re-create the file this record just merged |
| `providerEntry` (`gen-lib.mjs`, called by `providerReroute` in the same file and by the pi generator) | **kept** — two callers, one of them intra-module; it is the only shaping of a fact row into a pi provider |
| `probeRoute` (`route-probe.mjs` → `probeRoutes`) | **kept** — single caller, but it is the *classification contract* (reachable / auth / unreachable) with its own documented header that other comments point at; merging it into the candidate loop would bury the verdict table |
| `softwareForgeUserEmail`, `softwareForgeSshUrl`, `softwareForgeMirrorRelPath` (`git/software-forge-remotes.mjs`) | **kept** — a cohesive domain unit with one external consumer; the d039 fold rule targets `lib/`-vs-runner placement, not sibling scripts inside one runner |
| `harToManifest` (`git/vbs-har.mjs`) | **kept** — library-shaped function inside a CLI script, exported for tests; no split to undo |

`previousLocalProvider()` exists twice with the same name and the same why
(d064 first-class stale-preserve) but two different schemas — pi's
`providers["llama-swap"].models` array vs opencode's `provider.local.models`
map. A generic version would need the path-extraction and the shape check
parameterised, i.e. more indirection than the duplicated eight lines. Kept as
two schema-specific readers, each with the d064 comment.

## Deferred, with the investigation already done

### pi-ai should own the provider registry (replaces the hand-copied table)

`llm-reverse-proxy/generate.mjs` hand-copies pi's built-in provider registry
into `PI_AI_PROVIDERS` (~245 lines of id/label/api/baseUrl/apiKeyEnv) and
applies deny-by-absence to it (d047). The copy is the drift risk: nothing
asserts it still matches what pi actually ships.

Investigated: `@earendil-works/pi-ai` is published and is exactly the package
pi bundles (pi 1.2.0 declares `^1.2.0`; the registry functions are
`getBuiltinProviders()` + the per-provider factories carrying `baseUrl`,
`auth.apiKey.resolve`, and `getModels()`). pi itself is a single compiled
binary, so it is **not importable from the repo at runtime** — using it means
adding the repo's FIRST `package.json` (there is none today: opencode is
provisioned via mise, not npm) pinned to the pi version the image installs.

What the swap would look like: derive id/label/api/baseUrl from
`getBuiltinProviders()` at generate time, and keep a *small* repo-side table
only for what pi-ai does not know — our `apiKeyEnv` names (vault key
convention), the local `llama-swap` row, and the deny list. Deny-by-absence
(d047) then reads from pi's own set, so a new pi provider can never be
routable-but-unknown. The remaining risk is version skew between the pinned
pi-ai and the image's pi; a test asserting every routable id ∈
`getBuiltinProviders()` turns that into a loud, cheap failure.

Not wired in this change: it adds a dependency and a lockfile to a repo that
currently generates from vendored tables only (the offline-generation
invariant in `llm-local-inference/generate.mjs` is the sibling case). Worth
doing next, together with the drift test.

### llama-swap config and launch flags

Verified while reviewing: the repo already launches llama-swap with its
official directory flag — `workload_cmd -config-dir /etc/llama-swap/config.d`
(`llm-local-inference/run.sh:90`) — and `lib/workload-cmd.jq` /
`lib/workload-runtime.sh` are written around that exact spelling. Our own Go
proxy mirrors the sibling naming with `-config`/`-listen`. **No rename was
needed on the repo side**; if the intent was something else (e.g. teaching
the Go proxy llama-swap's `-config-dir` so a `config.d/` layout works there
too), that is a feature, not a rename, and it is not done here.

The config itself is generated from disjoint fragments by that loader
(d018); there is no duplicated llama-swap config to dedupe — `config.d/`
holds one copy of each key by construction, and generation errors on a
duplicate key.

### Merging pi's `model-*.json` layers in memory instead of on disk

Studied, not done. The layers are not only a merge input: they are the
**committed, reviewable snapshot** of what generation produced (d037) and the
carrier of d064's stale-preserve. Collapsing them into a single in-memory
merge would delete the merge glob and the per-layer review surface, but it
would also delete the artifact a reviewer diffs after a generator change —
and the committed file is what a clean checkout seeds `PI_LAYER_DIR` from.
Worth doing only if the layers stop being committed, i.e. if the snapshot
moves to a rendered diff in CI. Until then the layers stay.

### Routing by host

"Routing by host" (per-upstream-host allowlist, d047) is the accepted
method and stays. The alternatives noted in the review — a TLS-level VPN
(ssl-vpn style) or a non-HTTP-proxy transport — are network-design questions
that reach outside this repo's generation pipeline; the two stages only ever
see "which base URL wins". They are recorded in the Goal and here so the
question is not silently closed.

### Not taken (recorded, not adopted)

- **Pruning `models.dev.api.json`** to the fields the generators read (the
  single largest line-count item, ~67%). Real, but it is a committed catalog
  snapshot; pruning changes a shared artifact that other tools may read.
- **Extracting `git/` and `.agents/`** out of the repo root into their own
  project. They are already self-contained folders with their own
  `README.md`/`DESIGN.md`; the split is a repository-boundary decision, not
  a code one.
- **Deleting `local-llm/model-cards/` and `docs/*.data.json`** — the data
  files are referenced by their markdown; deletion needs each reference
  re-pointed first (separate sweep).
- **Generating README's documentation index from frontmatter** — the index is
  a curated, typed human map ("curated, not complete"); a generator would
  flatten exactly what the curation adds. The d042-style census check is the
  part worth automating, and it still is not one.
- **`./check.sh` as a single umbrella + four new tests** — the pieces exist
  (`./check-types.sh`, `./lint.sh`, `node --test`, `tests/check-*.sh`); an
  umbrella is convenience, not correctness.
- **Every stale record pointer + a d042 census test** — decision records that
  name files this change retired (d050/d056 still citing
  `tests/lib-staging.test.mjs`) stay as history under FR-D2, with this record
  as the supersession; the durable half is still worth building: one test
  asserting every non-d0XX doc carries exactly one d042 `type:` **and** that
  README's index lists every living doc. The ad-hoc sweeps behind this review
  were one-shot scripts, not a guard.

## Follow-up sweep: one d070 verifier, one substitution walker

`coding-agent/generate.mjs` carried a private twin of the URL-shape rule
(`FACT_UPSTREAMS`, `OPENCODE_PROVIDER_FACT_IDS`, `piProviderUrls`,
`openCodeProviderUrls`, `assertInstalledRouted`) beside
`check-routed-artifacts.mjs` — the module whose header calls itself "the ONE
implementation". It is literally that now: the shared module also owns the
writing half (`rewriteProviderUrls`, one walker per artifact shape, with the
opencode `local` → `llama-swap` alias applied in exactly one place), and an
install is `installRouted()` = rewrite + `installedViolations()` before the
write. `CLOUD_PROVIDERS`' projections (`PROVIDER_BASE_URLS`,
`FACT_UPSTREAMS`, `FACT_HOSTS`) moved into `lib/cloud-providers.mjs`, so no
consumer can check an artifact against a stale copy of the table.

Two prerequisites rode along, because the collapse needed them:
`check-routed-artifacts.mjs`'s CLI is now behind an entry-point test (its
top-level dispatch parsed the importing process's argv and could
`process.exit` it), and the module gained the round-trip tests that pin
substitution and verification together (`tests/artifact-urls.test.mjs`).

Same sweep, smaller items: `catalog-facts.mjs` publishes its cache through
`lib/artifact.mjs` instead of its own tmp+rename (same bytes — the caches are
tracked, so a serialization switch would churn every refresh diff);
`git/vbs-har.mjs` writes its manifest through the same writer;
`modelsDevCatalogPath()` lost the next-to-script probe that the retired d023
staging made look reachable; `emitFullAt` folded back into `emitFull` (its only
caller — with the constant `auth` bag and the provider literal inlined);
dead code from earlier folds removed (`humanBytes`, `repo_dir_name`,
`blob_size`, three internal `route-probe.mjs` exports); and the two HF-cache
scanners now share `local-llm/_hf_cache.py`, whose sidecar filter they had
already drifted on.

## Verification

- Baseline generate → installed artifacts (`models.json`, `settings.json`,
  `mcp.json`) and the committed-artifact git diff captured, then the same run
  after this change: **byte-identical** committed diff, **byte-identical**
  installed artifacts (only the expected warn-count difference from a
  transient models.dev fetch failure, which is warn-by-contract).
- `node --test` (49 assertions across `tests/*.test.mjs`), `./check-types.sh`
  (`tsc --checkJs`), `./lint.sh` all green.
- Docs edits are wording-level: requirements/d042/README/DESIGN rows and the
  frontmatter census this record amends.

## Alternatives rejected

- **Keeping the two fact modules separate** — "they were separate PRs" is
  not a contract; the shared shape is what a module boundary should encode.
- **Deleting the layers instead of seeding them** — loses the committed
  snapshot and d064's carrier (see above).
- **Making `previousLocalProvider` generic** — parameters that exist only to
  express two different schemas are a worse version of two small functions.
- **Rewriting records wholesale under the relaxed FR-D2** — the relaxation is
  mechanical upkeep only; d071's "rewrite history to change a verdict"
  alternative remains rejected.
