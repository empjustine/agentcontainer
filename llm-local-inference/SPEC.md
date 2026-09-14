---
id: llm-local-inference
type: module-design
status: draft
title: llm-local-inference — one llama-swap instance per GPU host, local GGUFs only
parent: architecture
depends-on:
  - lib
references:
  - environments
tags:
  - serving
  - llama-swap
---

## Responsibility

Run the GPU host's single llama-swap serving instance for **local GGUF
inference**: generate the capability-gated `config.d/` layers for *this* host,
then launch llama-swap against whatever was generated. Remote/cloud relaying
is explicitly OUT of scope — it is served by `../llm-reverse-proxy` (the raw
passthrough proxy, no model routing, no credential handling). The former
cloud-peer layers (`peer-cloud.yaml` from `gen-lib`'s PROVIDERS table) and the
remote gfx1030 peer route (`22-peer-gfx1030.yaml`) were removed in that
handoff; llama-swap's peer/proxy machinery is no longer exercised from here.

## Shape

`generate.sh` (generation) and `run.sh` (serve) are strictly separated;
`run.sh` mounts the generated `config.d/` read-only into the
`llama-swap:unified-vulkan` image with GPU passthrough + HF-cache mounts and
publishes LAN **8101** (`HOST_PORT` overrides; in-container 8080) — host
port 8080 belongs to ../llm-reverse-proxy, the funnel front, which points
the local face back here at `http://127.0.0.1:8101`. The world reaches the
catalog via the tailscale FQDN → :8080 (proxy) → `/llama-swap/…` → :8101.
The legacy :18080 port is dead and never probed.

**config.d layers** (merge contract in `docs/d018-split-config-d.md`):
`00-general.yaml` (globals/macros; always) · `10-local-llm-inference.yaml` +
its `.paths` staleness manifest (only when a container backend **and** GPU
devices are detected). There is no peers-only mode: a host without the
container backend + GPU cannot serve local inference and `generate.sh` fails
hard (`LOCAL_INFERENCE=1` forces generation for debug only). No shell lives in
`config.d/` anymore — the former in-container `launch-gguf.sh` resolver was
replaced by generation-time path baking (`docs/d029` option B).

**Termux leaf**: removed. Termux was peers-only by construction, and with
peers gone from this module it has no role here — there is no `run-native.sh`,
no android cross-build in `build.sh`, only the container image pull.

## Decisions & invariants

- **Generation-time, not runtime**: context windows are embedded into each
  model's `cmd` as `--ctx-size/--n-predict` at generation time from the shared
  `lib/llamacpp-model-data.json` (owner of the table's *content*; file lives in
  `lib` — `docs/d025`), model-id slugs derive from `active-b.json`
  (`docs/d003-llamacpp-context-windows.md`).
- **Generation-time path baking** (`docs/d029` option B): each model is
  resolved to ONE HF snapshot dir (refs/main first, the revision
  `../local-llm/download_models.py` pins) and `--model/--mmproj/--model-draft`
  are emitted as plain absolute args inside the `cmd`. llama-swap splits `cmd`
  with posix shlex and execs argv directly — no shell runs, so the retired
  `launch-gguf.sh` in-container resolver (binary lookup, download fallback,
  positional interface) is gone. A cache miss is a generation error; model
  provisioning belongs to `../local-llm/download_models.py` and is never
  duplicated as a launch-time download. `run.sh` re-verifies the baked paths
  via the generated `.paths` manifest so a cache changed since generation is
  a loud "re-run ./generate.sh", not a llama-server 127 at swap time.
- **Offline generation**: the local layer is built from vendored tables
  (`llamacpp-model-data.json`, `active-b.json`, `llama-swap-core.json`) plus a
  read of the host HF hub cache directory (no network) — the models.dev
  refresh and every HTTP probe were peer machinery and are gone.
- **Inbound bearer auth stays**: `apiKeys: ${env.PEER_API_KEY}` in
  `00-general.yaml` is llama-swap's *own* client-facing key (the historical
  name is kept; `docs/d001` covers the key-naming contract). It is the only
  secret this module needs — `HF_TOKEN` is NOT forwarded into the container
  anymore (nothing in-container downloads). Only **run.sh** needs the vault
  (via lib/environment.sh) — generation is offline and key-free: llama-swap
  resolves the `${env.*}` reference from its own environment at load time.

## Boundary

Copy unit = this folder + `../lib` (`docs/architecture.md`): may import
`lib/log.mjs` and read the shared data tables `lib/llamacpp-model-data.json`.
Must not import from sibling runner folders or `local-llm/`. The `lib`
modules this module no longer uses (`peer-probe.mjs`, `cloud-providers.mjs`,
`hyper-facts.mjs`, `models.dev.api.json`) remain in `lib` because
`../coding-agent` and `../llm-reverse-proxy` consumers still share them.
