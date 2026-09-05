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

See [termux-serving.md](termux-serving.md) for the a50/termux map — the
build/serve/env detail lives in the `openai-completions/` script headers it
points at.

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
| `sandbox_ro_if <host> <guest>` | optional variant (skipped if host path absent) |
| `sandbox_env <NAME...>` | pass these host env vars into the sandbox (`--env`) |
| `sandbox_cmd <args...>` | the command (argv after the image) |
| `sandbox_has <field>` | true when a description array is non-empty — e.g. `sandbox_has devices`, which is how `openai-completions/generate.sh` gates the local-inference layer |
| `sandbox_rm <id>` | remove a prior instance by name |
| `sandbox_logs <id>` | tail a running instance's logs |
| `sandbox_run [wrapper...]` | render + launch; optional `wrapper` prefixes the launch command. Host-side only — it cannot inject env into the sandbox; secrets reach the sandbox via the `sandbox_env` allowlist (see `coding-agent/run.sh`: host `load_secrets` → forwarded vault keys) |

Only `sandbox_ro`/`sandbox_rw` (required) abort the run if the host path is
gone; `sandbox_ro_if` is best-effort. Mount host/guest paths may contain
spaces — see the description model below; they are re-emitted as distinct quoted
words, so splitting is safe at launch.

SELinux handling is automatic and matches the original inline flags exactly:
on podman every mount gets `:z,U` (shared relabel + chown to the mapped
subuid, so files land back on the real user rather than a raw subuid), with
`,ro` added for read-only mounts; on docker mounts get `:z` (`,ro` for ro). The
`U` is what keeps rootless podman from chowning all the user's files into the
subuid range.

### Description model: scalars in shell, lists in JSON

The description is held in two halves:

- **Scalars** — one shell global each (`_SB_NAME`, `_SB_IMAGE`, `_SB_NETWORK`,
  …). They are plain strings and 0/1 flags with no data-structure problem, so
  jq would only add a subprocess. **An empty string means “not set”**: the
  renderer omits the flag entirely rather than passing an empty value.
- **Lists** — mounts, env names, ports, devices and command words live in ONE
  JSON document (`_SB_LISTS`), because these are the values that used to be
  `eval`-emulated arrays or space-joined strings word-split at render time.
  Word-splitting an unquoted expansion is a bash/dash behaviour, not a shell
  one — zsh does not do it — so that form was silently dialect-dependent. jq
  behaves identically whichever shell called it, and `--arg` carries values
  with no shell quoting at all.

Each list mutator is one small jq filter in `lib/`, and **each filter's header
is its specification** — expected inputs, output shape, and why it exists:

| Filter | Called by | Contract |
|---|---|---|
| `lib/sandbox-mount.jq` | `sandbox_ro` / `sandbox_rw` / `sandbox_ro_if` | append `{mode,host,guest}` to `.mounts` |
| `lib/sandbox-append.jq` | `sandbox_env`, `detect_gpu_devs` | append strings to a named array (`.env`, `.devices`) |
| `lib/sandbox-port.jq` | `sandbox_publish` | append `{host,guest}` to `.ports` |
| `lib/sandbox-cmd.jq` | `sandbox_cmd` | **set** `.cmd` to the word array (a set, not an append) |
| `lib/sandbox-has.jq` | `sandbox_has` | boolean; the answer is jq's `-e` exit status |
| `lib/sandbox-render.jq` | `_render_container` | the whole description + scalars → one line of `@sh`-quoted argv words |

Two jq invocations rules that are easy to get wrong, and that every filter
header repeats:

- `--args` **must be followed by a bare `--`**. jq keeps parsing options after
  `--args`, so `sandbox_cmd -config-dir …` is otherwise read as jq flags
  ("Unknown option -o").
- any filter that takes its input from `--argjson` rather than stdin **must be
  run with `jq -n`**, or it waits on stdin and never produces output.

**Dependency:** jq is required by the `sandbox_*` calls only — scripts that
source `container-tool.sh` just for `log_*` or `load_secrets` never touch it,
and the lookup is lazy (it fails on first use, not at source time).
Provisioned in `mise.toml` (host), `coding-agent/config.toml` (image), and
`pkg install jq` on Termux. `coding-agent/run.sh` bind-mounts every
`lib/sandbox-*.jq` into `/opt/lib`, since inside the container `REPO_ROOT` is
`/opt`.

**Tests:** `./tests/check-sandbox.sh` renders two full descriptions (one per
backend) and diffs the argv against the pre-refactor output, plus the
`sandbox_has` predicate. It is a differential test: it exists because the two
bugs found during this refactor were semantic, and neither the shellcheck nor
the jq compile gate in `./lint.sh` can see them.

### `sandbox_run` backend

**container** (`podman`/`docker`): renders `container run` with the described
mounts/ports/env/user/hardening, then launches it (optionally wrapped by a
host-side command — historically `infisical run … --`; the coding-agent now
loads vault secrets on the host via `load_secrets` and forwards them through
`sandbox_env`, so the sandbox itself never runs infisical). Any other
`_sandbox` value is a fatal error — there is no fallback "sandbox" that isn't
one.

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
  `generate-local-llm-models.yaml.mjs`; the static HF-snapshot resolver is
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
  `build.sh` (native binary on termux, image pull elsewhere) + `run-native.sh` (bare serve) instead,
  and the root `./build.sh` to provision the Infisical CLI there.
  See [termux-serving.md](termux-serving.md) (a map; detail in the script
  headers).

### `coding-agent/run.sh` (bazzite usage)

Launches the pi coding-agent container with:

- **`settings.json`** (static): copied into `~/.pi/agent/settings.json`
  (retry config, display settings) and mounted read-only into the sandbox, so
  the in-container `generate.sh` reinstalls it from the same source; a committed
  `models.json`/`opencode.jsonc` are staged as fallback until the in-container
  generation succeeds.
- **Secrets**: loaded ONCE on the HOST via `load_secrets` (one cached
  `infisical secrets --output=dotenv`) and forwarded into the container
  through the `sandbox_env` allowlist — no infisical runs inside the sandbox,
  no `~/.infisical` staging; pi resolves the `"$VAR"` api-key references in
  the generated `models.json` from the forwarded environment at request time.
- **Mounts**: workspace, generated `.pi` agent dir, opencode config/data dirs
  and the HF cache (writable), references dir (read-only), the generator input
  set at `/opt/coding-agent` + `/opt/lib` and the generated launch chain
  (read-only), `--network=host`.  The generator input set is mounted file by
  file, never as the repo dir, so the list in
  `run.sh` must cover **every** input `generate.sh` reads from its own dir:
  inside the sandbox `container-tool.sh` resolves `SCRIPT_DIR` from `$0` to
  `/opt/coding-agent`, and an unlisted file aborts the in-container generation
  on first read (historically `settings.json`, which killed the run before any
  generation stage and left the staged fallback config silently in place).

Uses `--userns=keep-id` + `--user $(id -u):$(id -g)` so files written into
bind-mounted dirs are owned by the host user.

### `coding-agent/run.sh` (work / peers-only usage)

`coding-agent/` covers the work/WSL2 case with static config instead of a
separate `coding-agent-peer/` folder: a static `settings.json` and
`models.json`/`opencode.jsonc` overriding the built-in `opencode` /
`opencode-go` providers with the peer endpoint (`baseUrl` hardcoded, `apiKey`
as `$PEER_API_KEY` resolved by pi at request time from the container env).

**Env**: `PEER_API_KEY` and `PEER_BASE_URL`, exported into the process
environment — Infisical via `load_secrets`, or exported by hand. No `.env`
file is read any more (the old `ENV_FILE` / `<dir>/.env` fallbacks were
removed). `PEER_BASE_URL` is informational — the peer baseUrl is hardcoded in
the static provider config.

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
