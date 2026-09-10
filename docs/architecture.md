---
id: architecture
type: architecture-design
status: draft
title: "Architecture: self-contained runners + base config generators"
parent: goal
tags: ["topology", "standalone-rule", "generators"]
---

# Architecture: self-contained runners + base config generators

This repo is a set of small, self-contained mini-projects. Each lives in its
own folder and must be copyable onto a host in isolation. This page documents
the split and the one rule that lets some folders reuse others.

## Functional split

| Side | Responsibility | Instance |
|------|----------------|----------|
| **serving** | run llama-swap (`llm-reverse-proxy*`) | `llm-reverse-proxy/` (multipurpose: local GGUF + peers, capability-gated) |
| **usage** | run the pi coding-agent (`coding-agent*`) | `coding-agent/` |

The serving folder is a **single multipurpose llama-swap instance**: it runs
local llama.cpp GGUF models on GPU-capable container hosts and proxies cloud
providers everywhere; `generate.sh` decides per host which `config.d/` layers
apply (and removes stale ones). The old fixed-purpose split
(`openai-completions-gfx1030/` + `openai-completions-peer/`) and the
`coding-agent-peer/` usage variant were retired — the
capability-gated generation pattern (pioneered by `coding-agent/`) made the
variant folders redundant.

## Standalone rule (self-contained runners)

Every serving/usage folder is **self-contained**: it carries its own copy of any
shared generator/helper it needs, so it never imports from a sibling runner or
from `local-llm/`. The one exception is the repo-level `lib/` kernel (below):
the effective copy unit is **folder + `../lib`**, not the folder alone — the
folders already hard-depend on `lib/log.sh`, `lib/log.mjs` and
`lib/workload-runtime.sh`, and since docs/d023 also on `lib/peer-probe.mjs`,
`lib/refresh-models-dev.mjs` and the shared `lib/models.dev.api.json` catalog
(since docs/d024 additionally on `lib/cloud-providers.mjs`, the shared cloud
provider fact table, and `lib/pi-models.mjs`, the pi model/provider shaping).
Shared **data** tables live in `lib/` too: `models.dev.api.json` (model-id
source of truth for the catalog-driven providers) and `llamacpp-model-data.json`
(canonical GGUF model definitions, read by the serving generator and by the
`local-llm/` cache tooling — moved to lib to mark it explicitly shared;
docs/d025). Data reads out of `lib/` do not violate the standalone rule; only
reaching into a sibling *runner* folder does.

- `llm-reverse-proxy/` is the **multipurpose serving instance**: it owns the
  local-llm generator (`generate-local-llm-models.yaml.mjs` +
  `active-b.json` → `config.d/10-local-llm-inference.yaml`, emitted only on
  GPU-capable container hosts; the model data itself is the shared
  `lib/llamacpp-model-data.json`), the `generate-general.yaml.mjs`
  globals/macros, the peer
  generators (`generate-peer-cloud.yaml.mjs`, `generate-gfx1030-models.mjs`),
  `gen-lib.mjs`, `launch-gguf.sh`, `llama-swap-core.json`, `config.d/`,
  `run.sh` and the Termux alternative build/serve (`build.sh` /
  `run-native.sh`).
- `coding-agent/` is the **pi workload baseline generator**: it owns the
  `Containerfile`/`config.toml` image definition and the canonical
  `settings.json`/`auth.json`. Archived runners (`-cloud`, `-peer`) used to
  consume that image and copy those artifacts; their concerns are now handled
  by layered generation inside `coding-agent/` itself.

Retired variant runners and scrapped tooling are **not kept in the worktree**:
they live only in the external archive (the github mirror). Docs record the
retirement and the decisions behind it, but never point at worktree paths that
don't exist.

Non-base folders must not reach into each other. Examples of what this rule
prohibits (and what was removed):

- `openai-completions-peer/` importing `modelArgs` from `../local-llm/...` — the
  helper is now inlined in its generator. `local-llm/` is cache tooling, not a
  base generator.
- `openai-completions-arm5/build.sh` searching `../openai-completions-peer/
  `.env` and `../openai-completions-gfx1030/.env` for keys (removed before the
  whole arm5/ MikroTik folder was retired) —
  each runner uses only its own `.env`.

## Repo-level shared infrastructure

`lib/` (repo root) is **shared infrastructure**, not a sub-project. It carries:

- `workload-runtime.sh` — container-runtime detection (podman vs docker,
  UID/SELinux flags), the declarative workload description API, structured
  shell logging, the shared `load_secrets` vault loader, and the
  profile/runner helpers the generate.sh scripts reuse (`_termux`,
  `node_run`, `default_run_dir`).
- `log.sh` / `log.mjs` / `log.py` — the structured loggers (per language).
- `peer-probe.mjs` — the shared HTTP probe toolkit for the `.mjs` generators
  (fetch, reachability classification, candidate cascade; docs/d023) plus the
  `DEFAULT_PEER_FALLBACK` peer candidate constant (docs/d024).
- `cloud-providers.mjs` — the one cloud-provider fact table (id / label /
  key env / real base URL) every generator family derives from (docs/d024).
- `pi-models.mjs` — the RawModelEntry → pi model/provider shaping shared by
  the pi-layer generators (docs/d024).
- `refresh-models-dev.mjs` — the one models.dev catalog refresher used by both
  `generate.sh` scripts (docs/d023).
- `models.dev.api.json` — the single vendored models.dev catalog shared by
  both generator families (docs/d023).
- `workload-*.jq` — the jq filters behind the workload description API.

Runner run-scripts source lib modules from the fixed `~/agentcontainer` layout.
lib is intentionally NOT copied into each runner — it is owned by the repo, like
`AGENTS.md` and `biome.json`.

## Local vs peers (the two layers, one instance)

**Local llama.cpp (GGUF) model support lives only in the local layer of
`llm-reverse-proxy/`** — `config.d/10-local-llm-inference.yaml`, generated by
`generate-local-llm-models.yaml.mjs` from `llamacpp-model-data.json`, and only
on hosts where `generate.sh` detects a container backend + GPU devices. Every
other config layer is concern-split:

| Layer | Role | Generated by | When |
|-------|------|--------------|------|
| `00-general.yaml` | globals + macros | `generate-general.yaml.mjs` | always |
| `10-local-llm-inference.yaml` + `launch-gguf.sh` | local GGUF `models` | `generate-local-llm-models.yaml.mjs` (from the shared `lib/llamacpp-model-data.json`) | container backend + GPU detected |
| `peer-cloud.yaml` | cloud peers | `generate-peer-cloud.yaml.mjs` | when any provider answers |
| `22-peer-gfx1030.yaml` | route to a remote local-inference instance | `generate-gfx1030-models.mjs` | non-GPU hosts only |

(The old fixed-purpose `openai-completions-gfx1030/` / `openai-completions-peer/`
folders and the `coding-agent-cloud/`/`coding-agent-peer/` usage runners are
retired — the capability-gated layered generation pattern made
the variant folders redundant.)

| Folder | Role | What makes it work |
|--------|------|--------------------|
| `llm-reverse-proxy/` | multipurpose serving (local GGUF where capable, peers everywhere) | `gen-lib.mjs`, `generate-general.yaml.mjs`, `generate-local-llm-models.yaml.mjs` + `active-b.json`, `generate-peer-cloud.yaml.mjs`, `generate-gfx1030-models.mjs`, `launch-gguf.sh`, `llama-swap-core.json`, `config.d/` + `run.sh`, `build.sh` (termux-native build or image pull) + `run-native.sh` (Termux) |
| `coding-agent/` | base pi workload image + artifacts | `Containerfile`, `config.toml`, `build.sh`, `run.sh`, `settings.json`, `auth.json` |

The next planned step — a simplified config-generator system split by concern —
is sketched in
[future-config-generator-system.md](future-config-generator-system.md).
