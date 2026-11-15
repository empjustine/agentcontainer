# AGENTS.md — pi-hyper

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
(a folder is a copy unit) is in `../docs/architecture.md`. What follows is only
what is specific here. The folder contract is `../pi-synthetic/AGENTS.md`'s,
applied to this provider (docs/d096/d100) — read that one first; only the
hyper-specific deltas are below.

## One source of truth, and it is the provider

- **The `/provider` document is the only input** — lineup, metadata and
  prices in one place, PUBLIC (no key needed to read it). Do not add a
  models.dev fallback "to be safe": the catalog carries hyper too, but a
  second source can only lag or contradict the provider's own document.
- **A failure throws.** There is no committed copy and no fallback lineup: a
  broken read leaves the provider unconfigured for that run, which is the
  observable outcome (docs/d190).
- **The compat mirror is a TRANSCRIPTION, not a published fact.**
  `merge.mjs`'s `HYPER_WIRE_COMPAT` copies charmbracelet/pi-hyper-provider
  `src/models.ts` (the same transcription the fleet's modelCompat makes,
  docs/d033) — upstream can revise its table and this mirror has no
  tripwire. Re-derive against that repo before changing any value here on
  a hunch; the tests pin today's values so a silent local edit is caught.
- **Efforts and thinking levels** come only from the published
  `reasoning_levels` enum. The ONE exception is the ON_OFF map for
  reasoning models with no enum (the vendor extension's map, fleet
  `onOffThinking: true`) — do not extend it to other models.
- **The cached-price pairing is correct as written**: `in_cached` is
  cache WRITE, `out_cached` is cache READ (verified against catwalk's own
  schema — see merge.mjs). It looks crossed; it is not.

## Nothing is committed

No lineup, no fallback, no manifest. `refreshModels` reads the provider's
`/provider` document on every run (docs/d190), and `generate` is a stub that
prints its own name — so there is no
artifact to hand-edit, no `--check` drift gate, and no generated file in
`biome.jsonc`'s ignore list. A stub rather than a deleted script keeps the
unit's entrypoint table whole (docs/d113).

The extension registers no lineup of its own (docs/d190): `refreshModels` is
the only source. Do not add a `models` field or a committed seed to make an
offline start look populated.

## The fleet seam (the one open piece)

`../coding-agent/generate-pi-coding-agent.mjs` still derives the fleet's
hyper layer (model-016) from models.dev ∪ its own fetch of the listing, so two artifacts
describe one provider and can drift (observed at landing: the fleet layer
carries a stale `deepseek-v4.1-flash` context window the live listing has
since corrected). The join is blocked on the same estige
deployment decision as pi-synthetic's seam (docs/d096, d100) — do not start
it independently.
