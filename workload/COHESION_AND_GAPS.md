# Cohesion Gaps & Prior-Art Clone Verification

## Cohesion Recommendations (Points 3–6) — K8s/Podman Manifest Extensions

Given the adopted format is Kubernetes-inspired / Podman-extended manifest,
make the remainder cohesive by extending `spec`, not replacing it.

### 3. Systemd Quadlets (ORCHESTRATION_PRIOR_ART.md §1.2)
- Add generator annotation or `systemd` manifest block:
  - `metadata.annotations["workload.mostlygeek.io/generate-systemd"]`
  - Produces `.service`, `.volume`, `.timer`, `.path`, `.container` units.
- Map `spec.template` → `.container` content; `metadata.name` → unit basename.
- Keeps YAML manifest as single source of truth.

### 4. Overlay / Runtime Isolation (OVERLAY_RUNTIMES.md §7, §8)
- Extend container/template spec with:
  - `spec.runtime.overlay.type`: `ld-library-path` | `bind-overlay` | `appimage` | `bundle`
  - `spec.runtime.overlay.directories`: list of `source` / `destination`
  - `spec.runtime.overlay.compatibility`: `{glibc, cuda, python}` (ManyLinux-style tags)
- Link overlay directories to existing `volumes[].hostPath` so mounts are declarative.

### 5. Termux-Runsv Directory Fallback (ADDITIONAL_PRIOR_ART.md §2)
- Add native execution mapping:
  - `spec.runtime.native.serviceDir`: `/var/service/<metadata.name>`
  - `spec.runtime.native.mode`: `loop` | `once` | `downforce`
- Pair with CLI interface (`workload svc up/down/once <name>`) mapped to manifest lifecycle.
- Generates `run` script in service directory for `runit` (`runsv`/`runsvdir`) supervision.

### 6. Sandbox Primitive Mappings (SANDBOX_PRIMITIVES.md §9, §11)
- Explicitly bind manifest to primitives:
  - `spec.template.spec.containers[*].runtime`: `auto` | `podman` | `bwrap` | `proot` | `native`
  - `sandbox.namespaces`: `{user, pid, net, ipc, uts, cgroup}` (boolean map)
  - `sandbox.mounts`: array of `source`, `destination`, `readonly`, `type`
  - `sandbox.seccomp`: `default` | `none` | profile reference
  - `resources`: map container limits (`memory`, `cpu`) and native/sandbox equivalents (`amd.com/gpu`, etc.)
- Uses Kubernetes `securityContext` / `capabilities` analogs for capability dropping.

---

## Prior-Art Mirror Clone Verification (`~/Downloads/references/github/`)

### Explicitly referenced in workload docs (github.com URLs)

| Repository | Clone Status | Notes |
|---|---|---|
| `F1bonacc1/process-compose` | Present (nested under `F1bonacc1`) | YAML process orchestration |
| `gokrazy/gokrazy` | Present (nested under `gokrazy`) | Go supervision loop |
| `termux/termux-services` | **MISSING** | Termux service daemon / `runit` wrapper |
| `AppImage/AppImageKit` | **MISSING** | Self-extracting overlay runtime |
| `ValveSoftware/steam-runtime` | **MISSING** | Steam Runtime (Soldier/Snappy) |
| `ValveSoftware/steam-runtime-tools` | **MISSING** | Pressure Vessel / Syzygy |
| `caddyserver/caddy` | Present (`caddyserver/caddy`) | Graceful lifecycle |
| `debuerreotype/debuerreotype` | Present (`debuerreotype/debuerreotype`) | Reproducible rootfs |
| `hashicorp/serf` | Present (`hashicorp/serf`) | Cluster membership |
| `jdx/mise` | Present (`jdx/mise`) | Dev env / tasks |
| `jpillora/chisel` | Present (`jpillora/chisel`) | Tunneling |
| `ko-build/ko` | Present (`ko-build/ko`) | Go binary → container image |
| `love2d/love-android` | Present (nested under `love2d`) | Android runtime lifecycle |
| `mozilla-ai/otari` | Present (`mozilla-ai/otari`) | Overlay architecture pattern |
| `mvdan/sh` | Present (nested under `mvdan`) | Shell parser |
| `pypa/manylinux` | **MISSING** | Python manylinux standard |
| `vercel-labs/ai-python` | Present (`vercel-labs/ai-python`) | Agent runtime |
| `NixOS/nix` | Present (`NixOS/nix`) | Functional package manager |
| `k3s-io/k3s` | Present (`k3s-io/k3s`) | Edge Kubernetes |

### Referenced in docs without github URLs

| Project | Reference Location | Status in Downloads | Suggested Mirror URL |
|---|---|---|---|
| **k0s** | `ORCHESTRATION_PRIOR_ART.md` §3.1 | **MISSING** | `k0sproject/k0s` |
| **lilipod** | `ORCHESTRATION_PRIOR_ART.md` §3.2 | **MISSING** | `89luca89/lilipod` |
| **systemd** | `ORCHESTRATION_PRIOR_ART.md` §1, §1.3 | **MISSING** | `systemd/systemd` |
| **runit** | `ADDITIONAL_PRIOR_ART.md` §2 (via termux-services) | **MISSING** | `g-pape/runit` |

### Summary of Missing Clones

**Missing from `~/Downloads/references/github/` (with provided URLs):**
- `termux/termux-services`
- `AppImage/AppImageKit`
- `ValveSoftware/steam-runtime`
- `ValveSoftware/steam-runtime-tools`
- `pypa/manylinux`
- `k0sproject/k0s`
- `89luca89/lilipod`
- `systemd/systemd`
- `g-pape/runit`

**Present but nested (not missing, just not direct):**
- `F1bonacc1/process-compose`, `gokrazy/gokrazy`, `mvdan/sh`, `love2d/love-android`.
