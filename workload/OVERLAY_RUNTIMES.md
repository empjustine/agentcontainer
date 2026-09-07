# Overlay Runtimes & Library Isolation — Prior Art

Steam Runtimes, Steam Pressure Vessel (Syzygy), Python ManyLinux, Nix,
and related projects all solve the same fundamental problem: **how to
deliver software with specific library versions without requiring the
host system to have them installed**.

This is directly relevant to the `workload-runner` for two reasons:
1. **Termux**: Users rarely have the exact library versions our workloads
   need — overlay filesystems solve this.
2. **Linux desktop/server**: Even on "normal" Linux, workloads may need
   specific glibc, CUDA, or other library versions not present on the host.

---

## 1. Steam Runtimes

**Source:** `github.com/ValveSoftware/steam-runtime`

Steam ships with a set of pre-built runtime environments that provide
specific library versions for games and applications. This is how Steam
delivers games that need glibc 2.28, specific Mesa drivers, or old
libstdc++ versions on systems that have glibc 2.38.

### Architecture

```
Steam Runtime (Soldier / Snappy)
├── /usr/lib/x86_64-linux-gnu/  (specific library versions)
├── /usr/lib/i386-linux-gnu/    (32-bit compatibility)
├── /usr/local/                 (Steam-provided tools)
└── /run/steam-runtime/         (runtime metadata)
```

**Soldier** (current default): Based on Ubuntu 22.04 (Jammy)
**Snappy** (legacy): Based on Ubuntu 18.04 (Bionic)

### How It Works

1. Steam ships a **skeleton** directory containing specific library versions
2. Games are launched via a **wrapper script** that:
   - Sets `LD_LIBRARY_PATH` to the runtime libs
   - Binds-mounts the runtime's filesystem over the host's
   - Executes the game binary in this isolated environment
3. The runtime is **per-platform** (Linux, Windows via Proton)
4. Steam **updates** the runtime independently of the host OS

### Key Design Decisions

| Feature | Implementation |
|---------|---------------|
| **Library versions** | Pre-built Ubuntu base with pinned versions |
| **Isolation method** | LD_LIBRARY_PATH + bind mounts |
| **Distribution** | Bundled with Steam client (~2GB) |
| **Updates** | Steam client updates the runtime |
| **Compatibility** | 32-bit + 64-bit coexistence |
| **Driver isolation** | Separate Mesa/libEGL/libGL from host |

### Relevance to workload-runner

- **Pre-bundled runtime** pattern: Ship a known-good library set with
  the workload, rather than depending on host libraries.
- **LD_LIBRARY_PATH override**: Simple mechanism for library isolation
  without full containerization.
- **Per-workload runtimes**: Different workloads can use different
  runtime versions (e.g., one needs glibc 2.28, another needs 2.35).

---

## 2. Steam Pressure Vessel → Syzygy

**Source:** `github.com/ValveSoftware/steam-runtime-tools` (pressure-vessel)
**Now known as:** Syzygy

Pressure Vessel was the component that made Steam Runtime work on
**any Linux distribution**, not just Ubuntu. It uses **bubblewrap**
to create a sandboxed environment with the Steam Runtime libraries.

### Architecture

```
Pressure Vessel / Syzygy
├── bwrap (bubblewrap) — sandbox construction
├── steamrt-overlay — runtime filesystem overlay
├── pressure-vessel-bin — runtime binary package
└── verb — user-space interface ("steam-run", "steam-exec")
```

### How It Works

1. **Steam Runtime** is extracted to a directory (the "overlay")
2. **Pressure Vessel** constructs a bubblewrap command:
   ```bash
   bwrap \
     --ro-bind / /host \
     --bind /run/steam-runtime-overlay / \
     --proc /proc \
     --dev /dev \
     --unshare-all \
     --share-net \
     -- /path/to/game
   ```
3. The overlay's `/usr/lib` is mounted **over** the host's, providing
   the Steam Runtime library versions
4. The game runs in a namespace with the correct libraries

### Key Features

| Feature | Description |
|---------|-------------|
| **Distribution-agnostic** | Works on any distro, any glibc version |
| **bwrap-based** | Real kernel namespace isolation |
| **Overlay filesystem** | OverlayFS or fuse-overlayfs for layered mounts |
| **Verb system** | `steam-run` (run with runtime), `steam-exec` (shell) |
| **Proton integration** | Used by Steam Play/Proton for Windows games |
| **Layered approach** | Base runtime + per-game patches |

### Relevance to workload-runner

- **Overlay + bwrap** is the **ideal model** for our Termux/containerless
  use case: real namespace isolation with overlay filesystem for library
  versions.
- **Verb system** (`steam-run` / `steam-exec`) maps to our desired CLI:
  `workload run <manifest>` / `workload shell <manifest>`.
- **Distribution-agnostic**: Works regardless of host OS — exactly what
  we need for cross-platform (Linux + Termux) support.

---

## 3. Python ManyLinux

**Source:** `github.com/pypa/manylinux`

ManyLinux is a set of Docker images that define **minimum system
requirements** for Python wheel packages. A "manylinux" wheel guarantees
it will work on any Linux system with glibc >= the manylinux version.

### ManyLinux Standards

| Standard | Base Image | glibc Version | Status |
|----------|-----------|---------------|--------|
| manylinux1 | CentOS 5 | 2.5 | Deprecated |
| manylinux2010 | CentOS 6 | 2.12 | Deprecated |
| manylinux2014 | CentOS 7 | 2.17 | Current |
| manylinux_2_17 | AlmaLinux 8 | 2.17 | Current |
| manylinux_2_28 | AlmaLinux 9 | 2.28 | Emerging |
| manylinux_2_31 | Debian 11 | 2.31 | Emerging |

### How It Works

1. **Build environment**: Docker image with old glibc (e.g., CentOS 7)
2. **Compile** Python extensions against old glibc
3. **Test** in the old environment to ensure compatibility
4. **Tag** the wheel with the manylinux standard (e.g., `manylinux_2_17_x86_64`)
5. **Install** on any host with glibc >= the tagged version

### Key Design Decisions

| Feature | Implementation |
|---------|---------------|
| **Compatibility guarantee** | Wheels compiled against old glibc |
| **Tagging system** | `cp311-cp311-manylinux_2_17_x86_64.whl` |
| **Build isolation** | Docker containers with pinned base |
| **Runtime detection** | `auditwheel` checks binary dependencies |
| **Fallback mechanism** | Source distributions if binary fails |

### Relevance to workload-runner

- **Tagging convention**: Our workload manifests could include a
  `compatibility` field specifying minimum library versions:
  ```yaml
  spec:
    compatibility:
      glibc: "2.17"
      cuda: "12.0"
      python: "3.11"
  ```
- **Build isolation**: Build workloads in known environments (Docker/
  bubblewrap) to ensure reproducibility.
- **Runtime detection**: `workload check <manifest>` could verify
  host compatibility before execution.

---

## 4. Nix / NixOS

**Source:** `github.com/NixOS/nix` (not fully cloned in references)

Nix is a purely functional package manager and OS distribution that
provides **hermetic build environments** and **isolated runtime
environments** through content-addressed store paths.

### Nix Store Architecture

```
/nix/store/
├── abc123-python-3.11.4/
│   ├── bin/python3
│   ├── lib/libpython3.11.so
│   └── ...
├── def456-glibc-2.38/
│   ├── lib/libc.so.6
│   └── ...
├── ghi789-openssl-3.2.0/
│   ├── lib/libssl.so.3
│   └── ...
└── jkl012-myapp-1.0.0/
    ├── bin/myapp
    └── ...
```

### How It Works

1. **Content-addressed store**: Every file is stored at a path derived
   from its content hash (`/nix/store/<hash>-<name>-<version>/`)
2. **Dependency graph**: Each package declares its exact dependencies
3. **Isolation**: Packages only see their declared dependencies
4. **Reproducibility**: Same inputs → same store path → same output
5. **Rollback**: Entire system can be rolled back to any previous state

### Nix Development Environments

```bash
# Hermetic dev environment with specific tools
nix develop nixpkgs#python311.nixpkgs-fmt

# Or with shell.nix
nix-shell shell.nix
```

### Relevance to workload-runner

- **Content-addressed paths**: Could be used for workload images —
  `workload run /nix/store/abc123-workload/`
- **Dependency declaration**: Similar to our manifest's `dependencies`
  concept but with cryptographic guarantees.
- **Hermetic environments**: Build workloads in isolated Nix shells
  to ensure reproducibility.
- **Trade-off**: Nix is powerful but complex — our approach should be
  simpler: overlay directories without the full Nix store model.

---

## 5. Additional Related Prior Art

### 5.1 Conda / Mamba

Python/R/environment management with **isolated environments**:
```bash
conda create -n myenv python=3.11 numpy=1.24
conda activate myenv
```
- Uses **prefix-based isolation** (directory with its own Python/libs)
- **Cross-platform**: Linux, macOS, Windows, Android (via Termux)
- **Binary packages**: Pre-compiled binaries with dependency resolution

### 5.2 venv / Poetry / pipenv

Python virtual environments:
- **venv**: Isolated Python installation (no shared site-packages)
- **Poetry**: Dependency resolution + lock files + packaging
- **pipenv**: venv + Pipfile + dependency resolution

### 5.3 Flatpak

Linux application sandboxing using **bubblewrap** + **freedesktop runtime**:
- Applications bundled with their dependencies
- Sandboxed via bwrap (same as Pressure Vessel)
- Portal-based access to host resources

### 5.4 AppImage

Self-contained Linux applications:
- Single `.AppImage` file containing binary + libraries
- Extracted to tmpfs at runtime
- No installation required

### 5.5 Guix

Similar to Nix but with GNU focus:
- Functional package manager
- Hermetic builds
- Reproducible environments

### 5.6 Docker Buildx / BuildKit

Build isolation for container images:
- **BuildKit**: Modern build engine with cache mounts, secret mounts
- **Buildx**: Multi-platform builds
- **Cache mounts**: `/run/buildkit` for build caching
- **Secret mounts**: `/run/secrets` for build-time secrets

---

## 6. Overlay Strategies Comparison

| Approach | Isolation Method | Library Versions | Complexity | Cross-Platform |
|----------|-----------------|-----------------|------------|----------------|
| **Steam Runtime** | LD_LIBRARY_PATH + bind | ✅ Pinned versions | Low | Linux only |
| **Pressure Vessel** | bwrap + overlay | ✅ Pinned versions | Medium | Linux only |
| **ManyLinux** | Docker build + tags | ✅ Compatibility guarantee | Low | Linux only |
| **Nix** | Content-addressed store | ✅ Exact versions | High | Linux/macOS |
| **Conda** | Prefix-based env | ✅ Exact versions | Medium | All |
| **venv** | Prefix-based env | ✅ Python libs only | Low | All |
| **Flatpak** | bwrap + runtime | ✅ Pinned versions | Medium | Linux only |
| **AppImage** | Extract to tmpfs | ✅ Bundled | Low | Linux only |

---

## 7. Recommendations for workload-runner

Based on this research, the `workload-runner` should support **multiple
overlay strategies** to cover different use cases:

### Strategy 1: Overlay Directory (Pressure Vessel-style)

```yaml
kind: Pod
spec:
  runtime: bwrap
  overlay:
    type: bind-overlay    # bind mount overlay directories
    directories:
      - source: ./runtime/lib
        destination: /usr/lib
      - source: ./runtime/usr
        destination: /usr
```

**Use case:** Termux execution, simple library version overrides.

### Strategy 2: Container Image (Podman-style)

```yaml
kind: Pod
spec:
  runtime: podman
  container:
    image: ghcr.io/mostlygeek/workload-base:ubuntu-22.04
```

**Use case:** Linux desktop/server with container runtime available.

### Strategy 3: Native + LD_LIBRARY_PATH (Steam Runtime-style)

```yaml
kind: Pod
spec:
  runtime: native
  overlay:
    type: ld-library-path
    directories:
      - ./runtime/lib
```

**Use case:** Simple library overrides without any sandboxing.

### Strategy 4: Compatibility Declaration (ManyLinux-style)

```yaml
spec:
  compatibility:
    glibc: "2.17"
    cuda: "12.0"
    python: "3.11"
  # workload-runner auto-selects best runtime based on compatibility
```

### Strategy 5: Pre-bundled Runtime (AppImage-style)

```yaml
kind: Pod
spec:
  runtime: native
  bundle: ./my-workload.AppDir
  # Extract to tmpfs, run from there
```

**Use case:** Fully self-contained workloads for distribution.

---

## 8. AppImage — Self-Extracting Overlay Runtime

**Source:** `github.com/AppImage/AppImageKit` (not cloned in references)

AppImage is a **self-extracting overlay runtime** — the missing link
between Steam Runtime (LD_LIBRARY_PATH) and Pressure Vessel (bwrap).

### How It Works

1. User downloads a single `.AppImage` file (contains binary + all libs)
2. On first run, extracts to `/tmp/.mount_<random>/` (a tmpfs)
3. Sets `LD_LIBRARY_PATH=/tmp/.mount_<random>/usr/lib`
4. Runs the extracted binary
5. On exit, unmounts and deletes the tmpfs directory

### Architecture

```
AppImage (squashfs container)
├── .DirIcon
├── desktop-file
├── usr/
│   ├── bin/<app>
│   ├── lib/lib*.so*
│   └── share/
└── AppRun (launcher script)

At runtime:
/tmp/.mount_<random>/
├── usr/bin/<app>  ← extracted binary
├── usr/lib/       ← bundled libraries
└── AppRun         ← launcher
```

### Key Design Decisions

| Feature | Implementation |
|---------|---------------|
| **Container format** | squashfs (read-only, compressed) |
| **Extraction target** | tmpfs (in-memory, auto-cleaned) |
| **Library isolation** | LD_LIBRARY_PATH override |
| **Cleanup** | umount + rm -rf on exit |
| **FUSE support** | AppImageFUSE for mount-less extraction |
| **Distribution** | Single file, no install needed |

### Relevance to workload-runner

- **Self-contained workloads**: Bundle a workload + its dependencies into
  a single AppImage that can be distributed and run anywhere.
- **Ephemeral overlay**: The tmpfs extraction provides a clean overlay
  that's automatically cleaned up — perfect for transient workloads.
- **No root required**: Works entirely in user space.

### Manifest mapping

```yaml
kind: Pod
spec:
  runtime: native
  bundle:
    type: appimage
    path: ./my-workload.AppImage
    # Extracts to tmpfs, runs from there
```

---

## 9. Tangentially Related Prior Art

The following projects are not direct sandbox/overlay runtimes but contain
patterns, components, or approaches relevant to the `workload-runner`.

### 9.1 Debuerreotype — Reproducible Rootfs Builder

**Source:** `github.com/debuerreotype/debuerreotype` (cloned in references)

Reproducible, snapshot-based Debian rootfs builds. Creates auditable,
byte-identical rootfs tarballs from point-in-time Debian snapshots.

**Relevance:**
- **Reproducible overlays**: Build deterministic overlay filesystems
  for workloads that need specific library versions.
- **Rootfs tooling**: `debuerreotype-chroot` uses `unshare` to mount
  `/dev`, `/proc`, `/sys` in a simple, safe way — a lightweight
  alternative to full containerization.
- **Deterministic tar creation**: `debuerreotype-tar` creates
  byte-identical tarballs — useful for workload image distribution.

```bash
# Workflow for building a reproducible overlay:
debuerreotype-init rootfs bookworm 2024-01-01T00:00:00Z
debuerreotype-apt-get rootfs install -yqq curl
debuerreotype-slimify rootfs
debuerreotype-tar rootfs - > workload-overlay.tar
```

### 9.2 ko-build — Go Binary to Container Image

**Source:** `github.com/ko-build/ko` (cloned in references)

Simple, fast container image builder for Go applications. Builds images
by executing `go build` locally — no Docker required.

**Relevance:**
- **Build-time isolation**: Build Go workloads with exact dependency
  versions without needing a full container runtime.
- **Multi-platform builds**: Build for arm64, amd64, etc. from a single
  machine — useful for cross-platform workload distribution.
- **SBOM generation**: Built-in Software Bill of Materials — useful for
  auditing workload dependencies.

### 9.3 mise — Dev Tools, Env Vars, and Tasks

**Source:** `github.com/jdx/mise` (cloned in references)

Dev tools, environment variables, and tasks in one CLI. Manages dev
tool versions, loads per-project env vars, and defines/runs tasks.

**Relevance:**
- **Task orchestration**: `mise.toml` defines tasks with dependencies,
  environment variables, and tool version requirements — similar to
  our manifest concept but simpler.
- **Tool version management**: Automatically installs and switches
  between tool versions — could be integrated for workload dependency
  management.
- **Environment loading**: Per-directory env var loading — useful for
  workload environment provisioning.

### 9.4 Caddy — Graceful Lifecycle Management

**Source:** `github.com/caddyserver/caddy` (cloned in references)

Caddy implements a sophisticated **graceful shutdown/recovery** lifecycle:

```go
type App interface {
    Start() error
    Stop() error
}

// Caddy's lifecycle:
// 1. Start all apps in order
// 2. On signal: Stop all apps in reverse order
// 3. Graceful timeout: Wait for in-flight work
// 4. Force stop: Kill remaining work
```

**Relevance:**
- **Graceful shutdown pattern**: `Stop()` should wait for in-flight
  work, then force-kill after timeout — exactly our SIGTERM → wait →
  SIGKILL pattern.
- **Ordered lifecycle**: Apps start in dependency order, stop in
  reverse order — useful for our Deployment controller.
- **Context-based cancellation**: Uses Go `context.Context` for
  cancellation propagation — clean pattern for process supervision.

### 9.5 HashiCorp Serf — Cluster Membership & Failure Detection

**Source:** `github.com/hashicorp/serf` (cloned in references)

Decentralized service discovery and orchestration using gossip protocol.
Detects node failures and propagates events across the cluster.

**Relevance:**
- **Event-driven orchestration**: Serf's event system lets you propagate
  deploy/configuration events across nodes — useful for multi-host
  workload coordination.
- **Failure detection**: Automatic node failure detection — could be
  used for workload health monitoring across multiple hosts.
- **Masterless design**: No single point of failure — useful for
  distributed workload management.

### 9.6 Mozilla Otari — Overlay Architecture Pattern

**Source:** `github.com/mozilla-ai/otari` (cloned in references)

Otari uses an **overlay architecture** where the core defines **ports**
(interfaces) and **adapters** (implementations) can be swapped in.

**Relevance:**
- **Modular runtime design**: Our workload-runner could use ports/adapters
  for different runtimes (Podman, bwrap, proot, native) — swap the
  adapter without changing the core.
- **Extension points**: Define clear boundaries between core and
  extensions — useful for plugin architecture.
- **Null Object pattern**: Every port ships with a working adapter,
  including a Null Object — useful for optional features.

### 9.7 Vercel AI SDK for Python — Agent Runtime

**Source:** `github.com/vercel-labs/ai-python` (cloned in references)

Toolkit for building LLM-powered applications and agent loops with
tool execution, streaming, and model abstraction.

**Relevance:**
- **Tool execution sandbox**: The SDK runs tools in isolated contexts
  — relevant for our workload execution model.
- **Agent lifecycle management**: Manages agent state, tool execution,
  and response streaming — relevant for long-running agent workloads.

### 9.8 mvdan/sh — Shell Parser

**Source:** `github.com/mvdan/sh` (cloned in references)

Pure Go shell parser and interpreter. Parses bash, dash, and POSIX
shell syntax.

**Relevance:**
- **Command parsing**: Parse shell commands from manifests without
  invoking a shell — useful for validating and transforming commands
  before execution.
- **Cross-platform shell**: Parse shell syntax and generate equivalent
  commands for different platforms (Linux, Termux, Windows).

### 9.9 jpillora/chisel — Tunneling

**Source:** `github.com/jpillora/chisel` (cloned in references)

Fast TCP/UDP tunnel over HTTP, written in Go.

**Relevance:**
- **Network isolation**: Chisel can create isolated network tunnels
  for workloads — useful for network namespace alternatives on systems
  without full network namespace support.
- **Port forwarding**: Forward host ports to workload ports — useful
  for rootless container alternatives.

### 9.10 love2d/love-android — Android Runtime

**Source:** `github.com/love2d/love-android` (cloned in references)

LÖVE 2D game framework for Android. Demonstrates Android-native
application lifecycle management.

**Relevance:**
- **Android lifecycle**: `onCreate`, `onStart`, `onPause`, `onStop`,
  `onDestroy` — maps to our workload lifecycle events.
- **Termux compatibility**: Similar constraints to Termux (no systemd,
  limited privileges) — relevant for our Termux target.

---

## 10. Runtime Selection with Overlay Strategy

```
┌─────────────────────────────────────────────────────────────┐
│              Runtime + Overlay Selection                     │
│                                                             │
│  Manifest specifies:                                        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  kind: Pod                                           │    │
│  │  spec:                                               │    │
│  │    runtime: auto           ← container/bwrap/proot   │    │
│  │    overlay: bind-overlay   ← how to provide libs     │    │
│  │    compatibility: ...      ← hints for selection     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Auto-selection priority:                                   │
│  1. Explicit runtime/overlay in manifest                   │
│  2. compatibility hints → best matching runtime            │
│  3. Host capabilities → best available runtime             │
│  4. Fallback to native + LD_LIBRARY_PATH                   │
└─────────────────────────────────────────────────────────────┘
```

The overlay strategy is **independent of** the runtime selection:
- **bwrap + overlay directory** = Pressure Vessel model
- **podman + container image** = Docker model
- **native + LD_LIBRARY_PATH** = Steam Runtime model
- **native + tmpfs extract** = AppImage model

Each provides different trade-offs between isolation, complexity, and
portability.
