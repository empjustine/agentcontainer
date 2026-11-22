---
id: archive
type: architecture-design
status: active
title: "docs/archive — research findings & retired documents (index)"
parent: architecture
tags: ["reference", "archive"]
---

# Archive — research findings & retired documents

This directory holds documents that are **not statements of current
behavior**: one-time research/audit findings, and operational docs whose
subject was retired from the live tree. They are kept because they are the
only record of an investigation, or because history references them. Deprecated decisions land here under d232; their ids and Status lines stay in the graph.

| Doc                                                                                        | What it is                                                                                                        | Status                                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [bwrap-runtime-audit.md](bwrap-runtime-audit.md)                                           | bubblewrap usage audit against upstream (does a bwrap runtime tier make sense?)                                   | `done`                                                                                |
| [comparison-with-huggingface-estimate.md](comparison-with-huggingface-estimate.md)         | our GGUF metadata parser vs gdevenyi/huggingface-estimate                                                         | `done`                                                                                |
| [endpoint-runtime-rewiring.md](endpoint-runtime-rewiring.md)                               | can pi extensions switch endpoints at runtime? (vs generation-time config)                                        | `done`                                                                                |
| [future-config-generator-system.md](future-config-generator-system.md)                     | the "simplified config-generator system" sketch                                                                   | `deprecated` — d030/d037/d041 implemented its substance                               |
| [llama-swap-response-analysis.md](llama-swap-response-analysis.md)                         | llama-swap response shape vs pi agent expectations                                                                | `done`                                                                                |
| [mini-swe-agent.md](mini-swe-agent.md)                                                     | mini-swe-agent vs pi agent-core comparison                                                                        | `done`                                                                                |
| [peer-variant-work.md](peer-variant-work.md)                                               | serving a peer variant outside the primary lineup (shelved)                                                       | `deprecated`                                                                          |
| [scoped-models-and-proxy-overrides.md](scoped-models-and-proxy-overrides.md)               | the "scoped models" workaround from the llama-swap-as-generic-proxy era, and the limits that role invented        | `deprecated` — estige took the proxy role (d027/d070); that surface is deleted (d108) |
| [model-architecture-findings.md](model-architecture-findings.md)                           | model selection numbers (context/active params/KV cache)                                                          | `done`                                                                                |
| [atuin-litestream-study.md](atuin-litestream-study.md)                                     | litestream backup + best-effort sync for atuinsh/atuin — sync v2 protocol, accounts, OCI MySQL/Oracle 19c verdict | `done`                                                                                |
| [d001-proxy-env-and-namespace.md](d001-proxy-env-and-namespace.md)                         | proxy env and baseUrl policy from the peer-provider era                                                           | `deprecated` — d232 restates the key and baseUrl law                                  |
| [d018-split-config-d.md](d018-split-config-d.md)                                           | the five-layer llama-swap config split                                                                            | `deprecated` — d232 restates the two-layer rule                                       |
| [d023-generators-dedup.md](d023-generators-dedup.md)                                       | generator code-flow audit of the pre-merge scripts                                                                | `deprecated` — d113 owns ownership, d232 the entrypoints                              |
| [d024-generators-split-and-provider-facts.md](d024-generators-split-and-provider-facts.md) | per-semantic generator split and shared fact table                                                                | `deprecated` — d232 states the current shape                                          |
| [d032-adding-a-cloud-provider.md](d032-adding-a-cloud-provider.md)                         | adding InferX to the retired generator pipeline                                                                   | `deprecated` — d232 restates the provider contract                                    |
| [d037-generator-merge-verdict.md](d037-generator-merge-verdict.md)                         | narrow-merge verdict, later reversed by the by-agent merge                                                        | `deprecated` — d232 states the broad merge                                            |
| [d039-fold-single-consumer-lib-modules.md](d039-fold-single-consumer-lib-modules.md)       | fold single-consumer lib modules back into runners                                                                | `deprecated` — d113 replaced the shared lib                                           |
| [d041-unified-generate-build-entrypoints.md](d041-unified-generate-build-entrypoints.md)   | root generate/build orchestration and entrypoint split                                                            | `deprecated` — d232 states the per-unit boundary                                      |
| [d073-ssl-vpn-three-modes.md](d073-ssl-vpn-three-modes.md)                                 | the original three-mode tunnel requirements                                                                       | `deprecated` — d188 carries the tunnel contract                                       |

## Reading notes

- **Links inside these documents point at the pre-archive layout** (they were
  written when these files lived at `docs/` root). Resolve a broken relative
  link one directory up. The bodies are records and are not edited to chase
  their own links.
- A decision record that cites a retired document's **live** path (for example
  `coding-agent/scoped-models-and-proxy-overrides.md`) is recording where it sat
  at the time; the document it names is found here.
- "This was an investigation" is carried by the location and by
  `status: done`, not by a type of its own: each doc is typed
  `architecture-design` or `module-design` by scope, per
  `docs/spec-graph-standard.md`. Superseded docs are marked
  `status: deprecated` with the supersession recorded in a banner.
- Research/audit docs that `docs/d0XX-*.md` decision records reference **by
  path** could not move here (history must stay linkable): see
  `docs/termux-build-audit.md`, `docs/sandbox-helper-env-analysis.md`, and
  `docs/termux-serving.md` (archived in place) — same genre, anchored
  location.
