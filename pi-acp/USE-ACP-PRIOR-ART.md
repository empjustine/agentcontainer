---
id: pi-acp-use-prior-art
type: module-design
status: draft
title: "Use ACP prior art: pi as an ACP client of another coding agent"
parent: pi-acp
references: [d100, d192]
tags: [references, prior-art, acp, pi, mistral-vibe]
---

# Use ACP prior art: pi as an ACP client of another coding agent

A **prior-art survey**, not a design or a recommendation: the projects and specs that let one coding agent drive another over the Agent Client Protocol, read as a possible route from pi to `vibe-acp`. Sources are bare mirrors under `~/Downloads/references/`, named as `<repo>:<path>` at the tips listed under [Re-verify](#re-verify). The reader needs the distinction between an ACP Agent, which answers prompts, and an ACP Client, which sends them.

The survey finds protocol precedent and external bridges, but no local implementation that makes pi an ACP client. The API and caching motivation for preferring Mistral Vibe's own CLI is not addressed by any surveyed source. Nothing here asserts that an ACP bridge would preserve pi's provider caching or billing behaviour.

## Trust boundary

Every claim about a mirrored project is that project's own statement read from a mirror tip. No behaviour, capability flag or conformance claim has been reproduced. Commit hashes pin what was read; they do not imply upstream matches the pin at a later date. A mirror tip can be ahead of an installed release, so the installed tool wins wherever the two disagree.

## Verdict

| Question                                                    | Finding                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Does ACP allow an agent to be a client?                     | Yes; the protocol mirror states it and defines child sessions                    |
| Do bridges wrap ACP agents as tools or providers?           | Yes; `@mcpc/acp-ai-provider` and `@mastra/acp` are listed in the ACP client docs |
| Does the local mirror contain a pi ACP client?              | No ACP client code in the pi mirror or installed pi                              |
| Does the surveyed Mistral Vibe mirror expose a client mode? | No; `vibe-acp` is the documented ACP agent surface                               |

## Protocol precedent

`agentclientprotocol/agent-client-protocol.git:docs/get-started/related-protocols.mdx` states: "The Client doesn't have to be an editor. An agent can act as an ACP Client to run other coding agents as sub-agents."

`docs/protocol/v1/subagents.mdx` in the same mirror defines child sessions. An Agent creates and owns a child session with its own `sessionId`. Child messages, thoughts, plans and tool calls arrive as ordinary `session/update` notifications carrying the child id. The Client advertises support through a `subagents` capability, and the Agent must not send child updates without it.

`agentclientprotocol/typescript-sdk.git` carries both sides of the wire: `src/examples/agent.ts`, `src/examples/client.ts` and the `src/v1/stable/acp.ts` bindings. The SDK is the concrete library a pi extension would reach for if this direction were built.

## Bridges listed by ACP

The protocol mirror's `docs/get-started/clients.mdx` lists `@mcpc/acp-ai-provider` as the power behind an AI SDK web example. It lists `@mastra/acp` as a package for wrapping external ACP agents as tools or subagents. The same page lists CLI clients such as `acpx` and orchestrators that launch ACP agents from a task graph.

Those repositories are not in the local mirror set. Their presence in the ACP docs establishes precedent only; no claim here describes their internals.

## Pi-side hooks

The installed pi 1.5.2 has no ACP dependency and no ACP mode. Its extension API offers other seams:

- The installed `docs/custom-provider.md` documents `pi.registerProvider()` for custom streaming, discovery and authentication. A provider extension runs inside pi and can spawn a managed process.
- `mitsuhiko/pi-llamacpp.git` is the local example of that shape. Its README describes a provider extension that registers models, manages a `llama-server` subprocess and stops it on pi shutdown. The extension's `index.mjs` is the only source file apart from its watchdog script.
- pi's extension examples include a `subagent/` pattern built from `registerTool` and `exec`, cited in the installed `docs/extensions.md`. That is a pi-to-pi delegation seam, not ACP.
- `pi --mode rpc` is pi's own headless surface. Adapters use it in the serve direction; it does not make pi an ACP client.

A client implementation would need an ACP transport owner. The native-mode plan in `earendil-works/pi.git` records the repo's own reason for keeping stdio framing in core: extensions can register tools, hooks, commands and providers but cannot own process stdin/stdout framing or register a CLI run mode. A pi extension can still spawn a child process and register a tool or provider; the trade is that pi never becomes an ACP Client to other software.

## Mistral Vibe surface

`mistralai/mistral-vibe.git:docs/acp-setup.md` presents `vibe-acp` as the tool used from editors and IDEs. The mirror's `AGENTS.md` says `vibe/acp` bridges to the Agent Client Protocol, while the TUI, app server and setup packages are the other surfaces. The documented flow is client → `vibe-acp` → Vibe app server.

No file in the surveyed Vibe mirror turns that around and lets Vibe act as an ACP client of another agent. The proxy document states that proxy settings are shared between CLI and ACP, which is evidence of two delivery surfaces, not of a client mode.

## Unanswered by this survey

The motivating problem — API and caching issues when Mistral Vibe runs through pi-coding-agent — has no source in these mirrors. No surveyed project claims that ACP fixes provider caching, token accounting or billing. The survey reads capability descriptions and docs; it does not run `vibe-acp` against pi or measure a cache.

## Re-verify

Read the mirror tips from the bare repositories:

```sh
git --git-dir=~/Downloads/references/github.com/agentclientprotocol/agent-client-protocol.git show HEAD:docs/get-started/related-protocols.mdx
git --git-dir=~/Downloads/references/github.com/agentclientprotocol/agent-client-protocol.git show HEAD:docs/protocol/v1/subagents.mdx
git --git-dir=~/Downloads/references/github.com/agentclientprotocol/agent-client-protocol.git show HEAD:docs/get-started/clients.mdx
git --git-dir=~/Downloads/references/github.com/agentclientprotocol/typescript-sdk.git ls-tree -r --name-only HEAD | grep '^src/examples/'
git --git-dir=~/Downloads/references/github.com/mistralai/mistral-vibe.git show HEAD:docs/acp-setup.md
git --git-dir=~/Downloads/references/github.com/mitsuhiko/pi-llamacpp.git show HEAD:README.md
pi --help | grep -i -- '--mode'
```

Tips used for this survey:

| Mirror                                      | Tip                                                     |
| ------------------------------------------- | ------------------------------------------------------- |
| `agentclientprotocol/agent-client-protocol` | `f82fede8605a6a2fa99cbeb98a6d278685a5236f` (2026-11-20) |
| `agentclientprotocol/typescript-sdk`        | `1db9118228d8a04abde1773b1d7a2f483aba2e5d` (2026-11-20) |
| `mistralai/mistral-vibe`                    | `e76235b203b8965af584e88e69284bc704c31a1f` (2026-11-20) |
| `mitsuhiko/pi-llamacpp`                     | `66e4441770ae42cec548fee00e2ec9df179b4134` (2026-05-11) |
| `earendil-works/pi`                         | `fe8a6f5dc741e9214a20f70f359c68c72b494d1e` (2026-11-20) |
