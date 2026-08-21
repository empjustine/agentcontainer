# Container tooling & run scripts

This covers the shared container-runtime detection (`container-tool.sh`), the
deployment environments (bazzite, a50, work), and the run scripts that launch
the llama-swap serving container and the pi coding-agent container.

## Environments

| Name    | Sandbox / runtime                          | Cloud access | Serving dir                     | Usage dir              |
|---------|--------------------------------------------|--------------|---------------------------------|------------------------|
| bazzite | rootless podman, SELinux enforced          | direct       | `openai-completions/`           | `coding-agent/`        |
| a50     | rootless termux, restrictive SELinux,      | direct (if   | `openai-completions/` (native)  | `coding-agent/`        |
|         | non-standard file paths                    | any)         |                                 |                        |
| work    | WSL2 rootful docker, no direct cloud       | peers only   | `openai-completions/` (peer-only) | `coding-agent/` (static config) |

### bazzite (full, default)

The reference environment. Runs **one** multipurpose llama-swap instance,
`openai-completions/` — `generate.sh` detects the container backend + GPU
devices and emits both the local GGUF layer and the cloud-peer layer into
`config.d/`; `run.sh` launches the `unified-vulkan` image with GPU passthrough
+ HF cache on LAN port 8080 — plus the full `coding-agent/`. Rootless podman
with SELinux means every writable bind mount gets `:z,U` (or `:Z,U`) relabel +
chown, and the containers run as the host UID via `--userns=keep-id` +
`--user $(id -u):$(id -g)`.

### a50 (termux, peer-only serving)

Resource-constrained host (phone/router under Termux). It **cannot run the
`openai-completions` llama-swap container** — Termux has no usable podman/docker
and the image is amd64/container-shaped. Instead it needs a termux-specific
**native build of llama-swap** compiled for the device. Local llama.cpp inference
is also impossible, so `generate.sh` (which detects no container backend + no
GPU) emits a **peers-only** `config.d/` — no GGUF layer, no
`llamacpp-model-data.json` usage.

See [termux-serving.md](termux-serving.md) for the full a50/termux documentation.

### work (nonfree-world, peer-only usage)

WSL2 under rootful docker with **no direct cloud access**, so the coding agent
only ever talks to a peer endpoint. Covered by `coding-agent/` static config
(see the run-scripts section below).

## Shared support: container-tool.sh (description-driven)

`container-tool.sh` (repo root) is a **description-driven sandbox runner**, not a
bag of flags. Run scripts declare *what* they need; the tool renders *how* for
the active backend — podman or docker — hiding every backend quirk (SELinux
`:z`/`:U` relabel + chown-to-subuid, `--userns=keep-id` vs rootful `--user`, GPU
device passthrough, port publishing, hardening) behind one interface. No
`:z${_vol_u}` strings, no inline `podman`/`docker` detection, no
`cd "$(dirname "$0")"` path-guessing leak into the run scripts.

> **PRoot backend removed.** A PRoot backend (`detect_proot` / `sandbox_native`
> / `proot_run`) used to confine host binaries on Termux. It is gone: PRoot is
> ptrace-based path translation, not isolation — no kernel namespaces, no
> cgroups, no real root, no GPU passthrough, no read-only binds — so calling it
> a "supported sandbox" was a lie the tree no longer tells. Termux serves
> natively via `openai-completions/run-native.sh` (the binary talks to the
> network directly; there is nothing to confine that the shell couldn't).
> For a stronger-than-container option on capable hosts, see
> [d020-libvirt-qemu-sandbox.md](d020-libvirt-qemu-sandbox.md).

Source it from any `run*.sh` (it lives one level up, at the repo root):

```sh
. "$(dirname "$0")/../container-tool.sh"
```

On source it detects the backend and computes two paths every run script uses
(instead of recomputing them per script):

- `SCRIPT_DIR` — directory of the sourcing run script (from `$0`)
- `REPO_ROOT`  — its parent (the repo root)

It also sets `_sandbox` (`container` › `none`) and, for the container
backend, `_container_tool` (`podman`/`docker`) — but run scripts should not read
these directly; they describe intent via the API below. (Capability probing in
`openai-completions/generate.sh` legitimately reuses the internals —
`_sandbox` + `detect_gpu_devs` — to decide which config layers the host can
run.)

### Declarative API

| Call | Meaning |
|------|---------|
| `sandbox_name <n>` | container / instance name |
| `sandbox_image <img>` | OCI image to run |
| `sandbox_detach` / `sandbox_interactive` | `-d` / `-it` |
| `sandbox_init` | `--init` |
| `sandbox_network <mode>` | e.g. `host` → `--network=host` |
| `sandbox_user` | run as the host user: `--userns=keep-id --user uid:gid` (podman) or `--user uid:gid` (docker). Uses `SUDO_UID`/`SUDO_GID` when present. |
| `sandbox_gpu` | detect + passthrough GPU devices (`/dev/kfd`, `/dev/dri/renderD*`) |
| `sandbox_hardening` | `--cap-drop=all --security-opt no-new-privileges` |
| `sandbox_publish <host> <guest>` | `-p host:guest/tcp` |
| `sandbox_ro <host> <guest>` | required read-only bind (fails if host path missing) |
| `sandbox_rw <host> <guest>` | required read-write bind |
| `sandbox_ro_if` / `sandbox_rw_if` | optional variants (skipped if host path absent) |
| `sandbox_env <NAME...>` | pass these host env vars into the sandbox (`--env`) |
| `sandbox_env_set <NAME=val...>` | set env vars inside the sandbox |
| `sandbox_workdir <path>` | `--workdir` |
| `sandbox_cmd <args...>` | entrypoint / binary arguments |
| `sandbox_rm <id>` | remove a prior instance by name |
| `sandbox_logs <id>` | tail a running instance's logs |
| `sandbox_run [wrapper...]` | render + launch; optional `wrapper` (e.g. `infisical run --env=prod --path=/inference --`) prefixes the launch command |

Only `sandbox_ro`/`sandbox_rw` (required) abort the run if the host path is
gone; the `*_if` variants are best-effort. Mount host/guest paths may contain
spaces — they are stored in an indexed list and re-emitted as distinct quoted
words, so splitting is safe at launch.

SELinux handling is automatic and matches the original inline flags exactly:
on podman every mount gets `:z,U` (shared relabel + chown to the mapped
subuid, so files land back on the real user rather than a raw subuid), with
`,ro` added for read-only mounts; on docker mounts get `:z` (`,ro` for ro). The
`U` is what keeps rootless podman from chowning all the user's files into the
subuid range.

### `sandbox_run` backend

**container** (`podman`/`docker`): renders `container run` with the described
mounts/ports/env/user/hardening, then launches it (optionally wrapped by
`infisical run … --`). Any other `_sandbox` value is a fatal error — there is
no fallback "sandbox" that isn't one.

## Run scripts

### Serving run script (one multipurpose instance)

Every host runs ONE llama-swap serving container, launched by
`openai-completions/run.sh` (sources `container-tool.sh`). `run.sh` is
serve-only: it mounts the already-generated `config.d/` (read-only) loaded via
`-config-dir` and adapts to it. Generation lives in `openai-completions/generate.sh`.

#### `openai-completions/generate.sh` (capability-gated layers)

The openai-completions analog of `coding-agent/generate.sh`: generators emit
layers, and only the layers that work on the current host land in `config.d/`
(stale layers from a previous capability set are removed):

- `00-general.yaml` — always (globals + macros; harmless when no local models
  reference them).
- `10-local-llm-inference.yaml` + `launch-gguf.sh` — only when the container
  backend is available AND GPU devices (`/dev/kfd`, `/dev/dri/renderD*`) are
  present. The GGUF layer is built from `llamacpp-model-data.json` by
  `generate-local-llm-models.yaml.js`; the static HF-snapshot resolver is
  copied from the folder root into `config.d/`.
- `peer-cloud.yaml` — whenever any cloud provider answers; providers without
  keys or with failing fetches are skipped independently, and a stale output
  is removed when none answer.
- `22-peer-gfx1030.yaml` — only on hosts that do NOT serve local models
  natively; probes `$PEER_BASE_URL`, then the bazzite tailscale URL (the
  world-visible FQDN funnel of the LAN :8080 instance) for a live
  local-inference instance. localhost candidates are NOT probed (the legacy
  :18080 local-inference port is deprecated).

See [d018-split-config-d.md](d018-split-config-d.md) for the merge contract.

#### `openai-completions/run.sh` (serve-only, adapts to config.d)

- **Image**: `ghcr.io/mostlygeek/llama-swap:unified-vulkan` when the local
  layer is present (local llama.cpp needs the GPU/Vulkan runtime); otherwise
  the lighter `ghcr.io/mostlygeek/llama-swap:cpu` (override with
  `LLAMA_SWAP_IMAGE` in both cases).
- **HF cache**: mounted (rw) only in local mode — `llama-server` resolves and
  caches GGUF files on demand.
- **GPU**: detects usable dedicated inference devices — any DRM render node
  `/dev/dri/renderD*` (Vulkan) and `/dev/kfd` (ROCm) — and passes each through
  to the container (local mode only).
- **Port**: LAN **8080** in both modes (`HOST_PORT` overrides). The container
  always listens on 8080 internally; the world reaches the same catalog via
  the tailscale FQDN reverse proxy (normal https port) forwarding to 8080.
  The legacy local-inference port 18080 is deprecated — nothing listens on
  it since the two-instance squash.
- **SELinux**: all bind mounts are relabeled + chowned to the mapped subuid
  by `container-tool.sh` (`:z,U` on podman, `:z` on docker) — no inline flags.
- **Termux alternative**: on a50/termux there is no container — use
  `build.sh` (native binary on termux, image pull elsewhere) + `run-native.sh` (bare serve) instead.
  See [termux-serving.md](termux-serving.md).

### `coding-agent/run.sh` (bazzite usage)

Launches the pi coding-agent container with:

- **`settings.json`** (static): copied into `~/.pi/agent/settings.json`
  (retry config, display settings).
- **`auth.json`** (pi credentials): copied into `~/.pi/agent/auth.json`; pi
  resolves provider keys from it at runtime, replacing the old `.env` +
  generated-`models.json` (with `$VAR` api keys) approach.
- **Mounts**: workspace bind (writable), references dir (read-only),
  generated `.pi` agent dir (writable), HF cache (read-only), repo root
  (read-only), `--network=host`.

Uses `--userns=keep-id` + `--user $(id -u):$(id -g)` so files written into
bind-mounted dirs are owned by the host user.

### `coding-agent/run.sh` (work / peers-only usage)

`coding-agent/` covers the work/WSL2 case with static config instead of a
separate `coding-agent-peer/` folder: a static `settings.json` and
`models.json`/`opencode.jsonc` overriding the built-in `opencode` /
`opencode-go` providers with the peer endpoint (`baseUrl` hardcoded, `apiKey`
as `$PEER_API_KEY` resolved by pi at request time from the container env).

**Env file**: `coding-agent/.env` with `PEER_API_KEY` and
`PEER_BASE_URL` (gitignored; `PEER_BASE_URL` is informational — the peer
baseUrl is hardcoded in the static provider config).

## Image / mode per instance

There is ONE multipurpose serving folder and no `PEERS_ONLY` toggle — the mode
falls out of what `generate.sh` emitted into `config.d/`:

- **local layer present** (`10-local-llm-inference.yaml`): `run.sh` uses
  `ghcr.io/mostlygeek/llama-swap:unified-vulkan`, passes GPU devices through,
  and mounts the HF cache tree.
- **peers-only**: `run.sh` defaults to the lighter
  `ghcr.io/mostlygeek/llama-swap:cpu` image.

Either way the instance publishes LAN port **8080** (`HOST_PORT` overrides).

Either way llama-swap is launched with `-config-dir <dir>/config.d`. The
a50/termux path has no container at all — it is peers-only by construction
via `openai-completions/run-native.sh`.
