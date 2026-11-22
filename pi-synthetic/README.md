---
id: pi-synthetic
type: module-design
status: active
title: "pi-synthetic — the Synthetic provider as a committed, self-contained pi package"
parent: architecture
depends-on: [d096]
references: [d100, d118]
tags: [pi-extensions, providers, synthetic]
---

# pi-synthetic

The **Synthetic** provider for [pi](https://github.com/earendil-works/pi) as one
committed, self-contained pi package: a generator that reads the provider's own
model listing, and an extension that registers it.

This is the folder the fleet's `coding-agent/generate-pi-coding-agent.mjs`
emits as `model-019-cloud-synthetic.json` — the same provider, packaged so it
works on a host that has no generated agent dir (bare host, `pi -e`, a
container that mounts only a work directory).

Written from scratch against pi's documented contracts. The references for
_what_ to build are [aliou/pi-synthetic](https://github.com/aliou/pi-synthetic)
and [ben-vargas/pi-packages](https://github.com/ben-vargas/pi-packages)
(`packages/pi-synthetic-provider`), both MIT, read as source and never installed
— see "Prior art" and "Provenance".

## Layout

| Path                                   | Role                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `sources.mjs`                          | the ONE data source: the provider's `/models` listing, fetched from the folder's own canonical-upstream row |
| `merge.mjs`                            | the ONE shaping step (`shapeListing`/`shapeRow`) and the projection into pi-ai's registered-model entry     |
| `log.mjs`                              | the JSONL log lines `sources.mjs` emits (docs/d045)                                                         |
| `index.mjs`                            | the pi extension entry (provider registration + `refreshModels`)                                            |
| `package.json`                         | the pi package manifest (`pi.extensions` → `./index.mjs`)                                                   |
| `AGENTS.md` / `TODO.md` / `PENDING.md` | folder rules · open items · the review that collapsed the design                                            |

The folder **is** the package. There is no `extension/` subfolder, no copy step,
and nothing kept in sync between two module trees — those existed only while
there were two consumers with different module roots, and they are gone with the
three-source ladder that caused them.

## Generate

There is nothing to generate. `./npm-run.sh pi-synthetic generate` prints a
stub line and exits 0: `refreshModels` fetches the listing on every run
(docs/d190), so this folder carries no artifact for a `--check` to compare. The
script stays because a unit's `package.json` is its entrypoint table
(docs/d113).

## One source, deliberately

The provider's own listing — `https://api.synthetic.new/openai/v1/models`, the
fact table's canonical upstream (docs/d070) — is the lineup, the metadata and
the prices. Nothing is hardcoded: model ids, names, limits, prices, modalities
and the reasoning effort enums all come from that response.

This replaced a three-source ladder (live listing, then the vendored models.dev
slice, then the vendored catwalk slice). It was measured: against a live listing
the two vendored rungs changed **zero** emitted values, while contributing four
models the provider had already rotated away and omitting the `syn:*` tiers it
does serve. A second catalog cannot make an unreachable network work, and it
made the committed artifact contradict its own upstream.

Consequences worth knowing:

- **A failed fetch is a failed run.** There is no stale-copy branch and no
  lineup floor: a bogus or unreachable source means the provider is unreachable,
  and the committed artifact — written atomically by `generate.mjs` — is what
  a network-less host falls back to. That also makes the drift "did anyone
  regenerate lately", stated plainly instead of hidden behind a fallback.
- **Routing is not this folder's business.** The canonical URL is what the
  artifacts carry; the request reaches the provider through the environment's
  forward proxy (`NODE_USE_ENV_PROXY=1` plus the forwarded `HTTP(S)_PROXY`,
  docs/d074), which both consumers already have. Third-generation
  `estige` makes that path real, so no client-side relay/probe
  machinery lives here.

## Prior art: the two upstream implementations

Two pi providers serve this same gateway. Both are read as source and neither
is installed or copied from; they are cited because each settles a question
this folder otherwise answers alone.

- **[`aliou/pi-synthetic`](https://github.com/aliou/pi-synthetic)** (MIT) — the
  idea that a bearer `authHeader` beats an SDK default, and that the provider's
  own listing is the authoritative lineup.
- **[`ben-vargas/pi-packages`](https://github.com/ben-vargas/pi-packages)
  → `packages/pi-synthetic-provider`**
  (`@benvargas/pi-synthetic-provider@1.2.7`, MIT) — the closest implementation:
  same endpoint, same catalog fields, the same per-model effort map. The table
  is against that package's `extensions/{config,models,index}.ts`.

|                        | `@benvargas/pi-synthetic-provider`                                                                                | this folder                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| listing                | `…/openai/v1/models`, key from `SYNTHETIC_API_KEY`                                                                | the same URL, built from the frozen row (`sources.mjs`)            |
| fields read            | `context_length`, `max_output_length`, `supported_features`, `reasoning_parameters.efforts`, price                | the same five                                                      |
| lineup owner           | the live catalog, plus a hardcoded `getFallbackModels()` when the fetch fails or answers empty                    | the live catalog only: a failed read publishes nothing (docs/d190) |
| thinking map           | from the advertised efforts, fail-closed; no efforts → no `reasoning_effort` sent                                 | the same map, the same rule (`merge.mjs`'s `thinkingLevelMapFor`)  |
| per-model effort table | hardcoded `REASONING_OVERRIDES` as a startup snapshot, in a `Map` so a catalog id of `constructor` cannot resolve | none — the live enum is the only source                            |
| compat                 | eight explicit flags, plus `supportsReasoningEffort: true` per model                                              | `compat: null`, `modelCompat: null` in the fleet row               |
| credentials            | env var or `~/.pi/agent/auth.json`                                                                                | env var only (`$SYNTHETIC_API_KEY`)                                |
| commands               | `/synthetic-models`, `/synthetic-quota` (`GET /v2/quotas`)                                                        | `/model` only                                                      |

What the comparison settles:

- **The endpoint and the field names are corroborated.** An independent
  implementation reads the same five fields off the same URL, so the fact table
  is not one reader's guess at the wire.
- **The fallback lineup is the rejected pattern, with a live example.** docs/d190
  argues from principle; `pi-synthetic-provider` took the other road and pays
  the price its comment names — the fallback rows and effort snapshots are a
  snapshot only a release can correct, so the extension can describe a lineup
  two releases old while the listing two requests away is current.
- **One compat flag is worth a probe.** `supportsUsageInStreaming` defaults to
  `true` in pi (docs/models-configuration.md) and the upstream sets it `false`
  for this gateway. The other flags that differ (`supportsStore`,
  `supportsDeveloperRole`, `maxTokensField`, `requiresToolResultName`) are
  auto-detected from the URL, so this is the only claim where `compat: null`
  states something different from the vendor's explicit choice. A probe asking
  the gateway for `stream_options.include_usage` settles it; until then this
  folder keeps pi's default rather than copying the flag.
- **Nothing else is taken**: no committed catalog, no `auth.json` reader, no
  quota command — a credential store and a second endpoint are surfaces this
  container has no slot for.

## The category tiers (`syn:`), and why their names carry a target

`syn:large:text`, `syn:small:text`, `syn:large:vision` and
`syn:small:vision` are fixed tier ids that route to "the current best model for
that category": the id never moves, the model behind it rotates. The listing is
the source of truth for them like everything else — nothing is injected — and
the target it names is shown in pi's `name` field:

```text
syn:large:text   →   syn:large:text (hf:deepseek-ai/DeepSeek-V4.1-Flash-1017)
```

The name is generated from the response, never hand-written, so it cannot go
stale; a literal id would silently change meaning at the next rotation. The
target comes from the listing row (`aliasTarget`) and `displayNameFor` renders
it into the name; it is never parsed back out of one, and no committed side
table mirrors it (docs/d190 removed `SYNTHETIC_ALIASES`). If the provider stops serving a tier, generation
**warns** and publishes what it has; it does not invent a row.

## Use the extension

```sh
# one invocation, nothing installed
pi -e ./pi-synthetic/index.mjs

# installed as a package (project-local: .pi/settings.json)
pi install ./pi-synthetic -l

# or discovered from the agent dir
cp -r pi-synthetic ~/.pi/agent/extensions/pi-synthetic
```

Then `/model synthetic hf:zai-org/GLM-5.3-Flash` (any id from the generated
list), with the key in the environment:

```sh
export SYNTHETIC_API_KEY=...
```

The key is referenced as `$SYNTHETIC_API_KEY` and read at request time — it is
never written to an artifact or a log. With no key the provider's refresh fails
instead of leaving it merely unconfigured (pi resolves the reference before
`refreshModels` runs, so `/model` reports "Could not refresh synthetic"), while
the listing stays fetchable — it is public.

## Two contracts that differ between the two artifacts

Both artifacts render the same shaped record, but pi validates them with
different schemas. Two fields genuinely differ, and both were found by running
the real packages rather than by reading docs:

- **`cost`.** In `models.json` the block is optional (docs/d057: omit a partial
  or absent one). On a _registered_ model it is mandatory, and pi dereferences
  `model.cost.tiers` on every scored turn — so an omitted block would throw
  instead of streaming. The extension fills zeros.
- **`thinkingLevelMap`.** Carried by both, and required on the extension side:
  with no map pi fabricates `off`…`high`, which would advertise an `off` the
  provider never published and hide `max`/`xhigh` it does.

A test asserts the two renderings agree for every model, because "one shaping,
two renderings" is the whole point of the folder.

## Checked against pi 1.4.0

`npm i --prefix <scratch> @earendil-works/pi-coding-agent@1.4.0` pulls
`pi-ai`, which is enough to check the registration contract for real, and
`tests/pi-synthetic.test.mjs` imports and executes the real entry point
(Node's native TypeScript stripping) and feeds every registered row through
`calculateCost` and `getSupportedThinkingLevels`. Also confirmed: the legacy
`ProviderConfig.refreshModels` form accepts a returned array ("the returned list
replaces extension-provided models") and its context carries `credential`,
`stored`, `publish`, `allowNetwork`, `force` and `signal` — the fields
`index.mjs` reads.

**Not** verified: a real turn. The transport is untouched by any test here, and
no pi process has ever loaded this extension. `TODO.md` §1 carries the rest.

## Not wired in yet

- `coding-agent/generate-pi-coding-agent.mjs` still derives the `synthetic` row
  from models.dev alone (its own `PROVIDER_SPECS` entry → layer
  `model-019-cloud-synthetic.json`). Two sources now describe one provider.
  Joining them is a small mechanical change, and it is deliberately blocked —
  the existing generators stay untouched until the `estige`
  deployment issues land. See `TODO.md` §3.
- No repo-level build or generate step knows about this folder: it has no
  container image and no `build.mjs`, and its own `package.json` script is the
  only way it is rebuilt.

## Provenance

Every cross-repo reference this folder makes is either LIVE DATA (the fact
table, the provider's own listing — self-correcting, the source of truth is
the source) or an ATTRIBUTION (aliou/pi-synthetic below — read, credited,
nothing copied). It makes no behavioral copy of any third-party code: every
wire claim is either the provider's own publication or pi's own schema
default. That classification is the provenance sanity rule the extension
family holds itself to (docs/d100); the one behavioral copy in the family
lives in ../pi-hyper/ and is flagged there.

- Provider facts: the frozen row in `sources.mjs` (`synthetic`, docs/d092).
- The emitted provider block's shape: `coding-agent/model-019-cloud-synthetic.json`.
- Extension API surface: pi's own docs — `docs/custom-provider.md`,
  `docs/extensions.md` — and the installed packages (see
  _Checked against pi 1.4.0_).
- Reference implementations, read as source and not installed:
  [aliou/pi-synthetic](https://github.com/aliou/pi-synthetic) (MIT, © Aliou
  Diallo) — taken: the bearer `authHeader` and the listing-as-lineup idea; not
  taken: its five-extension layout, settings/status UI, utility-API proxy and
  hardcoded catalog.
  [ben-vargas/pi-packages](https://github.com/ben-vargas/pi-packages)
  `packages/pi-synthetic-provider` (MIT, © Ben Vargas) — taken: confirmation of
  the endpoint and the five catalog fields, and the fail-closed effort map; not
  taken: its fallback lineup, its hardcoded effort snapshots, its `auth.json`
  reader and its quota command. The full mapping is under "Prior art".
- The review that deleted the three-source ladder, with its measurements:
  `PENDING.md`.
- Generator conventions (atomic writes, canonical JSON, the fact table):
  `docs/d024`, `docs/d050`, `docs/d070`, `docs/d092`.

## Base URL override

- `SYNTHETIC_BASE_URL` — optional upstream override, derived from the key env the way Azure OpenAI spells the pair (`SYNTHETIC_API_KEY` → `SYNTHETIC_BASE_URL`). Absolute http(s) only; a trailing slash is trimmed; unset keeps `https://api.synthetic.new/openai/v1`. A malformed value makes the extension fail to load loudly rather than silently use the canonical upstream.
