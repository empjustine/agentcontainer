# AGENTS.md — pi-hyper

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
and the `lib/` contract are in `../docs/architecture.md`. What follows is only
what is specific here. The folder contract is `../pi-synthetic/AGENTS.md`'s,
applied to this provider (docs/d096/d100) — read that one first; only the
hyper-specific deltas are below.

## One source of truth, and it is the provider

- **The `/provider` document is the only input** — lineup, metadata and
  prices in one place, PUBLIC (no key needed to read it). Do not add a
  models.dev fallback "to be safe": the catalog carries hyper too, but a
  second source can only lag or contradict the provider's own document.
- **A failure throws.** The committed artifact is the offline fallback;
  the atomic writer (`lib/artifact.mjs`) is what makes that true.
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

## Generated artifacts

`models.json` and `models.js` are written by `generate.mjs`. Hand-editing
them is erased by the next `./generate.sh` — fix the shaping instead. Both
are in `biome.jsonc`'s ignore list (generated files, same reasoning as
`coding-agent/model-*.json`). `./generate.sh --check` is the drift gate.

## The fleet seam (the one open piece)

`../coding-agent/generate-pi-coding-agent.mjs` still derives the fleet's
hyper layer (model-016) from models.dev ∪ the facts cache, so two artifacts
describe one provider and can drift (observed at landing: the fleet layer
carries a stale `deepseek-v4.1-flash` context window the live listing has
since corrected). The join is blocked on the same llm-reverse-proxy
deployment decision as pi-synthetic's seam (docs/d096, d100) — do not start
it independently.
