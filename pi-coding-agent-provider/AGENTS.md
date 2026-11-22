# AGENTS.md — pi-coding-agent-provider

The folder IS the pi package and `index.mjs` is its only source file.

- Register only pi-native providers: mistral, opencode, opencode-go and
  openrouter. A new provider belongs here only when pi ships its catalog.
- The sole config field is `baseUrl`, set from the key env's derived
  `*_BASE_URL`. No model data, no `refreshModels`, no fetch, no timers.
- A copied package must stand alone: no sibling module, no `lib/`, no
  import from another unit. The key-env table is local.
- `tests/` imports the entry by literal specifier and swaps env per case.
  Keep the four key-env rows pinned there.
