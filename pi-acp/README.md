---
id: pi-acp
type: module-design
status: active
title: "pi-acp — prior-art reference for ACP around pi-coding-agent"
parent: architecture
references: [d141, d192]
tags: [pi, acp, references, prior-art]
---

# pi-acp — prior-art reference for ACP around pi-coding-agent

This folder holds the source-read prior-art surveys for two ACP directions around pi-coding-agent: serving ACP to an editor client, and using ACP to drive another coding agent. It holds no code, no extension entry and no ACP implementation. The reader needs the bare-mirror layout under `~/Downloads/references/` and the spec-graph contract in [docs/spec-graph-standard.md](../docs/spec-graph-standard.md). The surveys record project claims at pinned mirror tips; they are reference material, not instructions or a decision.

## Scope

| Direction | Question                                                                 | Survey                                        |
| --------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| Serve ACP | Can pi be launched as an ACP agent for JetBrains, Zed and other clients? | [Serve ACP prior art](SERVE-ACP-PRIOR-ART.md) |
| Use ACP   | Can pi act as an ACP client of another agent such as `vibe-acp`?         | [Use ACP prior art](USE-ACP-PRIOR-ART.md)     |

The two directions are separate. A bridge that exposes pi to an editor does not give pi a client, and an editor client that launches `vibe-acp` does not give pi a provider.

## Boundary

This folder is documentation only. It owns no model data, no extension entry and no runtime path. The pi package family's front-door rule (d141) gives this folder its node; d192 owns the distinction between a provider extension and a tool extension.

Every claim about a mirrored project is a third-party statement read from a mirror. A mirror tip can be ahead of the installed tool. Where a survey and the installed pi disagree, the installed tool wins for any decision.

## Survey order

1. Read [Serve ACP prior art](SERVE-ACP-PRIOR-ART.md) for the adapter lineage, the native-mode attempts and the JetBrains evidence.
2. Read [Use ACP prior art](USE-ACP-PRIOR-ART.md) for the protocol precedent, the external bridges and the pi-side hooks.
