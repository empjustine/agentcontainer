---
id: pi-acp-serve-prior-art
type: module-design
status: draft
title: "Serve ACP prior art: pi adapters, native modes and JetBrains clients"
parent: pi-acp
references: [d141, d192]
tags: [references, prior-art, acp, pi, jetbrains, zed]
---

# Serve ACP prior art: pi adapters, native modes and JetBrains clients

A **prior-art survey**, not a decision or a recommendation: the projects that expose pi-coding-agent through the Agent Client Protocol to an editor client such as Zed or a JetBrains IDE. Sources are bare mirrors under `~/Downloads/references/`, named as `<repo>:<path>` at the tips listed under [Re-verify](#re-verify). The reader needs no ACP background beyond the distinction between an ACP agent and an ACP client.

The survey answers one question. Prior art exists for serving pi over ACP, both as an external adapter and as an unfinished native CLI mode. Nothing here asserts that any adapter is production-ready or that the native attempts landed upstream.

## Trust boundary

Every claim about a mirrored project is that project's own statement read from a mirror tip. No behaviour, capability flag or conformance claim has been reproduced here. Commit hashes pin what was read; they do not imply upstream matches the pin at a later date. A mirror tip can be ahead of an installed release, so the installed tool wins wherever the two disagree.

## Verdict

| Evidence                                  | Found                                                               |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Community ACP adapters that expose pi     | Three local forks, one listed in the ACP agent registry             |
| Native `--mode acp` work in the pi mirror | Four unmerged pull-request refs, including a fork's upstream plan   |
| JetBrains ACP client evidence             | ACP client list, Mistral Vibe's IDE setup, JetBrains mirror history |
| Installed pi 1.5.2 ACP mode               | Absent; `--mode` accepts `text`, `json` and `rpc`                   |

## Community adapters

`svkozak/pi-acp` is the upstream adapter. The ACP registry page in the protocol mirror names it as the Pi entry, and `georgeharker/pi-acp` describes itself as a fork of it.

`georgeharker/pi-acp.git:README.md` states that the adapter speaks `ACP JSON-RPC 2.0 over stdio` to a client such as Zed and spawns `pi --mode rpc`. The fork adds subagents as ACP tasks, MCP auto-configuration, multi-root workspaces and v2-oriented session capabilities. Its README gives Zed `agent_servers` entries for the registry, `npx`, a global install and a source build.

`victor-software-house/pi-acp.git:README.md` takes the other shape. It embeds pi through the `@earendil-works/pi-coding-agent` SDK and gives each ACP session one in-process `AgentSession`. Its feature list includes config options, session lifecycle, usage updates, slash commands, terminal auth, resource composition, client filesystem delegation and client terminal delegation. Its docs carry ADRs for a standalone ACP server, filesystem delegation and a daemon/thin-client split.

The three adapters share the same direction: editor → ACP stdio → adapter → pi. Two reached that direction by shelling into `pi --mode rpc`; the SDK-embedded fork avoids the extra process but still implements the agent side of ACP outside pi.

## Native mode attempts in pi

The `earendil-works/pi.git` mirror carries four pull-request refs with ACP work. None is an ancestor of the mirror's `HEAD`.

| Ref              | Date       | Work                                                                                  |
| ---------------- | ---------- | ------------------------------------------------------------------------------------- |
| `refs/pull/241`  | 2025-12-19 | ACP CLI mode, dependency and conformance tests                                        |
| `refs/pull/836`  | 2026-01-19 | `--mode acp` with session loop, event mapping and slash commands                      |
| `refs/pull/895`  | 2026-01-22 | The same mode rebased with tool-title, command and error handling commits             |
| `refs/pull/6660` | 2026-07-14 | Experimental plumbing behind `PI_EXPERIMENTAL=1` plus a fork banner and upstream plan |

Commit `64e893ce4` adds `packages/coding-agent/docs/acp-upstream-plan.md`. The plan states that Pi already has headless embedding through `--mode rpc` but every editor must speak Pi's private JSONL dialect. It calls ACP the shared editor ↔ agent stdio contract and rejects another adapter as the long-term shape.

The plan's architecture is editor → `pi --mode acp` → in-process `AgentSession`. It argues for core ownership because extensions can register tools, hooks, commands and providers but cannot own process stdin/stdout framing or register a CLI run mode. It lists nine stacked upstream PRs, from plumbing and session loop through permissions, persistence, client filesystem, client terminal, MCP and docs.

The installed pi 1.5.2 reports `--mode` as `text`, `json` or `rpc`. Its package manifest carries no `@agentclientprotocol` dependency. The native-mode prior art therefore lives in unmerged refs and forks.

## JetBrains and registry evidence

`agentclientprotocol/agent-client-protocol.git:docs/get-started/agents.mdx` lists Pi through the pi-acp adapter and Mistral Vibe as available ACP agents. The same mirror's `docs/get-started/registry.mdx` carries a `pi ACP` registry card pointing at `svkozak/pi-acp`. `docs/get-started/clients.mdx` lists JetBrains among ACP clients.

`mistralai/mistral-vibe.git:docs/acp-setup.md` states that Mistral Vibe includes the `vibe-acp` tool and gives a JetBrains `acp.json` snippet with `agent_servers` and `"command": "vibe-acp"`. It also describes the AI Assistant extension route for JetBrains IDEs from 2025.3 onward.

`JetBrains/intellij-community.git` history contains Air and ACP work, including commits for a Rust fake ACP agent, an `air-ide` connection thread-leak check and an Air session that lists `execute_tool`. That is evidence of ACP-aware Air code in the JetBrains mirror; it is not a claim about a specific Air release channel.

## Gaps named by the adapters

The victor fork records the compliance limits in its README. MCP servers arrive in `session/new` but are not wired through to pi. Pi does not request permission from the ACP client before tool execution. Plan updates have no pi equivalent. The fork disables `session/delete` by default because ACP offers no confirmation surface.

The upstream plan names the same structural limits for adapters: no client filesystem or terminal delegation, no real permission path into the IDE, ignored MCP from `session/new`, dual session identity through a session-map file, and version skew between adapter and pi RPC. The plan presents native mode as the answer to those limits.

## Re-verify

Read the mirror tips from the bare repositories:

```sh
git --git-dir=~/Downloads/references/github.com/svkozak/pi-acp.git log -1
git --git-dir=~/Downloads/references/github.com/georgeharker/pi-acp.git show HEAD:README.md
git --git-dir=~/Downloads/references/github.com/victor-software-house/pi-acp.git show HEAD:README.md
git --git-dir=~/Downloads/references/github.com/earendil-works/pi.git show refs/pull/6660/head:packages/coding-agent/docs/acp-upstream-plan.md
git --git-dir=~/Downloads/references/github.com/mistralai/mistral-vibe.git show HEAD:docs/acp-setup.md
```

Tips used for this survey:

| Mirror                                      | Tip                                                     |
| ------------------------------------------- | ------------------------------------------------------- |
| `earendil-works/pi`                         | `fe8a6f5dc741e9214a20f70f359c68c72b494d1e` (2026-11-20) |
| `svkozak/pi-acp`                            | `04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905` (2026-10-05) |
| `georgeharker/pi-acp`                       | `0dec6c64eb9b8b99c165518af370cc19d607594d` (2026-11-04) |
| `victor-software-house/pi-acp`              | `0ef24b24c97ac81a5e87a17d8fd74ef97fb34d8b` (2026-06-08) |
| `agentclientprotocol/agent-client-protocol` | `f82fede8605a6a2fa99cbeb98a6d278685a5236f` (2026-11-20) |
| `mistralai/mistral-vibe`                    | `e76235b203b8965af584e88e69284bc704c31a1f` (2026-11-20) |
| `JetBrains/intellij-community`              | `9e6ae1c12feb6c7b6a29370e710476e79696fc2f` (2026-11-20) |
