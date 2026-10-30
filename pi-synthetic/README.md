# pi-synthetic

The **Synthetic** provider for [pi](https://github.com/earendil-works/pi) as one
committed, self-contained pi package: a generator that reads the provider's own
model listing, and an extension that registers it.

This is the folder the fleet's `coding-agent/generate-pi-coding-agent.mjs`
emits as `model-019-cloud-synthetic.json` — the same provider, packaged so it
works on a host that has no generated agent dir (bare host, `pi -e`, a
container that mounts only a work directory).

Written from scratch against pi's documented contracts. The reference for _what_
to build was [aliou/pi-synthetic](https://github.com/aliou/pi-synthetic) (MIT),
read as source and never installed — see "Provenance".

## Layout

| Path                                   | Role                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sources.mjs`                          | the ONE data source: the provider's `/models` listing, fetched from the fact table's canonical upstream                   |
| `merge.mjs`                            | the ONE shaping step (`shapeListing`/`shapeRow`) plus the two projections — pi `models.json` entry, pi-ai extension entry |
| `generate.mjs` / `generate.sh`         | one fetch in, two committed artifacts out; `--check` verifies them without writing                                        |
| `index.ts`                             | the pi extension entry (provider registration + `refreshModels`)                                                          |
| `models.json`                          | **generated** — a pi `models.json`-shaped manifest with the `synthetic` provider block (canonical upstream, docs/d070)    |
| `models.js`                            | **generated** — the extension's offline seed: `SYNTHETIC_MODELS` + `SYNTHETIC_ALIASES`                                    |
| `package.json`                         | the pi package manifest (`pi.extensions` → `./index.ts`)                                                                  |
| `AGENTS.md` / `TODO.md` / `PENDING.md` | folder rules · open items · the review that collapsed the design                                                          |

The folder **is** the package. There is no `extension/` subfolder, no copy step,
and nothing kept in sync between two module trees — those existed only while
there were two consumers with different module roots, and they are gone with the
three-source ladder that caused them.

## Generate

```sh
./generate.sh            # fetch, shape, write both artifacts
./generate.sh --check    # verify the committed artifacts are current (no write)
```

The root `./generate.sh` does not run this folder yet (see "Not wired in"),
so run the folder shim. `--check` is the CI-shaped form: it exits non-zero when
a committed artifact differs from a fresh generation.

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
  and the committed artifact — written atomically (`lib/artifact.mjs`) — is what
  a network-less host falls back to. That also makes the drift "did anyone
  regenerate lately", stated plainly instead of hidden behind a fallback.
- **Routing is not this folder's business.** The canonical URL is what the
  artifacts carry; the request reaches the provider through the environment's
  forward proxy (`NODE_USE_ENV_PROXY=1` plus the forwarded `HTTP(S)_PROXY`,
  docs/d074), which both consumers already have. Third-generation
  `llm-reverse-proxy` makes that path real, so no client-side relay/probe
  machinery lives here.

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
mapping is also committed as **data** (`SYNTHETIC_ALIASES` in `models.js`) and
passed to the registration as-is — it is never parsed back out of a display
name. A test asserts the two agree, which is what would catch a hand-edited or
half-regenerated artifact. If the provider stops serving a tier, generation
**warns** and publishes what it has; it does not invent a row.

## Use the extension

```sh
# one invocation, nothing installed
pi -e ./pi-synthetic/index.ts

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
never written to an artifact or a log. With no key the provider stays
unconfigured (pi hides its models from `/model`), while the listing stays
fetchable — it is public.

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
`index.ts` reads.

**Not** verified: a real turn. The transport is untouched by any test here, and
no pi process has ever loaded this extension. `TODO.md` §1 carries the rest.

## Not wired in yet

- `coding-agent/generate-pi-coding-agent.mjs` still derives the `synthetic` row
  from models.dev alone (its own `PROVIDER_SPECS` entry → layer
  `model-019-cloud-synthetic.json`). Two sources now describe one provider.
  Joining them is a small mechanical change, and it is deliberately blocked —
  the existing generators stay untouched until the `llm-reverse-proxy`
  deployment issues land. See `TODO.md` §3.
- The root `./generate.sh` and `./build.sh` do not know about this folder: it
  has no container image and no root-build target.

## Provenance

- Provider facts: `lib/cloud-providers.mjs` (`synthetic`, docs/d092).
- The emitted provider block's shape: `coding-agent/model-019-cloud-synthetic.json`.
- Extension API surface: pi's own docs — `docs/custom-provider.md`,
  `docs/extensions.md` — and the installed packages (see above).
- Reference implementation, read as source and not installed:
  [aliou/pi-synthetic](https://github.com/aliou/pi-synthetic) (MIT, © Aliou
  Diallo). Taken: the idea that a bearer `authHeader` beats an SDK default, and
  that the provider's own listing is the authoritative lineup. Not taken: its
  five-extension layout, settings/status UI, utility-API proxy, and hardcoded
  catalog.
- The review that deleted the three-source ladder, with its measurements:
  `PENDING.md`.
- Generator conventions (atomic writes, canonical JSON, the fact table):
  `docs/d024`, `docs/d050`, `docs/d070`, `docs/d092`.
