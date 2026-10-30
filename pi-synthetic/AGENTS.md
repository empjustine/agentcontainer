# AGENTS.md — pi-synthetic

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
and the `lib/` contract are in `../docs/architecture.md`. What follows is only
what is specific here.

## One source of truth, and it is the provider

- **The listing is the only input.** Do not add a fallback catalog "to be
  safe". A second source cannot make an unreachable network work; it only lets
  the committed artifact contradict its own upstream, which is exactly the
  state the three-source ladder was deleted for (see `PENDING.md`).
- **A failure throws.** No stale-copy branch, no lineup floor. The committed
  artifact is the offline fallback, and a failed run must never write a worse
  one — the atomic writer (`lib/artifact.mjs`) is what makes that true.
- **No invented facts.** The only literals are the provider's identity (from
  `lib/cloud-providers.mjs`), `api: "openai-completions"` (a claim about the
  wire, not a model), and pi's own schema defaults for a limit the listing did
  not publish.
- **`cost`** follows docs/d057 in the manifest (omit a partial block) and fills
  zeros in the extension (a registered model's cost is mandatory and pi
  dereferences it). That divergence is deliberate; do not "unify" it.
- **Efforts and thinking levels** come only from a published effort enum. A
  model with no enum gets no map; do not synthesize one.
- **Compat** carries only capabilities a source published. pi's own guidance is
  explicit that a compat flag enabled on a hunch is a wire-level lie — it
  changes what pi SENDS.

## The alias mapping is data, never a parsed name

A display name is display text: a model may legitimately be called
"Nemotron 3 Super 120B (NVFP4)", whose trailing parenthesis any parser would
read as an alias target. So:

- the mapping lives in `models.js`'s `SYNTHETIC_ALIASES` and is passed to the
  registration as a field;
- `isAliasName` is the ONLY name-based check, and it is an exact-render
  comparison, not a parse;
- adding a "parse the name back" helper would reintroduce the unsound behavior
  the review deleted. Don't.

## Generated artifacts

`models.json` and `models.js` are written by `generate.mjs`. Hand-editing
them is erased by the next `./generate.sh` — fix the shaping instead. Both are
in `biome.jsonc`'s ignore list (generated files, same reasoning as
`coding-agent/model-*.json`). `./generate.sh --check` is the drift gate;
prefer it over eyeballing a diff when you only need to know "is this current".

## The folder is the package

`index.ts`, `sources.mjs`, `merge.mjs`, `models.js` and `package.json` at this
level ARE the pi package. If a change seems to need a subfolder, a copy step, or
two module trees kept in sync with `cmp`, it is rebuilding machinery that was
already deleted once — find out why before doing it.

`index.ts` is excluded from `tsconfig.json` because it imports
`@earendil-works/pi-coding-agent`, which this repo does not vendor.
`tests/pi-synthetic.test.mjs` covers it by IMPORTING AND RUNNING it, which is a
stronger check than a type pass. Keep that test working.

## The fleet seam (the one open piece)

`../coding-agent/generate-pi-coding-agent.mjs` still owns the fleet artifact and
its route substitution (docs/d070); this folder owns the extension package. When
they are joined:

- the `synthetic` `PROVIDER_SPECS` row should read THIS folder's shaped listing
  (or `model-019` should be revived from `pi-synthetic/models.json`), so one
  shaping describes the provider; and
- canonical URLs stay canonical in both committed artifacts, with routing
  substituted only at install (docs/d070).

That change lands in the repo that owns `coding-agent/`, and it is blocked until
the `llm-reverse-proxy` deployment issues are solved. Record the decision in
`docs/` when it lands — this README is not its home.
