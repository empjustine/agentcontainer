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
| **serving** | run llama-swap (`llm-local-inference*`, LOCAL GGUF only; **deprecated for now**, d108) and estige (`estige/`, SSL-VPN tunnel family only — the reverse proxy is deleted, d108; docs/d073/d077) | `llm-local-inference/` (local layer, capability-gated) + `estige/` (exit node + relay node) |
| **usage** | run the pi coding-agent (`coding-agent*`) | `coding-agent/` |

The serving side is split by concern (docs/d027): llama-swap
(`llm-local-inference/`) is a **single local-GGUF instance** on GPU-capable
container hosts — there is no peers-only llama-swap mode — while cloud
provider relay is `estige/` (the path-prefix cloud router),
deployable wherever the cloud is reachable.

The old fixed-purpose split (`openai-completions-gfx1030/` +
`openai-completions-peer/`) and the `coding-agent-peer/` usage variant were
retired — the capability-gated generation pattern (pioneered by
`coding-agent/`) made the variant folders redundant.

Direction (docs/d108): the local llama-swap provider is deprecated for now,
and the reverse-proxy mode (legacy "mode A", the allowlist relay) is **deleted**
— it was deprecated as insecure (a TLS-terminating edge sees plaintext provider
keys) and the shape dragged route-rewriting generator machinery behind it. The
tunnel transports are the only serving shape left; the prose above that
describes an allowlist route is history, kept because the records it points at
keep their verdicts.

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
  `llama-swap-core.json`, `config.d/` and `run.sh`. Cloud/remote relaying is
  NOT here — it moved to `estige/` (the raw passthrough
  proxy); the relay layer generators, Termux build/serve, and peers-only mode
  were removed with that handoff.
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
- `node-run.ps1` — the PowerShell `node_run()` counterpart (docs/d062): the
  interpreter-selection lib for Windows shims (`git/maintain.ps1`). Same pin
  policy, but branches on mise PRESENCE — Windows carries no Termux-style
  profile signal to key on.
- `npm-tools.sh` — the one install path for the npm-pinned JS gates
  (docs/d107): `npm ci --ignore-scripts` from `package-lock.json` when the
  lock changes. The same lock carries the Android Biome/oxc builds, so Termux
  and the container hosts run identical gate versions.
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
  the generator families (docs/d023). Written in canonical order by
  `fact-table.mjs`; it carries no `_meta` block because the document itself
  is the provider namespace (docs/d086).
- `catwalk-facts.json` — the vendored catwalk catalog cache (secondary model
  fallback; the refresher module lives in `coding-agent/`, docs/d039), with
  the `_meta` provenance block every wrapped fact cache carries (docs/d086).
- `fact-table.mjs` — the fact-table publisher (docs/d086): canonical order,
  `_meta` provenance and the skip-when-unchanged rule in one place, called by
  `coding-agent/catalog-facts.mjs` and `coding-agent/refresh-models-dev.mjs`.
  Shared rather than folded into `coding-agent/` because it is the write
  contract for every fact table, not one runner's helper — the d039 rule is
  about single-consumer modules.
- `workload-*.jq` — the jq filters behind the workload description API.

The probe/facts/refresh modules that used to sit here (`route-probe.mjs`,
then named `peer-probe.mjs` (docs/d071), `pi-models.mjs`, `provider-facts.mjs`, `catwalk-facts.mjs`,
`refresh-models-dev.mjs`) were single-consumer and folded back into
`coding-agent/` (docs/d039).

Runner run-scripts source lib modules relative to their own location
(`$SCRIPT_DIR/../lib`), so a checkout may live anywhere. lib is
intentionally NOT copied into each runner — it is owned by the repo, like
`AGENTS.md` and `biome.jsonc`.

## One generate, one build (docs/d041)

The root `generate.mjs` (via the `generate.sh` shim) runs every folder's
generator in sequence — estige (offline, its Go `generate` subcommand since
d102) → local-inference (capability-gated) →
coding-agent (network-heavy) — reporting failures without stopping the rest.
The root `build.mjs` (via the root `build.sh` shim) builds everything for
THIS host: container images in parallel on podman/docker hosts, Termux
provisioning + the android binary strictly serialized on ~1 GB devices.
Target names select subsets (`./build.sh <target>…`; each folder's `build.sh`
shim selects its unit's — docs/d083), and capability gates key target
registration on hardware/network facts — the llama-swap pull needs an
inference endpoint: render devices plus the RAM floor (docs/d087;
d083's coding-agent free-disk gate retired with the image's shrink). Each
node-based folder also keeps its own `generate.sh` shim (a
3-line `node_run` interpreter) for standalone use; estige's generator is
its own binary's `generate` subcommand — no shim, no node (docs/d102).
Runners NEVER build or generate: run.sh
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

Cloud providers are NOT a config layer anymore: `estige/` (raw
passthrough proxy) serves them. The former `peer-cloud.yaml` and
`22-peer-gfx1030.yaml` layers — and the layer snapshot/rollback machinery
they required — were removed with that handoff.

(The old fixed-purpose `openai-completions-gfx1030/` / `openai-completions-peer/`
folders and the `coding-agent-cloud/`/`coding-agent-peer/` usage runners are
retired — the capability-gated layered generation pattern made
the variant folders redundant.)

| Folder | Role | What makes it work |
|--------|------|--------------------|
| `llm-local-inference/` (deprecated for now, d108) | local GGUF serving only (GPU container hosts; hard-fails elsewhere) | `generate.sh`/`generate.mjs` (both layers, docs/d041) + `active-b.json`, `llama-swap-core.json`, `config.d/`, `run.sh` |
| `estige/` (tunnel-only since d108) | the SSL-VPN tunnel transports (h2-POST, WebSocket, h1.1-POST; docs/d073/d077/d105) in one binary in two network positions (docs/d088): the **exit node** (`vpn-exit.sh`; funnel front + tunnel server, egress enforced from `tunnel.egress`) and the **relay node** (`vpn-relay.sh`; loopback CONNECT/SOCKS5 — serve mode, or the chain step that points a child at it, docs/d095). One reserved path (`/vpn`) serves the tunnels; **every other path answers the plain funnel 404** (d073 VPN-R34) — the allowlist reverse proxy that used to serve those paths (docs/d047/d063/d070) is deleted, not disabled (d108). WebSocket tunnel deployed; h2-POST tunnel default-on (d084); **no config file at all** (d108's tree-shake) — the arming credential, the bind (`PORT`, d110) and the egress opt-ins all arrive on the env chain, with d104's role store slated to own the policy half; standalone-repo boundary defined in docs/d082 (split-time CI findings in `estige/CI.md`) | `main.go`, the tunnel family — `relaynode.go`, `relaychain.go`, `tunnelserver.go`, `tunnelproto.go`, `modec.go`, `websocket.go`, `relay.go`, `egress.go` — plus the two deployment entries `vpn-exit.sh`/`vpn-relay.sh`; `generate.go`, `estige.json`, `estige.example.json` and `smoke-test.go` are deleted with the allowlist (docs/d108); built by the root `build.mjs` |
| `coding-agent/` | base pi workload image + artifacts (includes Cline CLI and Thinkrail) | `generate.sh`/`generate.mjs` orchestrator + stage generators, `Containerfile`, `config.toml`, `run.sh`, `settings.json`; image built by the root `build.mjs` |

The former "next planned step" sketch (a simplified config-generator system
split by concern) is archived at
[archive/future-config-generator-system.md](archive/future-config-generator-system.md)
— d030/d037 implemented its generator split, d041 the unified entrypoints.
Document taxonomy (requirements / reference / design + the decision log):
docs/d042.
