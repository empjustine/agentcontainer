---
id: environments
type: architecture-design
status: draft
title: "Deployment environments and peer variants"
parent: goal
references: ["architecture", "llm-local-inference", "coding-agent"]
tags: ["environments", "matrix"]
---

# Deployment environments and peer variants

This repo targets several distinct deployment environments. Environments arrive
with different capabilities (GPU or none, container runtime or none, cloud
access or not) and the tree adapts along those functional lines:

- **LLM serving** is split along its two concerns: local GGUF inference is
  ONE llama-swap dir, `llm-local-inference/` (`generate.sh` emits only the
  `config.d/` layers the current host can use — local inference wherever a
  GPU + container backend exist; there is no peers-only llama-swap mode),
  and cloud-provider relay is `llm-reverse-proxy/`, the simplified
  path-prefix router (docs/d027) deployable on every host that can reach
  the cloud.
- **LLM usage** (the coding agent) lives under `coding-agent/`
- **docs** live here, under `docs/`

We avoid the old ambiguous "provider" naming in favour of these functional
names.

## Environments

| Name             | Sandbox / runtime                          | Cloud access | Serving dir(s)                                       | Usage dir              |
|------------------|--------------------------------------------|--------------|-----------------------------------------------------|------------------------|
| **bazzite-gfx1030** | rootless podman, SELinux enforced       | direct       | `llm-local-inference/` (local layer) + `llm-reverse-proxy/` (cloud relay) | `coding-agent/`        |
| **a50-en7562ct**    | rootless **termux**, restrictive SELinux, | direct (if   | `llm-reverse-proxy/` (native build/run, cloud relay)  | `coding-agent/`        |
|                  | non-standard file paths                    | any)         |                                                     |                        |
| **wsl2**             | WSL2 **rootful docker**, no direct cloud | peers only   | `llm-reverse-proxy/` (peers only)                   | `coding-agent/` (static config) |
| **oci-e21micro**     | Oracle OCI Compute (x86), rootless        | peers only   | `llm-reverse-proxy/` (peers only)                   | `coding-agent/` (static config) |
|                  | podman or docker                           |              |                                                     |                        |

### bazzite-gfx1030 (full, default)
Hostname `bazzite.coelacanth-barb.ts.net`. GPU: **gfx1030** (RDNA2 / Navi 21 “Sienna Cichlid”, RX 6900 XT 16 GB). Two serving processes, one concern each (docs/d027):

- `llm-local-inference/` — `generate.sh` detects the container backend + GPU
  devices and emits the local GGUF layer (`10-local-llm-inference.yaml` +
  `launch-gguf.sh`); `run.sh` launches the `unified-vulkan` image with GPU
  passthrough + the HF cache on LAN port **8101** (container 8080).
  llama-swap serves the LOCAL catalog and nothing else — its peer/proxy
  machinery is no longer exercised.
- `llm-reverse-proxy/` — the simplified cloud router (`build.sh` +
  `generate.sh` + `run.sh`, LAN **8080**, host networking):
  `/<providerId>` path prefixes forwarded byte-for-byte to each provider's
  real base URL (docs/d027), plus the `llama-swap` route pointing back at
  the local instance on loopback. This is the world-visible face — the
  tailscale funnel serves the `<funnel-id>` route to this port — for this
  host's own coding agent and for external/peer clients alike.

**Port model (all hosts):** ONE front. The tailscale funnel serves the
whole `<uuid>` route to llm-reverse-proxy on host port **8080** (normal
https port on the wire); the proxy path-prefix routes behind it:
`/llama-swap/…` → `http://127.0.0.1:8101` (llama-swap, local GGUF,
model-id routing — the loopback hop never leaves the host),
`/<providerId>` → each cloud provider's real base URL. llama-swap holds
LAN **8101**. The legacy local-inference port **18080** is **deprecated**
with the two-instance squash — nothing listens on it, and code that still
peers `localhost:18080` must use the funnel base URL (`$PEER_BASE_URL`).

The coding agent (`coding-agent/`) uses local models via the llama-swap
face and cloud providers via the llm-reverse-proxy face (or directly, per
the generators' direct-first cascades); both faces are also the unified
peer endpoint for external/peer clients. Rootless podman with SELinux means
every writable bind mount gets `:z,U` (or `:Z,U`) relabel + chown, and the
container runs as the host UID via `--userns=keep-id` + `--user
$(id -u):$(id -g)`. All of that is handled by `lib/workload-runtime.sh`,
sourced from the run scripts.

### a50-en7562ct (termux, peer-only serving)
Hostname `hjs0aj87e30.sn.mynetname.net`. SoC: **EN7562CT** (ARM32v5, 512 MB RAM, 128 MB flash). Resource-constrained host (a phone/router under Termux). It **cannot run the
`llm-local-inference` llama-swap container** at all — Termux has no usable
podman/docker for this — and local llama.cpp inference is impossible anyway.
So there is no llama-swap here at all: the host serves the cloud relay only,
via a **native termux build of llm-reverse-proxy** (compiled for the device).

- `llm-reverse-proxy/build.sh` cross-builds the static binary with
  `CGO_ENABLED=0 GOOS=android GOARCH=arm64` (so the Android resolver is used
  instead of the missing `/etc/resolv.conf`), and `run.sh`'s native branch
  `exec`s it against `llm-reverse-proxy.json` and `${LISTEN:-:8080}` — no
  podman/docker, no GPU detection, no image pull, no build/generate step.
- `llm-reverse-proxy/generate.sh` (→ `generate-config.mjs`) emits the
  routing table from the shared provider fact table
  (lib/cloud-providers.mjs, docs/d027): one path prefix per provider,
  upstream = the provider's FULL real base URL.
  The proxy injects no keys; clients (the coding agent on this host, or
  remote peers through the funnel) carry the provider keys themselves.
  See [termux-serving.md](termux-serving.md) for the map of where the
  a50/Termux documentation now lives.

### wsl2 (nonfree-world, peer-only usage)
No fixed hostname (dynamic). Kernel: `6.18.33.2-microsoft-standard-WSL2`. WSL2 under rootful docker with **no direct cloud access**, so the coding agent
only ever talks to a peer endpoint. `coding-agent/` covers this via static
config (no Infisical-backed generation; a static pi `settings.json` +
`models.json`/`opencode.jsonc` that override the built-in providers with
their peer path-routes — `baseUrl` hardcoded to `<peerBase>/<providerId>`,
docs/d027; cloud providers carry their own key env references, which pi
resolves from the env at request time — the proxy forwards them untouched).

- **Environment** — `PEER_API_KEY` (llama-swap's local bearer only) /
  `PEER_BASE_URL` and the per-provider keys (`OPENROUTER_API_KEY`,
  `OPENCODE_API_KEY`, `CLINE_API_KEY`, `HYPER_API_KEY`, `GEMINI_API_KEY`,
  …), exported into the process environment (Infisical via lib/environment.sh,
  or exported by hand). No `.env` file is read anywhere in the repo.
  `PEER_BASE_URL` is currently informational — the peer base is hardcoded
  in the static provider config.
- **Serving** (`llm-reverse-proxy/`): the peers-only cloud relay
  (`./build.sh && ./generate.sh && ./run.sh`), as on the other
  non-GPU hosts.

The shared `lib/workload-runtime.sh` makes this work on both bazzite-gfx1030-style podman and
wsl2-style docker through the same `workload_*` description: `workload_user` emits
`--userns=keep-id --user uid:gid` (plus `--group-add keep-groups`) on rootless
podman, and just `--user uid:gid` on rootful docker; SELinux relabeling is
automatic (`:z,U` on podman, `:z` on docker) with no per-script flags.

### oci-e21micro (Oracle Cloud, peer-only serving)
Hostname `instancepool-1-instance-1.subnetac1efe80.vcnac1efe.oraclevcn.com`. Shape: **VM.Standard.E2.1.Micro** (1/8 OCPU, 1 GB RAM). Tight memory
budget means **no local llama.cpp inference** (and no GPU); the host only
relays cloud providers, just like the `wsl2` variant. The difference from
`wsl2` is the workload (OCI's rootless podman or docker, rather than WSL2
rootful docker). The relay is llm-reverse-proxy — one static Go binary,
~13 MB RSS, no model routing and no secrets, so the 1 GB budget is not a
constraint.

- **Serving** (`llm-reverse-proxy/`): just `./build.sh &&
  ./generate.sh && ./run.sh` — the routing table is generated from
  the shared fact table (docs/d027) and the proxy listens on LAN
  `${HOST_PORT:-8080}` (host-network container or native binary).
- **Usage** (`coding-agent/`): static provider config pointing the agent at
  the peer path-routes, as on `wsl2`.
- **Keys**: the proxy injects nothing — clients carry the provider keys
  (`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `CLINE_API_KEY`,
  `HYPER_API_KEY`, `GEMINI_API_KEY`, …) themselves, from Infisical via
  lib/environment.sh.

This is the peers-only deployment documented as a first-class environment —
the realistic option for hosts that can't afford the `unified-vulkan` image
or the local GPU/VRAM (llama-swap's generate.sh simply fails there — there
is no peers-only llama-swap mode anymore).

> Note: `bazzite-gfx1030`, `a50-en7562ct`, and `oci-e21micro` are **static**
> reference hosts with known hostnames and hardware.  `wsl2` is **dynamic** —
> it has no fixed hostname and is instantiated ad-hoc.
>
> The previous MikroTik **arm5** (e50ug / RouterOS 7) variant has been
> retired — its environment row, runner, deploy scripts, and tailscale helper
> live only in the archive.

## Shared support file

`lib/workload-runtime.sh` (repo root) is a **description-driven workload runner**: run
scripts declare *what* they need and the tool renders *how* for the active
backend — rootless podman or rootful docker — hiding every backend quirk (SELinux
`:z`/`:U` relabel + chown-to-subuid, `--userns=keep-id` vs rootful `--user`,
GPU device passthrough, port publishing, hardening) behind one interface. It is
the single place that detects the backend and computes `SCRIPT_DIR` / `REPO_ROOT`
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
runs `llm-reverse-proxy/run.sh` instead (docs/d027):

- llama-swap: `ghcr.io/mostlygeek/llama-swap:unified-vulkan` (local
  llama.cpp needs the GPU/Vulkan runtime), GPU devices passed through, HF
  cache tree mounted, LAN **8101** (container 8080).
- llm-reverse-proxy: one static Go binary (containerized with host
  networking or native, e.g. the termux cross-build), LAN **8080**, no
  secrets mounted — clients carry the provider keys.

llama-swap is launched with `-config-dir <dir>/config.d`; the a50/termux
path has no container and no llama-swap at all — it runs the native
llm-reverse-proxy binary (docs/d027).
