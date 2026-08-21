# Deployment environments and peer variants

This repo targets several distinct deployment environments. Environments arrive
with different capabilities (GPU or none, container runtime or none, cloud
access or not) and the tree adapts along those functional lines:

- **LLM serving** is ONE multipurpose llama-swap dir, `openai-completions/`:
  `generate.sh` emits only the `config.d/` layers the current host can use
  (local GGUF inference on GPU-capable container hosts, cloud peers wherever
  they are reachable, a route to a remote gfx1030 instance elsewhere), and
  `run.sh` adapts image/port/mounts to what was generated.
- **LLM usage** (the coding agent) lives under `coding-agent/`
- **docs** live here, under `docs/`

We avoid the old ambiguous "provider" naming in favour of these functional
names.

## Environments

| Name             | Sandbox / runtime                          | Cloud access | Serving dir(s)                                       | Usage dir              |
|------------------|--------------------------------------------|--------------|-----------------------------------------------------|------------------------|
| **bazzite-gfx1030** | rootless podman, SELinux enforced       | direct       | `openai-completions/` (local layer + peers)          | `coding-agent/`        |
| **a50-en7562ct**    | rootless **termux**, restrictive SELinux, | direct (if   | `openai-completions/` (native build/run)           | `coding-agent/`        |
|                  | non-standard file paths                    | any)         |                                                     |                        |
| **wsl2**             | WSL2 **rootful docker**, no direct cloud | peers only   | `openai-completions/` (peers-only)                 | `coding-agent/` (static config) |
| **oci-e21micro**     | Oracle OCI Compute (x86), rootless        | peers only   | `openai-completions/` (peers-only)                 | `coding-agent/` (static config) |
|                  | podman or docker                           |              |                                                     |                        |
| **arm5**             | MikroTik e50ug, **RouterOS 7 container**,| peers only   | `openai-completions-arm5/` (archived)              | (LAN pi → peer)        |
|                  | EN7562CT ARM32v5, 512 MB RAM, 128 MB flash |              |                                                     |                        |

### bazzite-gfx1030 (full, default)
Hostname `bazzite.coelacanth-barb.ts.net`. GPU: **gfx1030** (RDNA2 / Navi 21 “Sienna Cichlid”, RX 6900 XT 16 GB). Runs **one** multipurpose llama-swap instance:

- `openai-completions/` — `generate.sh` detects the container backend + GPU
  devices and emits the local GGUF layer (`10-local-llm-inference.yaml` +
  `launch-gguf.sh`) AND the cloud-peer layer into `config.d/`; `run.sh` then
  launches the `unified-vulkan` image with GPU passthrough + the HF cache on
  LAN port **8080**. One instance serves both concerns: local llama.cpp
  GGUF models and cloud peers (OpenRouter, OpenCode).

**Port model (all hosts):** the instance publishes LAN port **8080**; the
world reaches the same catalog through the bazzite tailscale FQDN reverse
proxy (`https://bazzite.coelacanth-barb.ts.net/<id>`, normal https port),
which forwards to 8080. The legacy local-inference port **18080** is
**deprecated** with the two-instance squash — nothing listens on it, and code
that still peers `localhost:18080` must use 8080 (or `$PEER_BASE_URL`).

The coding agent (`coding-agent/`) uses local models and cloud providers via
that instance plus its `auth.json`; the instance is also the unified peer
endpoint for external/peer clients. Rootless podman with SELinux means every
writable bind mount gets `:z,U` (or `:Z,U`) relabel + chown, and the container
runs as the host UID via `--userns=keep-id` + `--user $(id -u):$(id -g)`. All of
that is handled by `container-tool.sh`, sourced from the run scripts.

### a50-en7562ct (termux, peer-only serving)
Hostname `hjs0aj87e30.sn.mynetname.net`. SoC: **EN7562CT** (ARM32v5, 512 MB RAM, 128 MB flash). Resource-constrained host (a phone/router under Termux). It **cannot run the
`openai-completions` llama-swap container** at all — Termux has no usable
podman/docker for this and the image is amd64/container-shaped. Instead it needs
a termux-specific **native build of llama-swap** (compiled for the device), which
is what `openai-completions/` provides. Local llama.cpp inference is also
impossible, so serving is **peers-only** — no GGUF, no `llamacpp-model-data.json`
layer in `config.d/`.

- `run-native.sh` — no podman/docker, no GPU detection, no HF pre-cache, **no
  image pull**, and **no build/generate step**. It `exec`s the native termux
  llama-swap binary (built by `build.sh`'s termux branch, cross-built with
  `CGO_ENABLED=0 GOOS=android GOARCH=arm64` so the Android resolver is used
  instead of the missing `/etc/resolv.conf`) directly to serve the `config.d/`
  generated by `generate.sh` (which detects no container backend + no GPU and
  therefore emits the peers-only layers). Reads `LISTEN` from `.env` (default
  `:8080`); all other paths are derived from the script's own location, so there
  are no configurable path overrides. (The containerized `run.sh` is the
  multipurpose instance for bazzite/OCI-style hosts — same `config.d/` shape,
  containerized launch.)
- `generate-general.yaml.js` + `generate-peer-cloud.yaml.js` +
  `generate-gfx1030-models.mjs` — self-contained, split config generators that
  write `config.d/` (loaded via `-config-dir`); no dependency on the shared
  `cloud-llm/` generator. They emit peers under pi's default provider names
  (`openrouter`, `opencode`, `opencode-go`). See
  [d018-split-config-d.md](d018-split-config-d.md).
  `DISABLED_PROVIDERS`. _(The old `resolveApiKeyEnvName` / `__`-prefixed key
  convention is deprecated — generators now read plain `apiKeyEnv` names such as
  `OPENCODE_API_KEY`; see
  [d019-unified-opencode-key.md](d019-unified-opencode-key.md).)_

### wsl2 (nonfree-world, peer-only usage)
No fixed hostname (dynamic). Kernel: `6.18.33.2-microsoft-standard-WSL2`. WSL2 under rootful docker with **no direct cloud access**, so the coding agent
only ever talks to a peer endpoint. `coding-agent/` covers this via static
config (no Infisical-backed generation; a static pi `settings.json` +
`models.json`/`opencode.jsonc` that override the built-in providers with the
peer endpoint — `baseUrl` hardcoded, `apiKey` left as `$PEER_API_KEY` which pi
resolves from the env at request time).

- `.env` — `PEER_API_KEY` / `PEER_BASE_URL`. (`.env` is gitignored; copy the
  values locally. `PEER_BASE_URL` is currently informational — the peer baseUrl
  is hardcoded in the static provider config.)

The shared `container-tool.sh` makes this work on both bazzite-gfx1030-style podman and
wsl2-style docker through the same `sandbox_*` description: `sandbox_user` emits
`--userns=keep-id --user uid:gid` (plus `--group-add keep-groups`) on rootless
podman, and just `--user uid:gid` on rootful docker; SELinux relabeling is
automatic (`:z,U` on podman, `:z` on docker) with no per-script flags.

### oci-e21micro (Oracle Cloud, peer-only serving)
Hostname `instancepool-1-instance-1.subnetac1efe80.vcnac1efe.oraclevcn.com`. Shape: **VM.Standard.E2.1.Micro** (1/8 OCPU, 1 GB RAM). Tight memory
budget means **no local llama.cpp inference** (and no GPU); the host only
proxies cloud providers through llama-swap, just like the `wsl2` variant. The
difference from `wsl2` is the sandbox (OCI's rootless podman or docker, rather
than WSL2 rootful docker) and the image size constraint. Because OCI has no
dedicated inference device, the routing instance uses the lighter
`ghcr.io/mostlygeek/llama-swap:cpu` image (override with `LLAMA_SWAP_IMAGE`).

- **Serving** (`openai-completions/`): just `./generate.sh && ./run.sh` —
  generation detects no GPU (and therefore skips the local layer) and `run.sh`
  launches the CPU peers-only image, skips the HF cache tree, and loads the
  split peers-only `config.d/` with **zero local models** and only cloud peers.
- **Usage** (`coding-agent/`): static provider config pointing the agent at
  the peer endpoint, as on `wsl2`.
- **`.env.example`** at `openai-completions/.env.example` — documents the
  peers-only env vars (`LLAMASWAP_API_KEY`, `OPENROUTER_API_KEY`,
  `OPENCODE_API_KEY`, `DISABLED_PROVIDERS`).

This is the peers-only deployment documented as a first-class environment — the
realistic option for hosts that can't afford the `unified-vulkan` image or the
local GPU/VRAM (generate.sh simply never emits the local layer there).

> Note: `bazzite-gfx1030`, `a50-en7562ct`, and `oci-e21micro` are **static**
> reference hosts with known hostnames and hardware.  `wsl2` and `arm5` are
> **dynamic** — they have no fixed hostnames and are instantiated ad-hoc.

> **ARCHIVED** — the arm5/MikroTik-serving runner is no longer a development
> priority and moved to `old/openai-completions-arm5/` (with its tailscale
> helper at `old/tailscale-arm5/`). This section is kept as historical
> reference only; the live tree no longer ships `openai-completions-arm5/`.

### arm5 (MikroTik e50ug / RouterOS 7, peer-only serving)

Resource-constrained **router** (the e50ug) running MikroTik **RouterOS 7**
with its `container` package. No fixed hostname (dynamic). Like the a50-en7562ct/termux variant it is **peers-only**
— no local llama.cpp inference — but instead of a native Termux binary it is
packaged as a **RouterOS container image** (a `scratch` OCI image for
`linux/arm/v5`). The container runs on a **fully IPv6** network namespace and is
exposed to LAN + internet via the router's own services — **HTTPS through the
built-in `/ip/reverse-proxy`** (TLS terminated with a Let's Encrypt cert from
the built-in ACME client, DNS-01 so no inbound port is needed) forwarding to
the container's IPv6:8080, plus **SSH on port 3322**. LAN clients (a pi
coding-agent) point at `https://<ddnsname>/v1` as a peer endpoint, like the
`wsl2`/`oci-e21micro` usage side.

#### Device & limited specifications

| Spec | Value | Consequence |
|------|-------|-------------|
| SoC | MediaTek **EN7562CT**, ARM 32-bit | RouterOS on this SoC **only runs `arm32v5` container images** (MikroTik docs) — the image is built for `linux/arm/v5` (`GOARM=5`). |
| RAM | **512 MB** | No local llama.cpp; container `memory-max` capped well below this (default 192 MiB). |
| Storage | **128 MB** internal flash | Far too small for container images — `root-dir`/`tmpdir` must live on an **external USB disk** (`disk1`). |
| OS | RouterOS 7 (`container` package, device-mode `container=yes`) | Containers are imported/run via `/container`, not podman/docker. |

#### Why peers-only

Local GGUF inference is impossible (no GPU, 512 MB RAM, 128 MB storage), so
`openai-completions-arm5/` serves **cloud peers only** — the same peers the
a50-en7562ct/termux generator emits (OpenRouter free, OpenCode Zen/Go, …), proxied
through llama-swap. The config is a checked-in `config.d/` directory (split per
functionality; peers with `${env.*}` key references, no secrets baked in);
`build.sh` can optionally regenerate the live `/models` lists via the split
peer generators (`GEN_CONFIG=1`). See [d018-split-config-d.md](d018-split-config-d.md).

#### Build & packaging (`openai-completions-arm5/`)

`build.sh` cross-builds llama-swap for arm32v5 and packages it as a RouterOS
container image:

- **`Containerfile`** — multi-stage: a `golang:alpine` builder (pinned to the
  host platform via `--platform=$BUILDPLATFORM`, so it only *cross-compiles*;
  no qemu/emulation needed) builds a static `CGO_ENABLED=0 GOOS=linux
  GOARCH=arm GOARM=5` binary, then a `scratch` final stage copies the binary,
  the system **CA bundle** (so the proxy can verify TLS to upstream providers),
  and `config.d/` → `/app/config.d/` (loaded via `-config-dir`).
- **Output** — a `scratch` OCI image `llama-swap-arm5:latest` for
  `linux/arm/v5`, exported to **`llama-swap-arm5.tar`** via `docker save` /
  `podman save`. That tarball is the offline RouterOS format: `/container/add
  file=…` imports it with **no registry or internet from the router**.
- **Optional registry push** — set `REGISTRY=host:port/user` and `build.sh`
  also tags + pushes, for the `/container/add remote-image=…` alternative.

Tunables (env overrides): `ARM_PLATFORM` (default `linux/arm/v5`),
`GOARM` (default `5`), `LLAMA_SWAP_REF` (pin llama-swap tag/branch/commit),
`IMAGE_NAME`/`IMAGE_TAG`, `TARBALL`, `REGISTRY`.

#### Deploy (`.rsc`)

`deploy.rsc` is the RouterOS script that turns the tarball into a running,
IPv6-only, TLS-fronted container. It edits the `:local` variables at the top
(disk name, IPv6 ULA subnet, `ddnsname`, memory limits) then:

1. `/ip/cloud set ddns-enabled=yes` (the `*.sn.mynetname.net` DDNS name).
2. `/certificate/add-acme domain-names=<ddnsname>` — Let's Encrypt cert via
   **DNS-01** (no inbound port needed, works behind CGNAT).
3. `/container/config set tmpdir=` → extraction dir on the USB disk.
4. **IPv6-only bridge + veth** for the container: a ULA subnet
   (`fd52:abcd:1234::/64`, container `::2`, bridge gateway `::1`) — avoids
   IPv4 bridge NAT entirely. llama-swap listens on `[::]:8080` (IPv6 only,
   requires both the container and llama-swap to support IPv6 — they do).
5. `/ipv6/firewall/nat` masquerade so the ULA container reaches the IPv6
   internet (upstream LLM providers) out the WAN.
6. `/import file=example.auth.rsc` — creates the `llamaswap` `/container/envs`
   list with `LLAMASWAP_API_KEY` + provider keys (`OPENROUTER_API_KEY`,
   `OPENCODE_API_KEY`). (`example.auth.rsc` holds the credentials that get
   deployed; the old `.env`-style file is gone.)
7. `/container/add file=disk1/llama-swap-arm5.tar interface=veth-llamaswap
   root-dir=disk1/images/llamaswap cmd="-config-dir /app/config.d -listen
   [::]:8080" dns=<IPv6 resolvers> memory-max=201326592
   memory-high=134217728 …`, then `/container/start llamaswap`.
8. **HTTPS via the router's reverse proxy**: disable `www-ssl` (shares 443),
   `/ip/service set reverse-proxy certificate=<ddnsname> disabled=no`, and
   `/ip/reverse-proxy add sni=<ddnsname> ip-address=<container IPv6>
   port=8080`. The proxy listens on 443; this home ISP blocks serving on 443,
   so external traffic uses **3443**, dst-natted (marked) to 443 — direct WAN
   443 stays closed. → external `https://<ddnsname>:3443/`, internal
   `https://<ddnsname>/` (443) both proxy to llama-swap IPv6:8080.
9. **SSH on 3322 — separate file**: the SSH exposure (`/ip/service set ssh
   port=3322`, external + internal; external is *only* 3322) is in `ssh.rsc`,
   kept apart from the container deployment as a different concern.
10. `/ip/firewall/filter` accepts `input` tcp/443 and tcp/3322 from both WAN
    and LAN — this is the "hairpin": a router-hosted service is reached by
    LAN clients via the DDNS name simply by allowing input from the LAN
    interface (the docs' dst-nat hairpin is only for hosts *behind* the
    router).

The service is reachable at `https://<ddnsname>:3443/v1` (WAN) and
`https://<ddnsname>/v1` (LAN, port 443); SSH at `<ddnsname>` on **3322** (see `ssh.rsc`). A pi
`models.json` peer override points `baseUrl` there with `apiKey:
$LLAMASWAP_API_KEY`. Prerequisites (container package, device-mode
`container=yes`, external USB disk, **IPv6 internet on the router**) are listed
as comments at the top of `deploy.rsc`.

#### Relationship to the other variants

- **Like a50-en7562ct/termux** — peers-only serving, no local GGUF; the *same* peer
  config shape. Difference: packaged as a RouterOS `scratch` container image
  (cross-compiled, CA bundle baked in) instead of a native Termux binary.
- **Like wsl2 / oci-e21micro** — the *usage* side is peers-only: a LAN pi agent talks
  to this container as a peer endpoint rather than directly to paid clouds.
- **Unlike bazzite-gfx1030** — no SELinux/UID mapping, no podman, no local models;
  the runtime is RouterOS's own container engine on a 512 MB router.

## Shared support file

`container-tool.sh` (repo root) is a **description-driven sandbox runner**: run
scripts declare *what* they need and the tool renders *how* for the active
backend — rootless podman or rootful docker — hiding every backend quirk (SELinux
`:z`/`:U` relabel + chown-to-subuid, `--userns=keep-id` vs rootful `--user`,
GPU device passthrough, port publishing, hardening) behind one interface. It is
the single place that detects the backend and computes `SCRIPT_DIR` / `REPO_ROOT`
(the only "where do I live" logic), so run scripts never re-detect podman/docker
or guess their own paths inline. PRoot was removed as a backend (see
[container-tooling.md](container-tooling.md)); a qemu/libvirt VM backend is
assessed in [d020-libvirt-qemu-sandbox.md](d020-libvirt-qemu-sandbox.md).

See [container-tooling.md](container-tooling.md) for the full `sandbox_*` API.

## Image / mode per instance

There is ONE multipurpose serving folder and no `PEERS_ONLY` toggle — the mode
falls out of what `generate.sh` emitted into `config.d/` (the port does not:
it is always LAN **8080**):

- **local layer present** (`10-local-llm-inference.yaml`): `run.sh` uses
  `ghcr.io/mostlygeek/llama-swap:unified-vulkan` (local llama.cpp needs the
  GPU/Vulkan runtime), passes GPU devices through, and mounts the HF cache
  tree.
- **peers-only**: `run.sh` defaults to the lighter
  `ghcr.io/mostlygeek/llama-swap:cpu` image (no local llama.cpp, no HF cache,
  no GPU passthrough). Override with `LLAMA_SWAP_IMAGE` / `HOST_PORT`.

Either way llama-swap is launched with `-config-dir <dir>/config.d`. The
a50/termux path has no container and no image selection — it is peers-only by
construction (no container backend + no GPU detected) via
`openai-completions/run-native.sh`.
