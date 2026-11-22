# AGENTS.md — pi-coding-agent-provider

The folder IS the pi package and `index.mjs` is its only source file.

- Register only pi-native providers: mistral, opencode, opencode-go and
  openrouter. A new provider belongs here only when pi ships its catalog.
- Register only a provider whose key env is present AND whose baked
  `*_BASE_URL` env holds a valid URL. The config carries only `baseUrl`.
  No model data, no `refreshModels`, no fetch, no timers.
- Never throw on a bad override. Collect errors into an `AggregateError`,
  keep the original stack as each wrapper's `cause`, and notify through the
  `session_start` handler only when `ctx.hasUI` is true.
- The `PROVIDERS` tuples and the URL lookup live inside the default export,
  so each load reads the current environment.
- A copied package must stand alone: no sibling module, no `lib/`, no
  import from another unit. The provider table is local.
- `tests/` imports the entry by literal specifier and swaps env per case.
  Keep the four key-env rows pinned there.
