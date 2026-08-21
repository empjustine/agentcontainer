# d008: credential-gated provider access

## Context

Some provider `/models` endpoints return their **full catalogue** (including
paid models) even when no API key is provided. OpenCode's Zen free-tier API
is a prime example: without authentication it returns every model including
`gpt-5.5`, `claude-*`, etc. Relying solely on the client-side name-suffix
filter (`-free`) is too fragile — a model naming convention change could
expose paid models.

## Decision

### `requireApiKey` flag on the provider definition

When `requireApiKey: true` is set on a `BUILDIN_PROVIDERS` entry, the script
**skips the model fetch entirely** if no API key is present. The provider
entry is omitted from the output.

Currently applied to:
- `opencode-zen-free` — without a key the server returns ALL models including
  paid ones. With a key the server already restricts to free-tier models, so
  the client filter is just a safety net.

### `opencode-go-sub` uses a different gating approach

> **Deprecated.** `opencode-go-sub` and its `__OPENCODE_GO_API_KEY` gating are
> retired. The `opencode-go` peer now shares the unified `OPENCODE_API_KEY`
> (gated via that key). See **[d019](d019-unified-opencode-key.md)**.

The `opencode-go-sub` provider does NOT use `requireApiKey`. Instead its
`MODEL_FILTERS` entry returns `false` for every model when
`__OPENCODE_GO_API_KEY` is absent, which effectively disables the provider
without a credential. This also ensures no tier/paid models are exposed.

## Rationale

Credential gating is defense-in-depth. The client-side filter handles naming
convention changes; API-key gating handles the case where the server returns
unauthorized data. The two mechanisms together prevent accidental exposure of
paid models.
