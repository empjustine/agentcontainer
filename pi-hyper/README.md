# pi-hyper — the Charm Hyper provider as a pi package

Registers the **Charm Hyper** gateway (`https://hyper.charm.land/v1`, the
frozen provider row in `sources.mjs`) with
[pi](https://github.com/earendil-works/pi), seeded from committed artifacts
and refreshed at runtime from the provider's own `/provider` catalog.

## Install

```sh
pi install ./pi-hyper -l    # local package from this repo
# or point pi straight at the entry:
pi -e ./pi-hyper/index.ts
```

## Environment

| Var             | Meaning                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `HYPER_API_KEY` | the key pi sends as `Authorization: Bearer` (an unset key leaves the provider unconfigured — pi hides its models from `/model`) |

The catalog itself is PUBLIC — a keyless generator run regenerates the same
artifacts. Network rides the environment's forward proxy
(`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY`, docs/d074). No relay
ladder, no route files.

## The lineup contract in one screen

One source: the provider's own `/provider` document — lineup, metadata and
prices together. A failed fetch fails the run (the committed artifact is the
offline fallback); `./npm-run.sh pi-hyper generate --check` (from
the repo root) is the drift gate. The one
transcribed fact is the wire-compat mirror (see Provenance below) — everything
else (prices, limits, effort enums, attachment support) comes from the
document.

## Files

| File           | Role                                                                               |
| -------------- | ---------------------------------------------------------------------------------- |
| `index.ts`     | the extension entry: `registerProvider` + `refreshModels` (the listing at runtime) |
| `sources.mjs`  | the ONE source read: the provider's `/provider` catalog at the canonical upstream  |
| `merge.mjs`    | the ONE shaping step + both projections (manifest entry, registered-model entry)   |
| `generate.mjs` | one fetch in, two artifacts out; `--check` verifies without writing                |
| `log.mjs`      | the JSONL log lines `generate.mjs` and `sources.mjs` emit (docs/d045)              |
| `models.json`  | GENERATED: the pi-`models.json`-shaped hyper block (canonical upstream, d070)      |
| `models.js`    | GENERATED: the extension's offline seed                                            |

Regenerate with `./npm-run.sh pi-hyper generate` from the repo
root (the git diff is the review).

## Provenance

Everything this folder knows comes from three places, with different trust
properties:

- **The provider row** (`sources.mjs`, frozen) — the canonical upstream and
  key env (docs/d024/d070). Live data, one home.
- **The provider's own `/provider` document** — fetched live at generation
  and at refresh. Self-correcting: the source of truth is the source.
- **charmbracelet/pi-hyper-provider** `src/models.ts` — the ONE behavioral
  copy: the wire-compat mirror (`supportsStore: false`,
  `thinkingFormat: "deepseek"`, `maxTokensField: "max_tokens"`) and the
  ON_OFF thinking map are transcribed from that repo, exactly as the fleet's
  modelCompat mirror is (docs/d033). **This is the provenance risk to
  know about**: upstream can revise its compat table and this mirror has no
  tripwire — `tests/pi-hyper.test.mjs` (in this folder) pins today's values so a silent LOCAL
  edit is caught, but an upstream change is caught only by a human
  re-deriving against the repo. Re-derive before changing any value.
  The client-identity header (`User-Agent: npm:@agentcontainer/pi-hyper`)
  follows the convention the vendor extension set (a UA the upstream can
  attribute), spelled with OUR package name — the fleet's model-016 layer
  carries its own static literal and the two should be unified when the
  coding-agent seam closes.

## Tests

```sh
./npm-run.sh pi-hyper test    # from the repo root
```

Network-free (injected fetch) and rule-pinning: the source contract, the
ON_OFF fallback, the cached-price pairing, the compat transcription, the
cost rule, and the committed artifacts — never today's lineup.
