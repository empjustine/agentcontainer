---
id: environments
type: architecture-design
status: draft
title: "Deployment environments and variants"
parent: architecture
references: ["architecture", "llm-local-inference", "coding-agent"]
tags: ["environments", "matrix"]
---

# Deployment environments and variants

This repo targets several distinct deployment environments. Environments arrive
with different capabilities (GPU or none, container runtime or none, cloud
access or not) and the tree adapts along those functional lines:

- **LLM serving** is split along its two concerns: local GGUF inference is
  ONE llama-swap dir, `llm-local-inference/` — **deprecated for now**,
  docs/d108 (generation emits only the
  `config.d/` layers the current host can use — local inference wherever a
  GPU + container backend exist; there is no peers-only llama-swap mode),
  and cloud-provider relay is `estige/` — the SSL-VPN tunnel family
  (one binary, two roles — exit node and relay node, docs/d073/d077/d088),
  deployed as a package on every host that can reach the cloud (docs/d120).
- **LLM usage** (the coding agent) lives under `coding-agent/`
- **docs** live here, under `docs/`

> **Direction (docs/d108).** The llama-swap provider is deprecated for now. The
> reverse-proxy mode (legacy "mode A", the allowlist relay) is **gone** — it
> was deprecated as insecure and has been deleted, allowlist and generator
> included; the SSL-VPN tunnel transports replace it. A host still serving
> the old shapes below is running a deployment that predates this tree.

We avoid the old ambiguous "provider" naming in favour of these functional
names.

## Environments

| Name                     | Sandbox / runtime                     | Cloud access | Serving dir(s)                                                    | Usage dir                       |
| ------------------------ | ------------------------------------- | ------------ | ----------------------------------------------------------------- | ------------------------------- |
| **local-inference-host** | rootless podman, SELinux enforced     | direct       | `llm-local-inference/` (local layer) + `estige/` (tunnel service) | `coding-agent/`                 |
| **termux**               | rootless termux, restrictive SELinux, | direct (if   | `estige/` (deb, exit-node service)                                | `coding-agent/`                 |
|                          | non-standard file paths               | any)         |                                                                   |                                 |
| **small-cloud-vm**       | rootless podman or docker             | relay only   | `estige/` (rpm, relay service)                                    | `coding-agent/` (static config) |

### local-inference-host (full, default)

GPU host (local inference only) — two serving processes, one concern each (docs/d027):

- `llm-local-inference/` — generation (`generate.mjs`, docs/d041) detects the
  container backend + GPU devices and emits the local GGUF layer (`10-local-llm-inference.yaml` + its
  `.paths` staleness manifest; snapshot paths baked at generation, docs/d029);
  `run.sh` launches the `unified-vulkan` image with GPU
  passthrough + the HF cache on LAN port **8101** (container 8080).
  llama-swap serves the LOCAL catalog and nothing else — its `peers`/proxy
  config is no longer exercised.
- `estige/` — the SSL-VPN tunnel node (this folder's own `build.sh`, installed
  as a service or run directly; docs/d120, LAN **8080**, host networking): the tunnel transports (h2-POST, WebSocket,
  h1.1-POST; docs/d073/d077/d105) under the single reserved path `/vpn`.
  This is the world-visible port — the tailscale funnel serves the
  `<funnel-id>` route to it — and every other path answers the funnel's
  plain 404: the allowlist `/<upstream-host>/<path>` router that shared it
  is deleted (docs/d108), so there is no provider route left to reach.

**Port model (all hosts):** ONE front. The tailscale funnel serves the
whole `<uuid>` route to estige on host port **8080** (normal
https port on the wire); behind it sits the tunnel namespace `/vpn` and
nothing else — the host-allowlist route map is deleted (docs/d108), so the
funnel is no longer a cloud-provider front for external clients.
llama-swap holds
LAN **8101**. The legacy local-inference port **18080** is **deprecated**
with the two-instance squash — nothing listens on it, and code that still
probes `localhost:18080` must use the funnel base URL (`$REVERSE_PROXY_BASE_URLS`).

The coding agent (`coding-agent/`) uses local models via the llama-swap
face and cloud providers via the estige face (ALWAYS via the
proxy — the generators' proxy-only cascade, docs/d063, retired the
direct-first one); both faces are also the unified endpoint for
external clients.

### termux (funnel-only serving)

Hostname `<serial>.sn.mynetname.net` (a Synology/`mynetname` DDNS name — put your
own here). SoC: **EN7562CT** (ARM32v5, 512 MB RAM, 128 MB flash). Resource-constrained host (a phone/router under Termux). It **cannot run the
`llm-local-inference` llama-swap container** at all — Termux has no usable
podman/docker for this — and local llama.cpp inference is impossible anyway.
So there is no llama-swap here at all: the host serves the tunnel only, via a
**native termux build of estige** (compiled for the device).

- `./estige/build.sh estige-packages` (its own `build.mjs`) writes the Termux
  `.deb`, whose payload cross-compiles with the android preset from the
  folder's own `lib/go-build.mjs` (`CGO_ENABLED=0 GOOS=android GOARCH=arm64` —
  so the Android resolver is used instead of the missing `/etc/resolv.conf`;
  docs/d041). `dpkg -i` + `sv-enable estige` is the whole install, and the
  runit service execs the binary against `${PORT:-8080}` (the only bind
  spelling, docs/d110) — no podman/docker, no GPU detection, no image pull, no
  generation step, no shell launcher (docs/d120).
- The service serves the tunnel; there is no allowlist to generate any more
  (docs/d108 — `estige generate` and the shared provider fact table's
  allowlist role are gone). Neither node injects keys; clients keep the
  provider keys themselves.
  See [termux-serving.md](termux-serving.md) for the map of where the
  termux serving documentation now lives.

### wsl2 (nonfree-world, funnel-only usage)

No fixed hostname (dynamic). Kernel: `6.18.33.2-microsoft-standard-WSL2`. WSL2 under rootful docker with **no direct cloud access**, so the coding agent
only ever talks through the funnel. `coding-agent/` covers this via static
config (no Infisical-backed generation; a static pi `settings.json` +
`models.json`/`opencode.jsonc` that override the built-in providers with
their reverse-proxy routes — `baseUrl` hardcoded to the routed form
`<base>/<upstream-host><base-path>`, docs/d047/d070; cloud providers
carry their own key env references, which pi resolves from the env at
request time — the proxy forwards them untouched).

- **Environment** — `PEER_API_KEY` (llama-swap's local bearer only) /
  `REVERSE_PROXY_BASE_URLS` and the per-provider keys (`OPENROUTER_API_KEY`,
  `OPENCODE_API_KEY`, `CLINE_API_KEY`, `HYPER_API_KEY`, `GEMINI_API_KEY`,
  …), exported into the process environment (Infisical via ./environment.sh,
  or exported by hand). No `.env` file is read anywhere in the repo.
  `REVERSE_PROXY_BASE_URLS` is read by the
  generator's route probing (`route-probe.mjs`) and baked into the provider
  `baseUrl` overrides; `run.sh`
  does not forward them into the sandbox (docs/d056).
- **Serving** (`estige/`): the tunnel node
  (`./estige/build.sh` — each folder builds itself, docs/d113 — then its
  installed service; docs/d120), as on the other non-GPU hosts.

`llm-local-inference/`'s own shell workload runtime (and `coding-agent/`'s node
one) makes this work on both local-inference-host-style podman and
small-cloud-vm-style docker through the same `workload_*` description: `workload_user` emits
`--userns=keep-id --user uid:gid` (plus `--group-add keep-groups`) on rootless
podman, and just `--user uid:gid` on rootful docker; SELinux relabeling is
automatic (`:z,U` on podman, `:z` on docker) with no per-script flags.

### small-cloud-vm (small cloud VM, funnel-only serving)

The host only
relays cloud providers. The relay is estige — one Go binary, ~13 MB
RSS, no model routing and no secrets, installed as a service from the `.rpm`
(docs/d120), so the 1 GB budget is not a constraint.

- **Serving** (`estige/`): just `./estige/build.sh` and the installed
  `estige.service` (no generate step — estige has no generator since
  docs/d108) — the exit
  node serves the tunnel namespace on LAN
  `${PORT:-8080}` (host-network container or native binary; one port, one knob,
  docs/d110). The allowlist route table it used to generate is gone with the
  reverse proxy (docs/d108).
- **Usage** (`coding-agent/`): static provider config; there are no
  path-routes to point at any more (docs/d108).
- **Keys**: the proxy injects nothing — clients carry the provider keys
  (`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `CLINE_API_KEY`,
  `HYPER_API_KEY`, `GEMINI_API_KEY`, …) themselves, from Infisical via
  ./environment.sh.

This is the relay-only deployment documented as a first-class environment —
the realistic option for hosts that can't afford the `unified-vulkan` image
or the local GPU/VRAM (local-inference generation simply fails there — there
is no peers-only llama-swap mode anymore).

> Note: `local-inference-host`, `termux`, and `small-cloud-vm` are **static**
> reference hosts with known hostnames and hardware. `wsl2` is **dynamic** —
> it has no fixed hostname and is instantiated ad-hoc.
>
> The previous MikroTik **arm5** (e50ug / RouterOS 7) variant has been
> retired — its environment row, runner, deploy scripts, and tailscale helper
> live only in the archive.

## Shared support file

`<unit>/lib/workload-runtime.sh` (one hand copy per unit, docs/d113 — today only
`llm-local-inference/`; `coding-agent/` carries the node implementation instead,
`lib/workload-runtime.mjs`, docs/d119, and `estige/` retired its copy with
docs/d120) is a **description-driven workload runner**: run
scripts declare _what_ they need and the tool renders _how_ for the active
backend — rootless podman or rootful docker — It is
the single place that detects the backend and computes `SCRIPT_DIR`
(the only "where do I live" logic), so run scripts never re-detect podman/docker
or guess their own paths inline. PRoot was removed as a backend (see
[container-tooling.md](container-tooling.md)); a qemu/libvirt VM backend is
assessed in [d020-libvirt-qemu-sandbox.md](d020-libvirt-qemu-sandbox.md).

See [container-tooling.md](container-tooling.md) for the full `workload_*` API.

## Image / mode per instance

There is ONE llama-swap serving folder (`llm-local-inference/`) with ONE
mode: the local GGUF layer. A host without the container backend + GPU
cannot serve llama-swap at all — `generate.sh` fails hard (`LOCAL_INFERENCE=1`
forces generation for debug/parity only) — and its cloud relay, when any,
runs estige's packaged service instead (docs/d027; the `run.sh`, `vpn-exit.sh`
and `vpn-relay.sh` names retired with docs/d095 and docs/d120):

- llama-swap: `ghcr.io/mostlygeek/llama-swap:unified-vulkan` (local
  llama.cpp needs the GPU/Vulkan runtime), GPU devices passed through, HF
  cache tree mounted, LAN **8101** (container 8080).
- estige: one Go binary, deployed as a package + service (docs/d120) —
  containerized with host networking or direct on the host, e.g. the termux
  cross-build — LAN **8080**, no secrets mounted: the funnel front holds the
  operator's tunnel keys, provider keys stay with the clients.

llama-swap is launched with `-config-dir <dir>/config.d`; the termux
path has no container and no llama-swap at all — it runs estige's installed
service (docs/d027/d120).
