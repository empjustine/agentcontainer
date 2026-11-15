# AGENTS.md — pi-cline-pass

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
(a folder is a copy unit) is in `../docs/architecture.md`. What follows is only
what is specific here (docs/d040 owns the lineup contract itself).

## Two sources, one direction — and never the provider's own listing

- **The docs table is the lineup** (which ids ClinePass serves); **models.dev
  is the metadata** (prices, limits, effort enums). Neither can stand in for
  the other, which is why this folder has two sources where pi-synthetic
  fought its way down to one: those were rungs of one ladder, these are two
  different claims. The direction is fixed (docs/d189): a table id the slice
  has not caught up to still publishes on pi's defaults, and an id only the
  slice carries is a retired model that never publishes.
- **The provider's own `/models` listing is not a source, ever.** At
  api.cline.bot it answers with the `cline` (usage-billing) provider's
  catalog — a different provider — which is why the fleet's cline-pass row
  carries `liveSync: false`. Do not add it "as a sanity check": it would
  prune the real lineup and append hundreds of wrong-priced ids.
- **There is no committed lineup and no agreement floor.** Neither shaper
  holds a list of model ids; both read the table per run, so a rotation is a
  regenerated artifact set. A fallback list would let this folder claim
  availability no source confirmed — the thing d189 exists to remove — so it
  is not coming back for offline use either.
- **Both reads THROW.** No lineup table or no metadata source means there is
  nothing to publish, and ClinePass unavailable is the answer (a failed run
  writes nothing; the writers are atomic). `CLINE_PASS_MDX` pins a table on
  a host that carries one; the git-mirror farm is not consulted.
- **A third source exists as documentation, not as code** (README:
  "Candidate third source"): `@cline/llms` bakes Cline's own catalog, but
  ships it as a minified bundle that needs format-fragile parsing. If it is
  ever wired in, it enters as metadata for ids the table already names — never
  as a lineup authority, and never by adding a package dependency (text
  extraction from a pinned, checksummed tarball only).

## The prefix is money

Every published row must carry the `cline-pass/` prefix: an unprefixed id
served through this gateway bills at standard API pricing instead of the
subscription (docs/d040). Guards live in `shapeCatalog` — the map key is
filtered, and the key WINS over any id a record body carries. Tests pin both
halves. Never "helpfully" add or strip the prefix in shaping: the id IS the
billing selector.

## No invented facts, spelled for this folder

- Provider identity comes only from `sources.mjs`'s frozen row; the only other
  literals are `api: "openai-completions"` and pi's schema defaults for a
  limit the catalog did not publish.
- **cost** completes a partial block with zeros (models.dev routinely omits
  `cache_write`; the fleet publishes 0 for those) and yields nothing only
  when the whole block is zero. The manifest omits that nothing; the
  registration fills zeros, because a registered model's cost is mandatory
  and pi dereferences it. The divergence is deliberate; do not "unify" it.
- **Efforts and thinking levels** come only from a published effort enum.
  This row's `onOffThinking` is false — there is no on/off fallback map to
  synthesize for a model whose enum was not published.
- **compat is ONE fact with ONE spelling** (`CLINE_PASS_COMPAT`):
  `supportsDeveloperRole: false` — ClinePass rejects the `developer` role
  pi-ai emits (docs/d022, docs/d033). It rides provider-level in
  `models.json` (the fleet's shape) and per model in the registration,
  because pi 1.4.0's `ProviderConfig` has NO provider-level `compat` field
  and registration overwrites the models layer. Do not move it, duplicate
  its literal, or add a provider-level `compat` to `registerProvider` — it
  would be silently dropped.
- **No alias map**, unlike pi-synthetic: ClinePass publishes no rotating
  tier ids, so an alias export would be an invented contract.

## Generated artifacts

`models.json` is written by `generate.mjs`; it is the only artifact. Hand-
editing it is erased by the next generation run — fix the shaping instead. It
is in `biome.jsonc`'s ignore list (generated file).
`./npm-run.sh pi-cline-pass generate --check` is the drift gate; prefer it over
eyeballing a diff when you only need to know "is this current".

The extension registers no lineup of its own (docs/d190): `refreshModels`
reads the docs table, so the artifact is the drift-gate and fleet-parity
record, with no runtime reader.

The lineup is committed to neither shaper: the docs table is read on every
run, so a rotation is a regenerated artifact set rather than a constant
edited here and in `../coding-agent/generate-pi-coding-agent.mjs`.

## The folder is the package

`index.ts`, `sources.mjs`, `merge.mjs`, `log.mjs` and
`package.json` at this level ARE the pi package (`log.mjs` included: it is what
`sources.mjs`, and therefore the loaded extension, writes its log lines with). If a change seems to need a subfolder, a copy
step, or two module trees kept in sync, it is rebuilding machinery that was
already deleted once in pi-synthetic — find out why before doing it.

`index.ts` is excluded from `tsconfig.json` because it imports
`@earendil-works/pi-coding-agent`, which this repo does not vendor.
`tests/pi-cline-pass.test.mjs` covers it by IMPORTING AND RUNNING it, which
is a stronger check than a type pass. Keep that test working.

## The fleet seam

`../coding-agent/generate-pi-coding-agent.mjs` owns the fleet artifact and
its `model-015` row; this folder owns the extension package, duplicating the
shaping because the standalone rule forbids reaching into a sibling runner
(`docs/architecture.md`). Contract changes (the lineup direction, the
compat fact, the eligibility gates) land in BOTH until one shaping describes
the provider. Record the join in `docs/` when it lands — this file
is not its home.
