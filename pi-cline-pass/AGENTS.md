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
  limit no source published.
- **cost** states nothing about this provider: the docs table prints reference
  rates for a subscription, not what a scored turn bills, so the registration
  fills the mandatory zero block and no other reader exists (docs/d189). Do not
  "complete" it from any source — a filled price is a number nobody charged.
- **Efforts and thinking levels** come only from a published effort enum.
  This row's `onOffThinking` is false — there is no on/off fallback map to
  synthesize for a model whose enum was not published.
- **compat is ONE fact with ONE spelling** (`CLINE_PASS_COMPAT`):
  `supportsDeveloperRole: false` — ClinePass rejects the `developer` role
  pi-ai emits (docs/d022, docs/d033). It rides PER MODEL in the registration,
  because pi 1.4.0's `ProviderConfig` has NO provider-level `compat` field
  and registration overwrites the models layer; nothing here writes a manifest
  that could carry it instead. Do not move it, duplicate its literal, or add a
  provider-level `compat` to `registerProvider` — it would be silently dropped.
- **No alias map**, unlike pi-synthetic: ClinePass publishes no rotating
  tier ids, so an alias export would be an invented contract.

## Nothing is committed

No lineup, no fallback, no manifest. `refreshModels` reads the docs table on
every run (docs/d190), and `generate` is a stub that prints its own name — so
there is no artifact to hand-edit, no `--check` drift gate, and no generated
file in `biome.jsonc`'s ignore list. A stub rather than a deleted script keeps
the unit's entrypoint table whole (docs/d113).

The lineup is committed to neither shaper: the docs table is read on every
run, so a rotation is a live change rather than a constant edited here and in
`../coding-agent/generate-pi-coding-agent.mjs`.

## The folder is the package

`index.mjs`, `sources.mjs`, `merge.mjs` and `package.json` at this level ARE
the pi package. If a change seems to need a subfolder, a copy step, or two
module trees kept in sync, it is rebuilding machinery that was already deleted
once in pi-synthetic — find out why before doing it.

`index.mjs` is INSIDE the `tsconfig.json` program: the folder carries
`@earendil-works/pi-coding-agent` as an exact devDependency (pnpm, so six
folders share one store copy — docs/d107), which is what makes its types real
instead of hand-declared. `tests/pi-cline-pass.test.mjs` additionally IMPORTS AND
RUNS the entry, which is the check a type pass cannot do. Keep that test
working.

## The docs MCP reference

`README.md`'s "Documentation references" names Cline's keyless docs MCP
(`https://docs.cline.bot/mcp`, discovered at `/.well-known/mcp`) and the docs
index. It is a reference: nothing here reads it at runtime, and the fleet entry
in `../coding-agent/mcp.json` stays `enabled: false` with `exposure: hidden`
(docs/d061).

## The fleet seam

`../coding-agent/generate-pi-coding-agent.mjs` owns the fleet artifact and
its `model-015` row; this folder owns the extension package, duplicating the
shaping because the standalone rule forbids reaching into a sibling runner
(`docs/architecture.md`). Contract changes (the lineup direction, the
compat fact, the eligibility gates) land in BOTH until one shaping describes
the provider. Record the join in `docs/` when it lands — this file
is not its home.
