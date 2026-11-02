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
only record of an investigation, or because history references them.

| Doc | What it is | Status |
|-----|-----------|--------|
| [bwrap-runtime-audit.md](bwrap-runtime-audit.md) | bubblewrap usage audit against upstream (does a bwrap runtime tier make sense?) | `done` |
| [comparison-with-huggingface-estimate.md](comparison-with-huggingface-estimate.md) | our GGUF metadata parser vs gdevenyi/huggingface-estimate | `done` |
| [endpoint-runtime-rewiring.md](endpoint-runtime-rewiring.md) | can pi extensions switch endpoints at runtime? (vs generation-time config) | `done` |
| [future-config-generator-system.md](future-config-generator-system.md) | the "simplified config-generator system" sketch | `deprecated` — d030/d037/d041 implemented its substance |
| [llama-swap-response-analysis.md](llama-swap-response-analysis.md) | llama-swap response shape vs pi agent expectations | `done` |
| [mini-swe-agent.md](mini-swe-agent.md) | mini-swe-agent vs pi agent-core comparison | `done` |
| [peer-variant-work.md](peer-variant-work.md) | serving a peer variant outside the primary lineup (shelved) | `deprecated` |
| [model-architecture-findings.md](model-architecture-findings.md) | model selection numbers (context/active params/KV cache) | `done` |
| [atuin-litestream-study.md](atuin-litestream-study.md) | litestream backup + best-effort sync for atuinsh/atuin — sync v2 protocol, accounts, OCI MySQL/Oracle 19c verdict | `done` |

## Reading notes

- **Links inside these documents point at the pre-archive layout** (they were
  written when these files lived at `docs/` root). Resolve a broken relative
  link one directory up. The bodies are records and are not edited to chase
  their own links.
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
