# AGENTS.md — pi-verboo

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
and the `lib/` contract are in `../docs/architecture.md`. What follows is only
what is specific here. The folder contract is `../pi-synthetic/AGENTS.md`'s,
applied to this provider (docs/d096/d100) — read that one first; only the
verboo-specific deltas are below.

## One source of truth, and it is the provider

- **The `/models` listing is the only input** — and the only one that CAN
  be: models.dev carries no verboo row at all (the fleet's catalogOptional
  case, docs/d057), so there is no second catalog to fall back to even in
  principle.
- **The listing is AUTH-GATED**: regeneration needs `VERBOO_API_KEY`. The
  committed artifact is the offline fallback; a failure throws and the
  atomic writer (`lib/artifact.mjs`) leaves it untouched.
- **No price is ever asserted.** The listing publishes none, so the
  manifest omits the cost block (docs/d057) and the extension fills the
  mandatory zeros. Inventing a price would be a vendor fact nobody
  published.
- **No `maxTokens` in the manifest**: likewise unpublished; pi's schema
  default (16384) is the conservative cap, and the extension carries that
  same default explicitly (its shape takes the field as given).
- **No off-state fallback for thinking**: only a published "none" disables
  thinking (fleet `onOffThinking: false`). A model whose enum lacks it
  simply offers no off state — never an invented wire value.

## Generated artifacts

`models.json` and `models.js` are written by `generate.mjs`. Hand-editing
them is erased by the next `./generate.sh` — fix the shaping instead. Both
are in `biome.jsonc`'s ignore list. `./generate.sh --check` is the drift
gate; both forms need the key.

The committed pair was SEEDED at landing from the fleet's facts cache
(`../coding-agent/verboo-facts.json`, the same listing as last fetched
2026-10-29) because this sandbox holds no `VERBOO_API_KEY` — the seeding ran
the real generate path with only the transport stubbed, so the artifacts are
exactly what a keyed regeneration of that listing produces. The first keyed
`./generate.sh` is the honest refresh.

## The fleet seam (the one open piece)

`../coding-agent/generate-pi-coding-agent.mjs` still derives the fleet's
verboo layer (model-018) from the same facts cache through its own mapper,
so two shapings of one listing exist and can drift. The join is blocked on
the same llm-reverse-proxy deployment decision as pi-synthetic's seam
(docs/d096, d100) — do not start it independently.
