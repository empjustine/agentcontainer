---
id: d096
type: decision
status: implemented
title: "d096 — the pi-synthetic extension: catalog-derived provider config that does not need the fleet's agent dir"
parent: coding-agent
depends-on: [d024, d050, d057, d070, d092]
references: [d028-superseded, d032, d039, d063, d071]
tags: ["providers", "pi", "extensions", "coding-agent", "synthetic", "generators"]
---

# d096 — the pi-synthetic extension

**Status: implemented, and subsequently SIMPLIFIED.** The folder first landed with
a three-source data ladder (live listing → vendored models.dev → vendored
catwalk). A peer review measured that ladder and found the two vendored rungs
changed **zero** emitted values while carrying four models the provider had
rotated away, and **the ladder was deleted**: one fetch of the provider's own
listing is the only source, and the folder IS the pi package with no copy step.
The Decision section records the current shape, and 'Why the three-source
ladder was deleted' records why the ladder went. The seam into
`coding-agent/generate-pi-coding-agent.mjs` is still deliberately open (see
'Not decided here — the open seam').

## Problem

`docs/d092` promoted synthetic to a first-class fleet provider: a
`PROVIDER_SPECS` row in `coding-agent/generate-pi-coding-agent.mjs` emitting
layer `model-019-cloud-synthetic.json`, merged into `coding-agent/models.json`
and installed into the host agent dir at install time (with the reverse-proxy
route substituted, docs/d070). That covers exactly one situation: **a session
that runs with the fleet's generated agent dir mounted.** It does not cover a
bare host, a plain `pi -e` try-out, or a container that mounts only a work
directory — there, the provider simply does not exist.

`docs/d028` (status: *proposed*, nothing implemented) argued that runtime
provider extensions could replace the generated-config machinery wholesale. That
argument is not adopted here — the generated layers carry install-time route
substitution, multi-source fact caches and the whole fleet's provider set, and
retiring them is a different, much larger decision. What IS adopted is the
narrow observation d028's source survey turned up: **for a provider whose own
listing is authoritative, an extension can carry its catalog.**

## Decision

A new folder, `pi-synthetic/`, holding one generator and one loadable pi
extension:

- `sources.mjs` — the ONE data source: the provider's `/models` listing,
  fetched from the fact table's canonical upstream (docs/d070).
- `merge.mjs` — the ONE shaping step (`shapeListing`/`shapeRow`) and the two
  projections (pi `models.json` entry; pi-ai extension entry): the docs/d049
  modality gate, effort-enum-derived thinking maps, docs/d057's cost rule, and
  the alias display name.
- `generate.mjs` / `generate.sh` — one fetch in, two committed artifacts out
  (atomic writes, `lib/artifact.mjs`; canonical JSON per docs/d050), plus
  `--check` for the drift gate.
- `models.json` — **committed**, pi-`models.json`-shaped, canonical upstream
  URL, `$SYNTHETIC_API_KEY` reference.
- `models.js` — **committed**, the extension's seed (`SYNTHETIC_MODELS`,
  `SYNTHETIC_ALIASES`).
- `index.ts` + `package.json` — the extension entry and its `pi.extensions`
  manifest. **The folder IS the package**: no `extension/` subfolder, no copy
  step, nothing kept in sync with `cmp`.

Nothing is hardcoded: every model id, limit, price, modality and effort enum
comes from the listing. The only literals are the provider's identity (id,
label, canonical base URL, key env — all read from `lib/cloud-providers.mjs`,
docs/d024), `api: "openai-completions"` (a claim about the wire, not about a
model), and pi's own schema defaults for a limit the listing did not publish.

### Why the three-source ladder was deleted

The first version read the provider's listing, then fell back to the vendored
models.dev slice and then to the vendored catwalk price slice, merging per field.
Measured against a live listing, the two vendored rungs changed **zero** emitted
values — while contributing four models the provider had already rotated away
and omitting the `syn:*` tiers it does serve. So the committed artifact, when
generated offline (the default in this repo), was four ghosts plus a missing
tier.

The reasoning that retired it: if the provider's own metadata endpoint is
unreachable, the network or the provider is already broken, and a stale second
catalog cannot make either work. The ladder bought nothing and cost a
precedence engine, a copy step, two env surfaces, and a lineup that could
contradict its own upstream.

What replaced it:

- **A failure throws.** No stale-copy branch, no lineup floor. The committed
  artifact is the offline fallback, and the atomic writer guarantees a failed
  run leaves it untouched. The honest signal for "the provider is unreachable"
  is a failed run, not a silently stale regeneration.
- **The consequence is stated, not hidden:** a fresh checkout ages until someone
  regenerates. `./generate.sh --check` is the gate that makes that visible.
- **The route machinery went too.** The canonical upstream is what artifacts
  carry; the request rides the environment's forward proxy
  (`NODE_USE_ENV_PROXY=1` plus the forwarded `HTTP(S)_PROXY`, docs/d074),
  which both consumers already have. This folder is no longer a third
  hand-rolled client of `llm-reverse-proxy`.

### Whole-folder standalone — and the copy step that was deleted

`docs/architecture.md`'s standalone rule is satisfied at the FOLDER level (the
folder + `../lib` is the copy unit), so `index.ts` imports `./sources.mjs` and
`./merge.mjs` directly. Nothing is duplicated and nothing needs a `cmp` check.

The first version could not do that: it shipped a second consumer (a generator
half) that ran from the folder root while the extension loaded from a
subfolder, so the shared data modules were COPIED into `extension/` and
refreshed by `--update-extension-data`. Collapsing to one source removed the
second consumer's reason to exist — the generator now writes the extension's
seed from the very modules `index.ts` imports — and the copy step went with it.
If a future change reintroduces two module roots here, that is the signal that
the folder has grown a second consumer again, and the copy idiom (one home,
copied to the place that must stand alone) is how this repo has handled that
before.

### Why an extension at all, rather than a second `models.json` layer

`models.json` is read from ONE agent dir. A provider block that has to work on
a host with no such dir has to arrive as a loadable resource, and pi's resource
model for that is a package/extension (`pi install`, `-e`, or a dropped-in
`extensions/` folder). The extension also gets the one capability a static
layer cannot have: `refreshModels`, which re-reads the provider's own listing
at runtime.

## Consequences

- **Two descriptions of one provider exist until the open seam lands.**
  `coding-agent/generate-pi-coding-agent.mjs` still derives the `synthetic` row
  from models.dev alone (docs/d092's inferx shape), so it carries models the
  provider has rotated away and misses the `syn:` tiers entirely. The drift is
  real and silent until the seam closes.
- **One source, so a failed fetch is a failed run** (see 'Why the three-source ladder was deleted'). A fresh checkout
  ages until someone regenerates; `./generate.sh --check` is the gate.
- **The lineup is "the provider's list, updated when we look"** rather than
  "whatever models.dev mirrored". Rows the vendored catalog never carried
  (`hf:Qwen/Qwen3.8-27B` today) appear as soon as the provider serves them.
- **The category tiers carry their target in the display name.**
  `syn:large:text` and its three siblings are fixed ids whose target model
  rotates, so `name` renders it —
  `syn:large:text (hf:deepseek-ai/DeepSeek-V4.1-Flash-1017)` — because the id
  alone cannot say what it points at. The mapping is also committed as DATA
  (`models.js`'s `SYNTHETIC_ALIASES`) and passed to the registration directly:
  it is never recovered by parsing a display name, because a name is display
  text and a model legitimately called "… (NVFP4)" would poison any parser.
  `ALIAS_TIER_IDS` survives as a WARN-ONLY checklist — a tier the listing stops
  serving is reported, never invented, since the listing is the sole source.
- **`infinite:*` ids are filtered.** The listing publishes a second routing
  family that this OpenAI surface does not serve.
- **No route substitution here.** Committed artifacts keep canonical upstream
  URLs (docs/d070); routing rides the environment's forward proxy
  (`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY`, docs/d074), so this
  folder carries no relay/probe machinery.

## Not decided here — the open seam

The join with `coding-agent/`:

- Option A: the `synthetic` `PROVIDER_SPECS` row reads this folder's merged
  list (one merge, one source of truth), and `model-019` becomes a rendering of
  `pi-synthetic/models.json`.
- Option B: `coding-agent/generate.mjs` runs `pi-synthetic/generate.sh` first
  and `model-019` is copied from the result.

Either way the change lands in the repo that owns `generate-pi-coding-agent.mjs`
and its docs (it is a `PROVIDER_SPECS`/stage edit plus a doc sync — d032's
checklist), not in this folder. Until then both artifacts are generated, both
are committed, and the folder's README says so.

Also explicitly not decided: adopting anything from `docs/d028`'s wider
proposal (runtime direct→relay fallback logic at provider level, deleting the
generated machinery). d028 keeps its own status; this record neither implements
nor supersedes it.

## The two contracts that differ between the two artifacts

Both artifacts render the same shaped record, but pi validates them with
different schemas, and two fields genuinely differ. Both were found by running
the real packages rather than by reading docs:

- **`cost`.** In `models.json` the block is OPTIONAL and docs/d057's rule is
  to omit a partial or absent one. On a REGISTERED model it is mandatory
  (`ProviderModelConfigBase.cost`), and pi dereferences `model.cost.tiers` on
  every scored turn — so an omitted block throws instead of streaming.
  `toExtensionModel` always emits four fields, zeros when nothing was
  published. This is the one place the folder deliberately does not follow
  d057, and `merge.mjs` says so where the divergence lives.
- **`thinkingLevelMap`.** Both carry the map derived from the published effort
  enum. On the extension side it is not optional polish:
  `getSupportedThinkingLevels()` fabricates `off`…`high` when no map is
  present, which would advertise `off` un-published by the provider AND hide
  `max`/`xhigh` it does. `thinkingLevelMapFor` is the single derivation.

A test asserts the two renderings agree per model, because "one shaping, two
renderings" is the point of the folder — a divergence is the bug the design
exists to prevent.

## Verification

- `node --test tests/pi-synthetic.test.mjs` — 19 tests over the shaping rules
  (modality gate, cost rule, thinking maps, canonical order, alias-name
  round-trip, the alias map, price parsing), the source (`fetchListing` against
  an injected fetch, the id-family filter, the throw-on-failure rule, the tier
  warning), the committed artifacts, and the extension entry imported and RUN.
- `./check-types.sh` and `biome check` are clean for the folder (added to
  `tsconfig.json`'s include list and the repo lint path; the generated pair is
  excluded from biome like `coding-agent/model-*.json`).
- Regeneration is idempotent: a second `./generate.sh` over the same listing
  leaves both artifacts byte-identical, and `./generate.sh --check` reports
  clean — proven both ways by appending a byte to `models.js` and watching the
  check fail, then pass after a regeneration.
- The extension LOADS and REGISTERS in-process (Node's native TypeScript
  stripping over the real entry point) and every registered row survives
  `calculateCost` and `getSupportedThinkingLevels` from
  `@earendil-works/pi-ai@1.4.0`.
- **Not** verified: a real turn. The transport is untouched by any test here
  and no pi process has loaded this extension. the host-side verification section of
  `pi-synthetic/TODO.md` owns the rest.
