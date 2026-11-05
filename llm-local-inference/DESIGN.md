---
id: llm-local-inference
type: module-design
status: draft
title: llm-local-inference — one llama-swap instance per GPU host, local GGUFs only (deprecated for now, d108)
parent: architecture
depends-on:
  - workload-api
references:
  - environments
tags:
  - serving
  - llama-swap
---

## Responsibility

> **Deprecated for now (docs/d108).** No new clients or features; existing
> deployments keep working. This document stays as the description of the
> paused shape.

Charter: the GPU host's single llama-swap instance for **local GGUF
inference** — generate the capability-gated `config.d/` layers for _this_
host, then launch llama-swap against whatever was generated. The normative
requirement statement lives in the BRD
([../docs/requirements.md](../docs/requirements.md), FR-S1–FR-S4); this doc
owns the shape and the non-obvious mechanics. Serving models _this_ host
cannot run itself is OUT of scope — relaying moved to
`../estige` (the raw passthrough proxy), taking the former relay
layers and the route to a remote host's GPU with it; llama-swap's own
relay/proxy machinery is no longer exercised from here.

## Shape

`generate.mjs` (generation — the former gen-lib.mjs + both emitters folded
into one file, docs/d041; `./npm-run.sh llm-local-inference generate` runs it)
and `run.sh`
(serve) are strictly separated;
`run.sh` mounts the generated `config.d/` read-only into the
`llama-swap:unified-vulkan` image with GPU passthrough + HF-cache mounts and
publishes LAN **8101** (`HOST_PORT` overrides; in-container 8080) — host
port 8080 belongs to ../estige, the funnel front, which points
the local face back here at `http://127.0.0.1:8101`. The world reaches the
catalog via the tailscale FQDN → :8080 (proxy) → `/llama-swap/…` → :8101.
The legacy :18080 port is dead and never probed.

**config.d layers** (layer-merge rules in `docs/d018-split-config-d.md` —
not pi's layered-cake merge; d072 names the two apart):
`00-general.yaml` (globals/macros; always) · `10-local-llm-inference.yaml` +
its `.paths` staleness manifest (only when a container backend **and** GPU
devices are detected). There is no mode where this instance serves another
host's models: a host without the container backend + GPU cannot serve local
inference and generation fails hard
(`LOCAL_INFERENCE=1` forces generation for debug only). No shell lives in
`config.d/` anymore — the former in-container `launch-gguf.sh` resolver was
replaced by generation-time path baking (`docs/d029` option B).

**Termux leaf**: removed. Termux can neither serve local inference (no
container backend, no GPU) nor reach anything through this module once
relaying left, so it has no role here — there is no `run-native.sh`,
no android cross-build — this folder's own `build.mjs` (docs/d083/d113) only
pre-pulls the container image, and only on a host that is an inference
endpoint.

## Decisions & invariants

- **Generation-time, not runtime**: context windows are embedded into each
  model's `cmd` as `--ctx-size/--n-predict` at generation time from
  `lib/llamacpp-model-data.json` — this folder's own copy, which it also owns
  the _content_ of (`docs/d025`, `CACHE-DESIGN.md`); model-id slugs derive from
  `active-b.json` (`docs/d003-llamacpp-context-windows.md`).
- **Generation-time path baking** (`docs/d029` option B): each model is
  resolved to ONE HF snapshot dir (refs/main first, the revision
  `download_models.py` pins) and `--model/--mmproj/--model-draft`
  are emitted as plain absolute args inside the `cmd`. llama-swap splits `cmd`
  with posix shlex and execs argv directly — no shell runs, so the retired
  `launch-gguf.sh` in-container resolver (binary lookup, download fallback,
  positional interface) is gone. A cache miss is a generation error; model
  provisioning belongs to `download_models.py` and is never
  duplicated as a launch-time download. `run.sh` re-verifies the baked paths
  via the generated `.paths` manifest so a cache changed since generation is
  a loud "re-run ./npm-run.sh llm-local-inference generate", not a llama-server 127
  at swap time.
- **Offline generation**: the local layer is built from vendored tables
  (`llamacpp-model-data.json`, `active-b.json`, `llama-swap-core.json`) plus a
  read of the host HF hub cache directory (no network) — the models.dev
  refresh and every HTTP probe went with that handoff and are gone.
- **Inbound bearer auth stays**: `apiKeys: ${env.REVERSE_PROXY_API_KEY}` in
  `00-general.yaml` is llama-swap's _own_ client-facing key (renamed from
  the historical `PEER_API_KEY` under d071; `docs/d001` covers the
  key-naming contract). It is the only
  secret this module needs — `HF_TOKEN` is NOT forwarded into the container
  anymore (nothing in-container downloads). Only **run.sh** needs the vault
  (via the repo-root `./environment.sh`) — generation is offline and key-free: llama-swap
  resolves the `${env.*}` reference from its own environment at load time.

## Boundary

Copy unit = this folder alone (`docs/architecture.md`, docs/d113): it carries
its own `lib/` copy — `log.mjs`/`log.py`, `artifact.mjs` +
`canonical-json.mjs`, `host-capabilities.mjs`, `workload-runtime.sh` +
`workload-*.jq`, and the data tables it reads
(`llamacpp-model-data.json`, `hf-manifests/`). The HF-cache provisioning and
audit tooling that used to be the sibling `local-llm/` folder now lives FLAT in
this folder too (`CACHE-DESIGN.md` is its sub-spec), so there is no separate
cache unit to reach into. It does NOT carry `cloud-providers.mjs`,
`models.dev.api.json` or `route-probe.mjs` — the modules this unit no longer
uses; they live only in the folders that still consume them
(`../coding-agent` took the probe/facts modules in d039, the JSON fact table in
d113). Must not import from a sibling runner folder.
