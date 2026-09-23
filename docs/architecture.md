---
id: architecture
type: reference
status: accepted
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
folders already hard-depend on `lib/log.sh`, `lib/log.mjs`,
`lib/workload-runtime.sh`, `lib/node-run.sh` (docs/d041) and, since
docs/d024, on `lib/cloud-providers.mjs`, the shared cloud provider fact
table. Shared **data** tables live in `lib/` too: `models.dev.api.json`
(model-id source of truth for the catalog-driven providers),
`catwalk-facts.json` (secondary catalog fallback) and `llamacpp-model-data.json`
(canonical GGUF model definitions, read by the serving generator and by the
`local-llm/` cache tooling — moved to lib to mark it explicitly shared;
docs/d025). Data reads out of `lib/` do not violate the standalone rule; only
reaching into a sibling *runner* folder does.

- `llm-local-inference/` is the **local GGUF serving instance** (local
  inference only): it owns the local-llm generator — since docs/d041 the
  whole generator (former `gen-lib.mjs`, `generate-general.yaml.mjs`,
  `generate-local-llm-models.yaml.mjs`) is folded into one
  `generate.mjs` (`active-b.json` + `lib/llamacpp-model-data.json` →
  `config.d/00-general.yaml` + `config.d/10-local-llm-inference.yaml` + its
  `.paths` staleness manifest, emitted only on GPU-capable container hosts;
  snapshot paths are baked at generation — `docs/d029` option B), plus
  `llama-swap-core.json`, `config.d/` and `run.sh`. Cloud/remote peer
  relaying is NOT here — it moved to `llm-reverse-proxy/` (the raw passthrough
  proxy); the peer generators, Termux build/serve, and peers-only mode were
  removed with that handoff.
- `coding-agent/` is the **pi workload baseline generator**: it owns the
  `Containerfile`/`config.toml` image definition and the canonical
  `settings.json`. Archived runners (`-cloud`, `-peer`) used to
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
  shell logging, and the profile/runner helpers the run scripts reuse
  (`_termux`, `default_run_dir`).  Secrets are NOT part of it: loading is
  the explicit `lib/environment.sh` chain (below).
- `node-run.sh` — the standalone `node_run()` sh lib (docs/d041): repo-pinned
  node for any script (system node on Termux, `mise exec node@24` elsewhere).
  Sourced here for compatibility and by the `generate.sh` shims directly.
- `go-build.mjs` — the go toolchain probe + android/host build-env presets
  (docs/d041): one probe (`go version` must actually EXECUTE — mise shims
  answer PATH lookups even with no version set) so no builder carries its
  own copy.
- `provision-termux.sh` — Termux provisioning (pkg node/jq + the infisical
  CLI source build; the former root `build.sh`), exec'd by the root
  `build.mjs` on Termux. Stays shell on purpose — every path in it is
  Termux-only and untestable from a container host.
- `environment.sh` — THE environment loader: `infisical run` fetches the
  vault and spawns the named script with it as plain env
  (`./lib/environment.sh ./coding-agent/run.sh`, docs/d046).  Consumers
  read plain env and never load secrets themselves; a failing vault is
  fatal here via the CLI's own exit code.
- `log.sh` / `log.mjs` / `log.py` — the structured loggers (per language).
- `cloud-providers.mjs` — the one cloud-provider fact table (id / label /
  key env / real base URL) every generator family derives from (docs/d024).
- `models.dev.api.json` — the single vendored models.dev catalog shared by
  the generator families (docs/d023).
- `catwalk-facts.json` — the vendored catwalk catalog cache (secondary model
  fallback; the refresher module lives in `coding-agent/`, docs/d039).
- `workload-*.jq` — the jq filters behind the workload description API.

The probe/facts/refresh modules that used to sit here (`peer-probe.mjs`,
`pi-models.mjs`, `hyper-facts.mjs`, `catwalk-facts.mjs`,
`refresh-models-dev.mjs`) were single-consumer and folded back into
`coding-agent/` (docs/d039).

Runner run-scripts source lib modules from the fixed `~/agentcontainer` layout.
lib is intentionally NOT copied into each runner — it is owned by the repo, like
`AGENTS.md` and `biome.jsonc`.

## One generate, one build (docs/d041)

The root `generate.mjs` (via the `generate.sh` shim) runs every folder's
generator in sequence — proxy (offline) → local-inference (capability-gated) →
coding-agent (network-heavy) — reporting failures without stopping the rest.
The root `build.mjs` (via the root `build.sh` shim) builds everything for
THIS host: container images in parallel on podman/docker hosts, Termux
provisioning + the android binary strictly serialized on ~1 GB devices.
Each folder also keeps its own `generate.sh` shim (a 3-line `node_run`
interpreter) for standalone use. Runners NEVER build or generate: run.sh
stages the COMMITTED config and a stale/missing artifact is a loud failure
pointing at the generator, never an implicit regeneration.

## Local vs cloud (two modules, two instances)

**Local llama.cpp (GGUF) model support lives only in `llm-local-inference/`** —
`config.d/10-local-llm-inference.yaml`, generated by the folded
`llm-local-inference/generate.mjs` (docs/d041) from `llamacpp-model-data.json`,
and only on hosts where generation detects a container backend + GPU devices.
`config.d/` carries exactly two layers:

| Layer | Role | Generated by | When |
|-------|------|--------------|------|
| `00-general.yaml` | globals + macros | `llm-local-inference/generate.mjs` | always |
| `10-local-llm-inference.yaml` (+ `.paths` staleness manifest) | local GGUF `models` | `llm-local-inference/generate.mjs` (from the shared `lib/llamacpp-model-data.json`; snapshot paths baked at generation, `docs/d029` B) | container backend + GPU detected |

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
| `llm-local-inference/` | local GGUF serving only (GPU container hosts; hard-fails elsewhere) | `generate.sh`/`generate.mjs` (both layers, docs/d041) + `active-b.json`, `llama-swap-core.json`, `config.d/`, `run.sh` |
| `llm-reverse-proxy/` | host-allowlist cloud router (docs/d047, the only mode): `/<upstream-host>/<path>` → the allowlisted scheme://host root, byte-for-byte, no keys — deny-by-absence for everything else (docs/d027's 404 policy); streaming as-is, RFC 9457 502s | `main.go`, `generate.sh`/`generate.mjs` (allowHosts from pi-ai + lib/cloud-providers.mjs, docs/d047), `llm-reverse-proxy.example.json`, `smoke-test.sh`; built by the root `build.mjs` |
| `coding-agent/` | base pi workload image + artifacts (includes Cline CLI and Thinkrail) | `generate.sh`/`generate.mjs` orchestrator + stage generators, `Containerfile`, `config.toml`, `run.sh`, `settings.json`; image built by the root `build.mjs` |

The former "next planned step" sketch (a simplified config-generator system
split by concern) is archived at
[archive/future-config-generator-system.md](archive/future-config-generator-system.md)
— d030/d037 implemented its generator split, d041 the unified entrypoints.
Document taxonomy (requirements / reference / design + the decision log):
docs/d042.
