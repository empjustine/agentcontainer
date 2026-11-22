---
id: d235
type: architecture-design
status: active
title: "d235 — one base-URL extension for the pi-native providers"
parent: architecture
depends-on: [d097, d100, d118, d192]
references: [d061, d070, d232, d234]
tags: [pi, extensions, providers, base-url]
---

# d235 — one base-URL extension for the pi-native providers

This record replaces the three pi-native provider folders with one extension
that only forwards base-URL overrides. It covers no model data and no catalog
watchdog. Readers of the pi extension family start here for the current
provider-extension rule; d097 and d100 remain the history of the watchdogs.

## Status

Verification complete. `pi-coding-agent-provider` registers mistral,
opencode, opencode-go and openrouter; `pi-mistral/`,
`pi-opencode/` and `pi-openrouter` leave the tree.

## Decision

### One folder, four registrations

The extension table owns one fact per provider: the id and the key env from
which `*_BASE_URL` is derived. When the override is unset the registration
is empty, so pi's built-in provider is untouched. When it is set, `baseUrl`
is the only config field. opencode and opencode-go share one key env and one
override, matching the generator's fact-table rows. A malformed URL throws at
load rather than retargeting traffic to an address the operator did not choose.

| Provider    | Key env              | Override env          |
| ----------- | -------------------- | --------------------- |
| mistral     | `MISTRAL_API_KEY`    | `MISTRAL_BASE_URL`    |
| opencode    | `OPENCODE_API_KEY`   | `OPENCODE_BASE_URL`   |
| opencode-go | `OPENCODE_API_KEY`   | `OPENCODE_BASE_URL`   |
| openrouter  | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` |

### The watchdogs retire

The retired extensions probed the live listing and threw on failure so pi
showed a catalog warning. They never returned rows, so the warning said only
that a built-in catalog might be stale; the fetch, its deadline, retry interval
and per-provider error state bought nothing the host did not already have. The
new entry has no fetch, no timers, no model data and no sibling module.

### The name follows the family spelling

`pi-coding-agent-provider` uses the prevalent `pi-X-provider` spelling.
The folder is one copy unit: `package.json`, `index.mjs`,
`tests/`, `pnpm-lock.yaml` and its two docs, with no shared lib. The
MCP references from the retired folders are folded into its README; the fleet's
entries stay disabled and hidden (docs/d061).

## Consequences

- `knip.jsonc`, the README folder map, `docs/architecture.md` and the
  spec-graph folder example name the new folder. Living docs that pointed at
  `pi-opencode/` point at d100's two-registration shape or the new folder.
- Decision records keep their historical folder names. The three old spec ids
  leave the graph with their folders; no living node links to them.
- A provider added to this extension must be pi-native, or the extension must
  grow the data it does not have. That is a new decision, not a table edit.

## Verification

`node --test pi-coding-agent-provider/tests/*.test.mjs` pins the four key
envs, the empty registration and each override, including a malformed value.
`./check-types.sh`, `./lint.sh` and `./test.sh` pass.

## Alternatives rejected

- **Keeping the watchdogs.** They added a warning without improving the data,
  and each one duplicated the same fetch and interval code.
- **A shared helper across the pi folders.** d118 makes each folder a copy
  unit; a shared module would add indirection across units for four constants.
- **Keeping the old folders as reference stubs.** Three READMEs saying "moved"
  cost more to read than the one short reference section in the new folder.
