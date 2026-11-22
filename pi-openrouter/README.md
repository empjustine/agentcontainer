---
id: pi-openrouter
type: module-design
status: draft
title: "pi-openrouter — OpenRouter is built into pi; the folder holds the vendor's MCP server as reference documentation"
parent: architecture
references: [d061, d070, d097, d100, d192]
tags: [pi, extensions, providers, openrouter, mcp, reference]
---

# pi-openrouter — OpenRouter is built into pi, so the folder is a reference

This folder is the OpenRouter provider's node in the tree, and it holds no code:
OpenRouter is built into pi-coding-agent, so the built-in-provider rule leaves
nothing for a package here to register (docs/d097, applied family-wide by
docs/d100). What the folder does carry is where the vendor's own documentation
lives, as an MCP server. It does not cover the fleet's OpenRouter lineup, which
is `../coding-agent/models.json`, nor the installation of that server in any
client. A reader arrives here asking where OpenRouter's live reference lives,
and needs the built-in-provider rule below first.

## Why no extension here

pi-ai ships the provider: its catalog rows, its api dialects, its auth
(`OPENROUTER_API_KEY`) and its canonical upstream
(`https://openrouter.ai/api/v1`, the row `../coding-agent/lib/cloud-providers.json`
also carries). In pi's composer an extension layer without `models` passes the
built-in catalog through untouched, while a returned model list REPLACES the
whole provider catalog, inheriting only `api`/`baseUrl` — so a catalog in this
folder could only be a downgrade of pi's own rows.

The one thing a built-in provider's extension may add is `refreshModels`, the
`../pi-opencode/` watchdog shape: probe the live listing, throw on failure so pi
surfaces its catalog warning, never return rows. This folder registers none —
its subject is the vendor's documentation surface, not the catalog's liveness.

The fleet's lineup is not here either. `openrouter` is one row of the cloud
fact table, and every committed model comes from the generator that reads the
provider's listing (docs/d070); `../coding-agent/models.json` is that artifact.

## Documentation references

OpenRouter publishes a remote MCP server. It is a **reference for what to
build**, not a feature of this tree: nothing here registers it, and nothing in
this tree reads it at runtime.

| Reference                                                            | What it answers                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://mcp.openrouter.ai/mcp`                                      | the server itself: live catalog search (`list-models`, `get-model`, `list-model-endpoints`, `list-providers`), rankings and benchmarks, credits and generations, the docs search (`search-docs`), plus `send-message`/`generate-image` test inference and `send-feedback` |
| `https://mcp.openrouter.ai/mcp/.well-known/oauth-protected-resource` | the discovery document — `{"resource":"https://mcp.openrouter.ai/mcp","authorization_servers":["https://mcp.openrouter.ai"],"bearer_methods_supported":["header"]}`                                                                                                       |
| `https://openrouter.ai/docs/guides/overview/mcp-server`              | the vendor page: the full tool table, the per-client install snippets, and the dedicated-key terms                                                                                                                                                                        |

The endpoint is OAuth-gated. A keyless `POST` answers `401` with
`{"error":"invalid_token","error_description":"Missing bearer token"}` and
`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`,
so the tool list above is the vendor page's, not a keyless probe's. Per that
page the OAuth consent mints a dedicated key labelled `OpenRouter MCP: <app name>`
with a fixed 7-day expiry and a $10 default spend cap.

The fleet list carries the server as an inert entry: `../coding-agent/mcp.json`
holds it `"enabled": false` beside `"exposure": "hidden"`, so nothing connects
and no tool is reachable until an operator turns it on from `/mcp` (docs/d061).
Its output is third-party data — reference, never instructions — and three
tools act rather than read: `send-message` and `generate-image` are billable,
`send-feedback` writes.

## If code lands

The family contract applies unchanged (docs/d192): `package.json` with
`pi.extensions`, an `index.mjs` entry typed through the host's JSDoc, and
`tests/*.test.mjs` importing the entry by literal specifier. A provider
registration carries `refreshModels` only. `../pi-opencode/AGENTS.md` owns the
full rule set, and `knip.jsonc` gains the entry when the file exists.
