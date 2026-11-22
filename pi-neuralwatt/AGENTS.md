# AGENTS.md — pi-neuralwatt

Folder-local rules. Repo-wide rules are in `../AGENTS.md`, the standalone rule in
`../docs/architecture.md`, and the design record in `README.md`. What follows is
only what is specific here.

## The folder is the package, and it registers TWO providers

`pi install ./pi-neuralwatt -l`, a copy into
`~/.pi/agent/extensions/pi-neuralwatt/`, or `pi -e ./pi-neuralwatt/index.mjs`.
One entry registers `neuralwatt-flex` and `neuralwatt-standard` (docs/d100's
two-registration shape in docs/d100) because they share the key
env, the listing and the shaping, and differ only in the tier they request.

## One source of truth, and it is the provider

- **`/v1/models` is the only input.** No models.dev slice, no fact cache, no
  committed lineup — an extension that registers a list outlives the catalog it
  described (docs/d190/d191).
- **A failed read throws.** pi records the provider in
  `ModelsRefreshResult.errors`; a returned `[]` would replace the catalog with
  nothing, and a remembered list would claim what nobody verified (docs/d192).
- **Never publish a row the provider says is not chat.** `metadata.capabilities.task`
  present, `deprecated`, or `pricing_tbd` rows are dropped in `merge.mjs` before
  any shaping, because pi's chat arm cannot serve them (the docs: a `task` row
  rejects `/v1/chat/completions` with a 400) and pi's `cost` block needs real
  numbers.
- **Tier suffixes are dropped, and the list is policy.** `-flex` is derivable
  (the twin's `pricing.service_tier`); `-speed` and `-fast` are not, so their
  comment in `merge.mjs` carries the reason. They are the only remembered
  strings in the folder; do not add a third without one.
- **Flex capability and flex price come from the twin row**, never from an
  assumption and never from `flex_discount_multiplier` arithmetic.

## The tier is a request field, not a model name

Both lineups publish the **standard** id; the flex provider adds
`samplingParams: { service_tier: "flex" }`. That keeps the wire model name —
and the server-side prefix cache — stable across a tier switch, and keeps the
suffix out of the picker. Do not switch the flex lineup to `-flex` ids: it would
surface the tier in every name for nothing.

## Aliases are how legacy picks stay working

`thinkingLevelMap` resolves every pi level through `effort_aliases` over
`accepted_efforts`, so a pick like `high` on a model with fewer distinct levels
lands on the served one. Identity-over-`supported_efforts` (what both community
plugins do) is rejected here; do not "simplify" it back.

The one request-shaping table (`compat.mjs`) is keyed by
`metadata.huggingface_id`, because the `nw-*` rows are tracking aliases that
move. Keying it by id would apply one family's kwarg to the next model the alias
points at.

## Open items are decisions, not TODOs

`README.md`'s open-items list holds the fields left unset on purpose
(`requiresNonNullAssistantContent`, `supportsStore`,
`supportsLongCacheRetention`, `thinking_token_budget`, `scope`, the host
version pin). Do not flip one because a plugin does; each needs its evidence
(a keyed probe, or a host-version decision) and the README updated with it.

## Nothing is committed

No lineup, no artifact, no seed: `generate` is a stub that prints its own name,
`freshness.sh` skips the unit, and `tests/` builds its own records. A stub rather
than a deleted script keeps the unit's entrypoint table whole (docs/d113).
