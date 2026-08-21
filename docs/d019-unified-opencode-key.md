# d019: unified OpenCode API key, no `__` key prefix

## Context

Two older credential conventions have been retired:

1. **`__` double-underscore key prefix.** To stop pi from auto-detecting a
   provider from a standard env var (`OPENROUTER_API_KEY`, …), keys were named
   with a leading `__` (e.g. `__OPENCODE_ZEN_API_KEY`) and resolved through a
   `resolveApiKeyEnv()` helper that preferred the `__` name and fell back to the
   bare name (see d001 §3/§4, d008).
2. **Split OpenCode key.** OpenCode's Zen and Go tiers used separate keys
   (`OPENCODE_ZEN_API_KEY` / `OPENCODE_GO_API_KEY`), with the Go tier gated on
   the presence of `__OPENCODE_GO_API_KEY` (see d002, d008, scoped-models).

Neither matches the current code: `gen-lib.mjs` reads plain env var names and
OpenCode's two peers (`opencode`, `opencode-go`) share a single key.

## Decision

- **No `__` prefix.** Provider keys are read as plain environment variables by
  the generators (`apiKeyEnv` in `gen-lib.mjs`), e.g. `OPENROUTER_API_KEY`,
  `OPENCODE_API_KEY`. The committed `config.d/` references them via
  `${env.OPENCODE_API_KEY}` / `${env.OPENROUTER_API_KEY}`.
- **Unified OpenCode key.** Both the Zen (`opencode`) and Go (`opencode-go`)
  peers use one `OPENCODE_API_KEY`. There is no longer a Zen/Go-split or
  `__`-prefixed OpenCode key name.

## Why this is safe

- **pi auto-detection is no longer the concern.** The provider keys live in
  `.env`, consumed server-side by llama-swap (and the native binary) to resolve
  the `${env.*}` references in `config.d/`. pi is the *client* of llama-swap and
  only needs `LLAMASWAP_API_KEY` to authenticate to llama-swap itself — it does
  not read these provider keys, so the prefix was unnecessary.
- **Credential gating is preserved.** The paid-model protections from the old
  design still hold under the unified key:
  - `opencode` keeps `requireApiKey: true` → the fetch is skipped entirely when
    `OPENCODE_API_KEY` is absent.
  - `opencode-go` keeps a model filter that drops every model when
    `OPENCODE_API_KEY` is absent (and drops `grok` unless the key is set), so no
    tier/paid models are exposed without the subscription.

## Status

Active. **Supersedes** the `__`-prefix key naming (d001 §3/§4, d008
`opencode-go-sub` gating) and the split `OPENCODE_ZEN_API_KEY` /
`OPENCODE_GO_API_KEY` (d002 `opencode-go-sub` filter, scoped-models). Those
records are retained for history but marked deprecated.
