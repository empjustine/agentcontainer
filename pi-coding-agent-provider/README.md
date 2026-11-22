---
id: pi-coding-agent-provider
type: module-design
status: active
title: "pi-coding-agent-provider — one base-URL override for the providers pi builds in"
parent: architecture
depends-on: [d097, d100, d235]
references: [d070, d118, d192]
tags: [pi, extensions, providers, base-url]
---

# pi-coding-agent-provider — one override, four providers

This is the pi extension for the providers pi-coding-agent already ships:
mistral, opencode, opencode-go and openrouter. It registers a provider only when
its key env is present and its `*_BASE_URL` override is set; the config then
carries just that `baseUrl`. It covers no model data, no fetches and no
catalog watchdog (docs/d235). A reader arriving from `pi-mistral` or
`pi-opencode` finds their behavior here.

| Provider    | Key env              | Override env          |
| ----------- | -------------------- | --------------------- |
| mistral     | `MISTRAL_API_KEY`    | `MISTRAL_BASE_URL`    |
| opencode    | `OPENCODE_API_KEY`   | `OPENCODE_BASE_URL`   |
| opencode-go | `OPENCODE_API_KEY`   | `OPENCODE_BASE_URL`   |
| openrouter  | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` |

The two opencode surfaces share a key env, so one override retargets both, as
in the generator's fact-table rows. A value must be an absolute http(s) URL;
trailing slashes are trimmed. Malformed values are collected into an
`AggregateError` and reported with pi's session-start notification; a bad
override never stops the other providers from registering.

## Why nothing else

pi-ai carries each catalog, wire dialect and auth. In pi's composer an
extension layer without `models` passes the built-in catalog through
untouched, while a returned list REPLACES it. The retired watchdogs only
reported an unreachable listing and never improved that data; their fetch,
timers and per-provider error state are gone (docs/d235).

## Layout

The folder itself is the pi package: `package.json` carries
`pi.extensions`, `index.mjs` is the entry, `tests/` imports it
by literal specifier, and `pnpm-lock.yaml` pins the host types (docs/d192).
No `lib/`, no generated artifact and no sibling module. Install with
`pi install ./pi-coding-agent-provider -l` or load with
`pi -e ./pi-coding-agent-provider/index.mjs`.

## Documentation references

The vendor MCP servers named by the retired folders remain reference only:
`https://api.mistral.ai/mcp` (key-gated; can redeploy or delete workspace
objects), `https://opencode.ai/console/mcp`, and
`https://mcp.openrouter.ai/mcp` (OAuth-gated). The fleet entries in
`../coding-agent/mcp.json` stay disabled and hidden (docs/d061).
