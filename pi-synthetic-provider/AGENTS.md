# AGENTS.md — pi-synthetic-provider

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
(a folder is a copy unit) is in `../docs/architecture.md`. What follows is only
what is specific here.

## One source of truth, and it is the provider

- **The listing is the only input.** Do not add a fallback catalog "to be
  safe". A second source cannot make an unreachable network work; it only lets
  the committed artifact contradict its own upstream, which is exactly the
  state the three-source ladder was deleted for (see `PENDING.md`).
- **A failure throws.** No stale-copy branch, no lineup floor: a broken read
  leaves the provider unconfigured, which is the outcome a user can see, not a
  catalog nobody is serving (docs/d190).
- **No invented facts.** The only literals are the provider's identity (the
  frozen row in `sources.mjs`), `api: "openai-completions"` (a claim about the
  wire, not a model), and pi's own schema defaults for a limit the listing did
  not publish.
- **`cost`** fills zeros in the extension: a registered model's cost is
  mandatory and pi dereferences it, and a partial block is worse than a zero one
  (docs/d057). There is no manifest to diverge from.
- **Efforts and thinking levels** come only from a published effort enum. A
  model with no enum gets no map; do not synthesize one.
- **Compat** carries only capabilities a source published. pi's own guidance is
  explicit that a compat flag enabled on a hunch is a wire-level lie — it
  changes what pi SENDS.

## The alias mapping is data, never a parsed name

A display name is display text: a model may legitimately be called
"Nemotron 3 Super 120B (NVFP4)", whose trailing parenthesis any parser would
read as an alias target. So:

- the target comes from `aliasTarget(row)` on the listing row and is rendered
  by `displayNameFor`, the one function that builds the name — there is no
  committed `SYNTHETIC_ALIASES` table (docs/d190 removed it);
- `ALIAS_TIER_IDS` is the provider's API contract: a listing that omits one
  fails the refresh, so pi reports a normal refresh error rather than
  publishing a lineup with a hole;
- adding a "parse the name back" helper would reintroduce the unsound behavior
  the review deleted. Don't.

## Nothing is committed

No lineup, no fallback, no manifest. `refreshModels` reads the provider's
`/models` listing on every run (docs/d190), and `generate` is a stub that prints
its own name — so there is no artifact to hand-edit, no `--check` drift gate,
and no generated file in `biome.jsonc`'s ignore list. A stub rather than a
deleted script keeps the unit's entrypoint table whole (docs/d113).

**The last verified read is persisted, not remembered.** `refreshModels` answers
pi's cache-only phase with the catalog `context.stored` holds, and stores every
successful read through `context.publish({ persist })` (docs/d190's amendment) —
a snapshot of what the provider actually answered, never a seed: a failed read
still throws and stores nothing, so an offline start shows the last verified
catalog and a first run still shows nothing.

The extension registers no lineup of its own (docs/d190): `refreshModels` is
the only source. Do not add a `models` field or a committed seed to make an
offline start look populated.

## The folder is the package

`index.mjs`, `sources.mjs`, `merge.mjs` and `package.json` at this level ARE
the pi package. If a change seems to need a subfolder, a copy step, or two
module trees kept in sync with `cmp`, it is rebuilding machinery that was
already deleted once — find out why before doing it.

`index.mjs` is INSIDE the `tsconfig.json` program: the folder carries
`@earendil-works/pi-coding-agent` as an exact devDependency (pnpm, so six
folders share one store copy — docs/d107), which is what makes its types real
instead of hand-declared. `tests/pi-synthetic-provider.test.mjs` additionally IMPORTS AND
RUNS the entry, which is the check a type pass cannot do. Keep that test
working.

## The fleet seam (the one open piece)

`../coding-agent/generate-pi-coding-agent.mjs` still owns the fleet artifact and
its route substitution (docs/d070); this folder owns the extension package. When
they are joined:

- the `synthetic` `PROVIDER_SPECS` row should read THIS folder's shaped listing
  (or `model-019` should be revived from this folder's shaped listing), so one
  shaping describes the provider; and
- canonical URLs stay canonical in both committed artifacts, with routing
  substituted only at install (docs/d070).

That change lands in the repo that owns `coding-agent/`, and it is blocked until
the `estige` deployment issues are solved. Record the decision in
`docs/` when it lands — this README is not its home.
