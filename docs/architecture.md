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
| **serving** | run llama-swap (`llm-local-inference*`, LOCAL GGUF only) and llm-reverse-proxy (`llm-reverse-proxy/`, cloud relay) | `llm-local-inference/` (local layer, capability-gated) + `llm-reverse-proxy/` (path-prefix cloud router, docs/d027) |
| **usage** | run the pi coding-agent (`coding-agent*`) | `coding-agent/` |

The serving side is split by concern (docs/d027): llama-swap
(`llm-local-inference/`) is a **single local-GGUF instance** on GPU-capable
container hosts — there is no peers-only llama-swap mode — while cloud
provider relay is `llm-reverse-proxy/` (the path-prefix cloud router),
deployable wherever the cloud is reachable. The old fixed-purpose split
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

- `llm-local-inference/` is the **local GGUF serving instance** (local
  inference only): it owns the local-llm generator
  (`generate-local-llm-models.yaml.mjs` + `active-b.json` →
  `config.d/10-local-llm-inference.yaml`, emitted only on GPU-capable
  container hosts; the model data itself is the shared
  `lib/llamacpp-model-data.json`), the `generate-general.yaml.mjs`
  globals/macros, `gen-lib.mjs`, `launch-gguf.sh`, `llama-swap-core.json`,
  `config.d/`, `run.sh` and the container-image `build.sh`. Cloud/remote peer
  relaying is NOT here — it moved to `llm-reverse-proxy/` (the raw passthrough
  proxy); the peer generators, Termux build/serve, and peers-only mode were
  removed with that handoff.
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
  shell logging, and the
  profile/runner helpers the generate.sh scripts reuse (`_termux`,
  `node_run`, `default_run_dir`).  Secrets are NOT part of it: loading is
  the explicit `lib/environment.sh` chain (below).
- `environment.sh` — THE environment loader: one in-memory infisical
  round-trip, then `exec` of the named script
  (`./lib/environment.sh ./coding-agent/run.sh`).  Consumers read plain env
  and never load secrets themselves; a failed/empty vault is fatal here.
- `log.sh` / `log.mjs` / `log.py` — the structured loggers (per language).
- `peer-probe.mjs` — the shared HTTP probe toolkit for the `.mjs` generators
  (fetch, reachability classification, candidate cascade; docs/d023) plus the
  vault-sourced peer base accessor `peerBaseUrl()` (docs/d024, d028).
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

## Local vs cloud (two modules, two instances)

**Local llama.cpp (GGUF) model support lives only in `llm-local-inference/`** —
`config.d/10-local-llm-inference.yaml`, generated by
`generate-local-llm-models.yaml.mjs` from `llamacpp-model-data.json`, and only
on hosts where `generate.sh` detects a container backend + GPU devices.
`config.d/` carries exactly two layers:

| Layer | Role | Generated by | When |
|-------|------|--------------|------|
| `00-general.yaml` | globals + macros | `generate-general.yaml.mjs` | always |
| `10-local-llm-inference.yaml` + `launch-gguf.sh` | local GGUF `models` | `generate-local-llm-models.yaml.mjs` (from the shared `lib/llamacpp-model-data.json`) | container backend + GPU detected |

Cloud/remote peers are NOT a config layer anymore: `llm-reverse-proxy/` (raw
passthrough proxy) serves them. The former `peer-cloud.yaml` and
`22-peer-gfx1030.yaml` layers — and the peer-set snapshot/rollback machinery
they required — were removed with that handoff.

(The old fixed-purpose `openai-completions-gfx1030/` / `openai-completions-peer/`
folders and the `coding-agent-cloud/`/`coding-agent-peer/` usage runners are
retired — the capability-gated layered generation pattern made
the variant folders redundant.)

| Folder | Role | What makes it work |
|--------|------|--------------------|
| `llm-local-inference/` | local GGUF serving only (GPU container hosts; hard-fails elsewhere) | `gen-lib.mjs`, `generate-general.yaml.mjs`, `generate-local-llm-models.yaml.mjs` + `active-b.json`, `launch-gguf.sh`, `llama-swap-core.json`, `config.d/` + `run.sh`, `build.sh` (image pull) |
| `llm-reverse-proxy/` | path-prefix cloud router for cloud/remote providers (`/<providerId>` → provider's full real base URL, byte-for-byte, no keys — docs/d027; streaming as-is, RFC 9457 502s) | `main.go`, `generate.sh` → `generate-config.mjs` (routing table from lib/cloud-providers.mjs), `llm-reverse-proxy.example.json`, `build.sh`, `smoke-test.sh` |
| `coding-agent/` | base pi workload image + artifacts | `Containerfile`, `config.toml`, `build.sh`, `run.sh`, `settings.json`, `auth.json` |

The next planned step — a simplified config-generator system split by concern —
is sketched in
[future-config-generator-system.md](future-config-generator-system.md).
