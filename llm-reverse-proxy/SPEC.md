---
id: llm-reverse-proxy
type: module-design
status: draft
title: llm-reverse-proxy — one multipurpose llama-swap instance per host
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

Run the host's single llama-swap serving instance: generate the capability-gated
`config.d/` layers for *this* host, then launch llama-swap adapted to whatever
was generated. The mode (local GGUF + peers vs peers-only) is never a toggle —
it falls out of which layers `generate.sh` emitted.

## Shape

`generate.sh` (generation) and `run.sh` (serve-only) are strictly separated;
`run.sh` mounts the generated `config.d/` read-only and adapts:

| Aspect | Local layer present | Peers-only |
|---|---|---|
| Image | `llama-swap:unified-vulkan` + GPU passthrough + HF-cache mount | `llama-swap:cpu` (lighter) |
| Port | LAN **8080** (always; `HOST_PORT` overrides; in-container 8080) | same |

The world reaches the catalog via the tailscale FQDN reverse proxy → :8080. The
legacy :18080 port is dead and never probed.

**config.d layers** (split per concern; merge contract in `docs/d018-split-config-d.md`):
`00-general.yaml` (globals/macros; always) · `10-local-llm-inference.yaml` +
`launch-gguf.sh` (container backend **and** GPU devices detected) ·
`peer-cloud.yaml` (whenever ≥1 cloud provider answers) ·
`22-peer-gfx1030.yaml` (non-GPU hosts; probes a remote local-inference peer —
never localhost). Stale layers from a previous capability set are removed.

**Termux leaf** (a50): no container at all — `build.sh` cross-builds a native
llama-swap (`GOOS=android`), `run-native.sh` execs it against the same
peers-only `config.d/`. Peers-only by construction (no backend, no GPU
detected).

## Decisions & invariants

- **Generation-time, not runtime**: context windows are embedded into each
  model's `cmd` as `--ctx-size/--n-predict` at generation time from the shared
  `lib/llamacpp-model-data.json` (owner of the table's *content*; file lives in
  `lib` — `docs/d025`), model-id slugs derive from `active-b.json`
  (`docs/d003-llamacpp-context-windows.md`).
- **Key naming**: plain, un-prefixed provider env names read at generation time;
  `baseUrl` is baked as a literal (no `$VAR` support there) —
  `docs/d001-proxy-env-and-namespace.md`.
- **Provider facts once**: ids/labels/key-envs/base-URLs come from
  `lib/cloud-providers.mjs` (`docs/d024`); `gen-lib.mjs` only adds llama-swap
  extras. Adding a peer = one `PROVIDERS` entry **plus** the hard-coded
  `ALLOWED` peer allowlist inside `generate.sh` (the real gate — undocumented
  elsewhere).
- **No silent shrinkage**: `generate.sh` snapshots `config.d/` and restores it
  when the probed peer set shrank (a transient network failure must not
  silently drop peers); `FORCE=1` overrides.
- **Catalog robustness**: an unreadable vendored catalog skips that provider,
  never aborts the layer (`docs/d021-unreadable-models-dev-catalog.md`).

## Boundary

Copy unit = this folder + `../lib` (`docs/architecture.md`): may import
`lib/log.mjs`, `lib/peer-probe.mjs`, `lib/cloud-providers.mjs`,
`lib/hyper-facts.mjs` (the Charm Hyper model-facts cache — shared with the
pi-side `coding-agent` generator, one lineup across both consumers), and read
the shared data tables `lib/models.dev.api.json` /
`lib/llamacpp-model-data.json` / `lib/hyper-facts.json`. Must not import from
sibling runner folders or `local-llm/` (no reverse dependency exists).
