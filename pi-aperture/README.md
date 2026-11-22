---
id: pi-aperture
type: module-design
status: active
title: "pi-aperture — Aperture is this tailnet's AI gateway, so the folder is a reference: the MCP endpoint, the vendor's documentation, and no extension"
parent: architecture
references: [d061, d100, d113, d141, d192, d227]
tags: [pi, extensions, providers, aperture, tailscale, mcp, reference]
---

# pi-aperture — Aperture is this tailnet's gateway, so the folder is a reference

This folder is the Aperture provider's node in the tree, and it holds no code.
Aperture is a gateway rather than a model vendor: it sits on a tailnet, holds the
operator's upstream credentials and connector grants, and answers two surfaces —
an OpenAI/Anthropic-compatible inference API under `/v1/…` and one aggregated MCP
endpoint at `/v1/mcp`. What this folder carries is the measurement of that MCP
endpoint without a credential, the vendor's documentation table, and the reason
no provider extension registers from here. It owns neither the gateway's own
configuration (the operator's Aperture config), nor the fleet's model lineup
(`../coding-agent/models.json`), nor the install of the MCP entry in a client
(`../coding-agent/mcp.json`).

## What a keyless probe measures

This fleet's gateway answers on the MagicDNS name
`https://ai.coelacanth-barb.ts.net`, which resolves to `100.104.60.112` inside
the tailnet. Nothing below sent a credential.

| probe                                           | result                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` without headers                    | `200`, `serverInfo` `llm-proxy v1.0.0`, protocol `2025-06-18`, tools + resources + the `io.modelcontextprotocol/skills` extension |
| `GET /.well-known/oauth-protected-resource`     | `404` — no OAuth challenge, no client registration, no token to mint                                                              |
| `tools/list`                                    | exactly one tool: `aperture_request_access`                                                                                       |
| `tools/call aperture_request_access`            | "No MCP tools are available. The user should contact their Aperture administrator to request connector access grants."            |
| `pi mcp list`                                   | `connected, 1 tool (codemode, global)`, "offers resources", exit 0                                                                |
| public DNS at `1.1.1.1`                         | `NXDOMAIN` — the name exists through MagicDNS only, so the endpoint is reachable from this tailnet and from nowhere else          |
| `GET /v1/models`                                | `200`, 444 rows, each with `supported_endpoints`, `pricing` and `quotas`                                                          |
| `POST /v1/chat/completions` (one row, 8 tokens) | `402` `{"error":{"message":"payment method required to access this Aperture-provided model","source":"aperture"}}`                |
| spoofed `Tailscale-User-Login` request header   | ignored — the one-tool list is unchanged                                                                                          |

The connect, the one fallback tool and the `402` are one mechanism.
"Without login" holds literally: the transport carries no credential, no consent
screen and no bearer token, because Aperture takes the caller from the tailnet
connection itself and then applies grants. Aperture is deny-by-default, so the same probe that connects reaches
nothing: the single `aperture_request_access` tool is the gateway's fallback for
an identity with no connector grant, and `/v1/models` lists the catalog while
inference answers `402`. Reachability and authorization are therefore separate
questions, and "keyless" answers only the first. The tool list is a property of
the caller's identity, not of the endpoint — which is why no grant-free
assertion belongs in this tree's tests: a green run could only ever observe the
fallback.

## Documentation references

The vendor's documentation is the reference for everything this folder states
above the measurement line, and two properties make it cheap to use: **any page
is served as Markdown by appending `.md`** to its URL, and
`https://tailscale.com/docs/llms.txt` is a curated index of the whole tree, one
line of summary per page. The gateway itself serves no documentation route
(`GET /docs` answers `404`, `/v1/docs` likewise): the reference is the vendor's
site.

| Reference                                                                    | What it answers                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://tailscale.com/docs/aperture`                                        | the product page: the set-up path, the gateway's parts, and links to every guide below                                                                                                                                                                                                |
| `https://tailscale.com/docs/aperture/mcp-server`                             | the MCP proxy itself: the `connectors.servers` map, name prefixing (`docs_search`, `docs-files://…`), grant FQNs and `label:` patterns, Streamable-HTTP/legacy-SSE auto-detection, the system-tool prefix, and the documented limits                                                  |
| `https://tailscale.com/docs/aperture/connectors/system-connectors`           | what the `aperture_` tools are and when they exist: session tools need an authenticated user, skill tools need a signed-in user with Chat access (tagged devices never qualify), `list_connectors` needs an HTTP connector, `web_search`/`web_fetch` the gateway's web-search service |
| `https://tailscale.com/docs/aperture/connectors`                             | the five kinds of connector (MCP, HTTP, verified, built-in, system), the six upstream auth types, and the connector catalog                                                                                                                                                           |
| `https://tailscale.com/docs/aperture/skills`                                 | the skills surface the endpoint advertises through `io.modelcontextprotocol/skills`: personal, library and built-in skills, delivered to Chat and to any agent over MCP                                                                                                               |
| `https://tailscale.com/docs/aperture/control-access` and `…/how-grants-work` | deny-by-default, allow-only additive rules, capability matching, and grant precedence — the reason a keyless probe sees one tool                                                                                                                                                      |
| `https://tailscale.com/docs/aperture/use-your-tools`                         | per-client setup, including the gateway's own `/agents` page, which generates a client configuration from the models the caller may use                                                                                                                                               |
| `https://tailscale.com/docs/aperture/cli`                                    | the Aperture CLI — its **Pi** launcher is the reason this folder registers no extension (below), and `…/connect-outside-tailnet` covers the bridge a host without Tailscale needs                                                                                                     |
| `https://tailscale.com/docs/aperture/reference/supported-providers-clients`  | Pi as a supported client, with its API formats (OpenAI Responses, Anthropic Messages, OpenAI Chat Completions, Gemini) and the gateway's provider matrix                                                                                                                              |
| `https://tailscale.com/docs/aperture/configuration`                          | the config reference the operator edits: providers, grants, connectors, guardrails, hooks                                                                                                                                                                                             |

## Why no provider extension registers here

The vendor already ships the wiring. The Aperture CLI's **Pi** entry asks for the
provider, back end and model, then **generates a temporary provider extension and
loads it with `pi -e`** — the existing Pi settings and session history stay
untouched. A package in this folder would be a second copy of that wiring, and
the catalog it would register cannot be committed: `/v1/models` answers with the
gateway's current per-identity view (444 rows here), so a copy in this tree can
only be a downgrade of what the caller already sees — the built-in-provider rule
(d097, applied family-wide by d100).

The one thing such a package could add is the `refreshModels`-only watchdog
shape (`../pi-opencode/index.mjs`): probe the live listing, never return rows. It
stays out for a measured reason. The listing exists on the tailnet only, so on a
host off the tailnet the probe dies with `getaddrinfo ENOTFOUND` and pi surfaces
a catalog warning about a provider that could never have served a request.

## The fleet MCP entry

`../coding-agent/mcp.json` carries the endpoint as `aperture`, closed:
`"enabled": false` beside `"exposure": "hidden"`, the encoding the five
provider surfaces use (docs/d061), with the static description that rule
requires. The closure is a decision rather than a safety measure — the endpoint
takes no credential, and an ungranted caller reaches only the fallback tool — so
what it buys is that no environment renders a server it cannot use: a tailnet
host would show one prompt line, and a host **off** the tailnet would show a
`failed` server (`getaddrinfo ENOTFOUND`, non-fatal per docs/d227). Opening it is
an operator step in `/mcp`, in two parts: the flag, then `exposure`, which has to
leave `hidden` before a session reaches a tool. A hidden entry renders no
`mcp_servers` line, so the description is what a host that opens it gets instead
of the server's own instructions — which is why the trust clause, the
tailnet-only limit and the docs pointer all sit in it.

## If code lands

The family contract applies unchanged (docs/d192): `package.json` with
`pi.extensions`, an `index.mjs` entry typed through the host's JSDoc, `tests/*.test.mjs`
importing the entry by literal specifier, the exact `@earendil-works/pi-coding-agent`
devDependency with its own `pnpm-lock.yaml`, and the `knip.jsonc` entry in the
same change. A provider registration carries `refreshModels` only.
`../pi-opencode/AGENTS.md` owns the full rule set.
