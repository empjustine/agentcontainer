# Sandbox helper — environment analysis

> **SUPERSEDED (2026-08-30).** Written when PRoot was still a supported
> backend. PRoot has since been **removed** from `lib/workload-runtime.sh` (ptrace
> path translation is not isolation; `run-proot.sh` and the `workload_native`
> / `proot_run` API are gone — termux serves natively via
> `openai-completions/run-native.sh`), and the serving tree was squashed into
> the multipurpose `openai-completions/`. Sections 2–3 below remain the
> definitive record of *why* PRoot is not a workload; sections 1 and 4
> describe an API that no longer exists. A stronger-than-container backend
> (qemu/libvirt) is assessed in [d020-libvirt-qemu-sandbox.md](d020-libvirt-qemu-sandbox.md).

Verification of the then-current use of the shared workload helper
(`lib/workload-runtime.sh`, repo root) across the run scripts, and an assessment of
whether a specialized Go helper would be the right abstraction for the three
distinct target environments:

- **rootful docker** (e.g. WSL2 "work" host)
- **rootless podman** (bazzite, SELinux enforced)
- **rootless bionic Termux** (only semi-usable workloading primitive is proot)

References used: `89luca89/lilipod` (a from-scratch Go container engine),
`termux/proot` (the C ptrace workload), and `termux/proot-distro` (the Python
OCI-image frontend over `proot`).

## 1. Current use-cases of the workload helper

All run scripts source `../lib/workload-runtime.sh` and use the declarative
`workload_*` API. The three named scripts only ever exercise the **container**
backend (podman or docker); the **proot** backend is reached by
`openai-completions-peer/run-proot.sh`, and the Termux native path bypasses
the helper entirely (`openai-completions-peer/run-native.sh`).

### `workload_*` inventory (the three named scripts)

| API call | `coding-agent/run.sh` | `gfx1030/run.sh` | `peer/run.sh` |
|---|---|---|---|
| `workload_rm` | – | ✅ | ✅ |
| `workload_name` / `workload_image` | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ |
| `workload_interactive` | ✅ | – | – |
| `workload_detach` | – | ✅ | ✅ |
| `workload_init` | ✅ | ✅ | ✅ |
| `workload_network host` | ✅ | – | – |
| `workload_user` | ✅ | ✅ | ✅ |
| `workload_gpu` | – | ✅ | – |
| `workload_publish` | – | ✅ `18080:8080` | ✅ `8080:8080` |
| `workload_ro` | – (ro_if only) | ✅ config.d | ✅ config.d |
| `workload_rw` | ✅ ×3 (HF, agent, workspace) | ✅ ×2 (HF `/root`+`/home/ubuntu`) | – |
| `workload_ro_if` | ✅ references | – | – |
| `workload_workdir` | ✅ | – | – |
| `workload_hardening` | – | ✅ | ✅ |
| `workload_env` | ✅ ×5 keys | ✅ ×5 keys | ✅ ×3 keys |
| `workload_entrypoint` | – | ✅ `llama-swap` | ✅ `llama-swap` |
| `workload_cmd` | ✅ `bash` | ✅ `-config-dir …` | ✅ `-config-dir …` |
| `workload_logs` | – | ✅ | ✅ |
| `workload_run [wrapper]` | ✅ infisical | ✅ infisical | ✅ infisical |

Host-side prep *outside* the helper: `coding-agent` runs `generate.sh` + copies
`settings.json`/`models.json` into the mounted `~/.pi/agent` and refuses to run
from `$HOME`; the two serving scripts do `infisical login status` then
`workload_rm` + `sleep 5; workload_logs | head`.

### How `lib/workload-runtime.sh` handles the three environments today

Backend divergence is small:

- **rootless-podman vs rootful-docker** — detected in `detect_container_tool()`;
  the only differences are three globals: `--userns=keep-id` +
  `--group-add keep-groups` (podman) vs none (docker), and the mount label
  `z,U` (podman) vs `z` (docker) in `_render_mount`
  (`lib/workload-runtime.sh` `_render_container` / `_render_mount`). That `U` is the
  one genuinely important rootless detail — without it rootless podman chowns
  your files into the subuid range.
- **Termux/proot** — a separate renderer (`_render_proot` → `proot_run`) using
  `workload_native` (a host binary, not an image), `-b` binds, no
  GPU/hardening/ports. Three sub-modes: `proot -R <rootfs>` (rootfs present) ›
  `termux-chroot` › `proot -0` (minimal fake root).

Key finding: **none of the three named scripts exercises the proot path.**
`workload_native` is only called by `openai-completions-peer/run-proot.sh`, and
`run-native.sh` does not source the helper at all
(`exec ~/ls-build/llama-swap-termux …`).

## 2. The Termux environment is a different class of primitive

`proot-distro` (Python, depends on the C `proot`) pulls/assembles Docker/OCI
images and enters them via `proot` — the Termux analog of `podman run`. Its own
Limitations section (`termux/proot-distro/README.md`) is decisive:

- proot intercepts **every syscall via `ptrace`** (path translation, not kernel
  isolation)
- **no real root** — UID/GID remapping only ("fake root")
- **no cgroups / no namespaces** — `unshare`, network namespaces,
  container-in-container "do not work"
- **no nesting**, **no GPU device passthrough**

So the three targets are not three flavors of one mechanism:

| Environment | Mechanism | Kernel namespaces/cgroups | Real root | Image model |
|---|---|---|---|---|
| rootful docker | real runtime | ✅ | ✅ | OCI |
| rootless podman (bazzite, SELinux) | real runtime | ✅ | ✅ (keep-id) | OCI |
| rootless bionic Termux | **ptrace + fake-root** | ❌ | ❌ | OCI-via-proot-distro or native binary |

## 3. Would a specialized Go helper unify the three? — No

1. **Different primitive class.** docker/podman use real kernel namespaces +
   cgroups (+ SELinux on bazzite). Termux uses ptrace path translation. A Go
   binary cannot subsume ptrace-emulation the way it might subsume a userns
   engine on Linux.
2. **On Termux, Go can only shell out.** `proot` is a mature **C** project
   (`src/ptrace`, `src/tracee`, `src/syscall`, `src/loader`, `src/execve`…);
   `proot-distro` is **Python**. Reimplementing proot's ptrace layer in Go is
   not realistic, and the Termux ecosystem itself is C+Python — a Go helper
   would be a redundant orchestration layer over tools it cannot replace.
3. **proot-distro already provides the Termux image workflow** as a C/Python
   tool. A Go helper would just re-orchestrate `proot`/`proot-distro`, which is
   exactly what `lib/workload-runtime.sh` already does via `proot_run()`.
4. The only place a Go helper *might* help is the **Linux** axis — a
   lilipod-style userns engine (`unshare`+`pivot_root`+`newuidmap`,
   `keepCaps`; see `89luca89/lilipod` `pkg/procutils.EnsureFakeRoot`,
   `cmd/rootless_helper.go`, `containerutils.PivotRoot`). But: (a) it is a
   strategic, large rewrite; (b) it drops podman's native **SELinux** `:z,U`
   labeling that bazzite relies on; (c) **Termux stays a delegated proot path
   either way**. One Go binary still does not cover all three.

**Verdict: a specialized Go helper is not the right unification primitive for
these three environments.** The Termux path is irreducibly "delegate to
proot/proot-distro"; a Go rewrite improves nothing there and is disproportionate
on the Linux side.

## 4. Recommended work (shell-level, against the existing helper)

The declarative `workload_*` API is the correct abstraction (intent, not
backend). Keep it; extend the Termux axis:

1. **Explicit, overridable backend** — `SB_BACKEND=podman|docker|proot|proot-distro`
   (auto-detect today). Fail fast on intent/backend mismatch (e.g.
   `workload_image` under a proot-only detection, or `workload_native` under
   container detection) instead of the current late `workload_run` fatal.
2. **Add a `proot-distro` tier** so `workload_image` on Termux maps to
   `proot-distro run <image>` (pulls/assembles the OCI image, enters via proot)
   — giving Termux the same image-based workflow as bazzite/work, instead of
   the current `workload_native`-only host-binary path (`run-proot.sh`). Caveats
   from proot-distro Limits: no **zstd** layers, ptrace perf cost, no nesting,
   and **no GPU passthrough** → `gfx1030/unified-vulkan` is not viable on
   Termux (consistent with `docs/termux-serving.md`: Termux is peers-only,
   CPU/native only).
3. **Capability matrix** (document it): under proot, `workload_gpu` and
   `workload_hardening` are N/A, `workload_publish` is irrelevant (the binary
   binds directly), and proot has no read-only binds.
4. Keep `run-proot.sh` (`workload_native`) and `run-native.sh` as-is — correct
   for the Termux native-binary case.

The current `lib/workload-runtime.sh` already delegates Termux correctly; the gap is
that the three named run scripts only touch the container backend, and Termux's
image path is not yet wired to `proot-distro`. Both are shell fixes, not a Go
engine.

## 5. References

- `lib/workload-runtime.sh` (repo root) — description-driven workload runner.
- `docs/lib/workload-runtimeing.md`, `docs/termux-serving.md` — existing environment docs.
- `89luca89/lilipod` — Go userns engine (rootful/rootless Linux only; not Termux).
- `termux/proot` — C ptrace workload (the Termux primitive).
- `termux/proot-distro` — Python OCI-image frontend over `proot`.
