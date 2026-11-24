# AGENTS.md — pi-verboo-provider

Folder-local rules. Repo-wide rules are in `../AGENTS.md`; the standalone rule
is in `../docs/architecture.md`. What follows is only
what is specific here. The folder contract is `../pi-synthetic-provider/AGENTS.md`'s,
applied to this provider (docs/d096/d100) — read that one first; only the
verboo-specific deltas are below.

## One source of truth, and it is the provider

- **The `/models` listing is the only input** — and the only one that CAN
  be: models.dev carries no verboo row at all (the fleet's catalogOptional
  case, docs/d057), so there is no second catalog to fall back to even in
  principle.
- **The listing is AUTH-GATED**: reading it needs `VERBOO_API_KEY`. A failure
  throws with no committed copy behind it — the provider is unconfigured for
  that run (docs/d190).
- **No price is ever asserted.** The listing publishes none, so the extension
  fills the mandatory zeros (docs/d057). Inventing a price would be a vendor
  fact nobody published.
- **No `maxTokens` is asserted**: likewise unpublished; pi's schema default
  (16384) is the conservative cap, and the extension carries that same default
  explicitly (its shape takes the field as given).
- **No off-state fallback for thinking**: only a published "none" disables
  thinking (fleet `onOffThinking: false`). A model whose enum lacks it
  simply offers no off state — never an invented wire value.

## Nothing is committed

No lineup, no fallback, no manifest. `refreshModels` reads the provider's
`/models` listing on every run (docs/d190), and `generate` is a stub that prints
its own name — so there is no
artifact to hand-edit, no `--check` drift gate, and no generated file in
`biome.jsonc`'s ignore list. A stub rather than a deleted script keeps the
unit's entrypoint table whole (docs/d113).

The extension registers no lineup of its own (docs/d190): `refreshModels` is
the only source.

The committed artifact was SEEDED at landing from the fleet's last fetch of
the same listing because this sandbox holds no `VERBOO_API_KEY` — the seeding
ran the real generate path with only the transport stubbed. The fleet keeps no
copy of it any more (docs/d191), so this artifact is the only record of what
that fetch answered; the first keyed `./npm-run.sh pi-verboo-provider generate` is the
honest refresh.

## The fleet seam (the one open piece)

`../coding-agent/generate-pi-coding-agent.mjs` still derives the fleet's
verboo layer (model-018) from the same listing through its own mapper,
so two shapings of one listing exist and can drift. The join is blocked on
the same estige deployment decision as pi-synthetic-provider's seam
(docs/d096, d100) — do not start it independently.
