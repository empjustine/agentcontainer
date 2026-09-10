# Sandbox Primitives — Capabilities & Limitations

This document maps the sandboxing primitives available in our target
environments against the isolation requirements of the `workload-runner`.
For each primitive we document **what it can do**, **what it cannot do**,
and **where it fits** in the workload-runner architecture.

---

## 1. Sandbox Primitive Matrix

| Primitive | PID NS | User NS | Mount NS | Net NS | IPC NS | CGroup NS | UTS NS | Seccomp | Capabilities | Root Required |
|-----------|:------:|:-------:|:--------:|:------:|:------:|:---------:|:------:|:-------:|:------------:|:-------------:|
| **termux-proot** | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | No |
| **bubblewrap** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Limited | No |
| **QEMU/KVM** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Full | No* |
| **Podman (rootless)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Partial | Limited | No |
| **Podman (rootful)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Full | Yes |
| **nerdctl (rootless)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Partial | Limited | No |
| **nerdctl (rootful)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Full | Yes |
| **Native (bare)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | No |

\* KVM requires `/dev/kvm` access (usually in `kvm` group)

---

## 2. Termux-proot

**What it is:** A userspace `ptrace`-based tool that simulates chroot,
mount binding, and FUSE operations without kernel support.

### Capabilities
- ✅ **Filesystem isolation**: `--chroot`, `--bind`, `--rbind` — remaps
  the visible filesystem tree
- ✅ **UID/GID remapping**: `--uid`, `--gid`, `--fake-id` — fakes
  ownership so processes can `chown`/`chmod` within the sandbox
- ✅ **Environment isolation**: `--env`, `--link-syscall` — controls
  visible environment and links
- ✅ **No root required**: Works entirely in userspace via `ptrace`
- ✅ **Cross-arch execution**: `--qemu` flag for cross-architecture
  emulation

### Limitations
- ❌ **No real namespaces**: All processes share host PID, NET, IPC,
  UTS namespaces. `ps aux` shows all host processes.
- ❌ **No real mount isolation**: Bind mounts are intercepted via `ptrace`
  on `stat`, `open`, `access` syscalls — not true mount namespaces.
  `/proc/mounts` is faked.
- ❌ **No network isolation**: No network namespace. All network
  connections go through the host network stack directly.
- ❌ **No seccomp/BPF filtering**: Cannot restrict syscalls.
- ❌ **No cgroup limits**: Cannot enforce CPU/memory limits.
- ❌ **Performance overhead**: Every syscall is ptrace-traced (~10-50x
  slowdown).
- ❌ **Incomplete syscall coverage**: Some syscalls are not intercepted,
  leading to inconsistent behavior with statically-linked binaries or
  Go programs that use raw syscalls.

### Where it fits in workload-runner

```
┌─────────────────────────────────────────┐
│  workload-runner (host/termux)          │
│  ┌───────────────────────────────────┐  │
│  │  proot sandbox                    │  │
│  │  --chroot /sandbox/rootfs         │  │
│  │  --bind /data:/data               │  │
│  │  --fake-id 1000:1000              │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  workload process           │  │  │
│  │  │  (thinks it's root)         │  │  │
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

**Use case:** Native Termux execution where containers are unavailable.
Provides **filesystem isolation** and **UID faking** only. No security
boundary — purely for environment separation.

**Manifest mapping:**
```yaml
kind: Pod
spec:
  runtime: proot
  proot:
    chroot: /path/to/rootfs
    binds:
      - host: /data
        container: /data
    fakeUID: 1000
    fakeGID: 1000
```

---

## 3. Bubblewrap (bwrap)

**What it is:** A setuid-less tool for constructing sandbox environments
using Linux kernel namespaces. Originally built for Flatpak.

### Capabilities
- ✅ **All kernel namespaces**: `--unshare-user`, `--unshare-pid`,
  `--unshare-ipc`, `--unshare-net`, `--unshare-uts`, `--unshare-cgroup`
- ✅ **Mount namespace isolation**: Creates a fresh empty mount namespace
  (tmpfs root), then binds specific host paths in
- ✅ **Filesystem access control**: `--bind`, `--ro-bind`, `--tmpfs`,
  `--dev-bind`, `--symlink` — precise control over visible filesystem
- ✅ **Seccomp filtering**: `--seccomp` — applies BPF syscall filters
- ✅ **Capability dropping**: Automatically drops all capabilities except
  those needed for namespace setup
- ✅ **PR_SET_NO_NEW_PRIVS**: Prevents setuid/setgid escalation
- ✅ **Process group isolation**: `--new-session`
- ✅ **No root required**: Uses unprivileged user namespaces
- ✅ **PID 1 reaping**: Runs a tiny init inside the sandbox

### Limitations
- ❌ **No cgroup v2 enforcement**: Can create cgroup namespace but
  cannot enforce limits without cgroup manager
- ❌ **No network namespace isolation by default**: `--share-net` must
  be explicitly passed to keep host network; otherwise new net NS
  with only loopback
- ❌ **No image management**: Does not pull/build container images
- ❌ **No built-in orchestration**: Single process execution only
- ❌ **No health checks**: No liveness/readiness probes
- ❌ **No restart policies**: Process must be externally supervised
- ❌ **No cross-platform**: Linux only
- ⚠️ **Limited to invoking user's privileges**: Cannot grant more
  privileges than the caller has

### Where it fits in workload-runner

```
┌──────────────────────────────────────────────┐
│  workload-runner (host)                      │
│  ┌────────────────────────────────────────┐  │
│  │  bwrap --unshare-all --ro-bind /usr /usr │  │
│  │      --bind /data:/data                  │  │
│  │      --tmpfs /tmp                        │  │
│  │      --dev /dev                          │  │
│  │  ┌────────────────────────────────────┐ │  │
│  │  │  PID 1 (bwrap's tiny init)         │ │  │
│  │  │  ┌──────────────────────────────┐  │ │  │
│  │  │  │  workload process            │  │ │  │
│  │  │  │  (new user/pid/uts/net ns)   │  │ │  │
│  │  │  └──────────────────────────────┘  │ │  │
│  │  └────────────────────────────────────┘ │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**Use case:** Container-like isolation without container runtime.
Provides **real kernel namespace isolation** for workloads that need
filesystem, PID, network, and user separation.

**Manifest mapping:**
```yaml
kind: Pod
spec:
  runtime: bwrap
  sandbox:
    namespaces:
      user: true
      pid: true
      net: true
      ipc: true
      uts: true
    mounts:
      - source: /usr
        destination: /usr
        readonly: true
      - source: ./data
        destination: /data
    seccomp: default
```

---

## 4. QEMU/KVM

**What it is:** Full system emulation (QEMU) with hardware-assisted
virtualization (KVM). Provides the strongest isolation.

### Capabilities
- ✅ **Full hardware virtualization**: KVM provides near-native
  performance with complete hardware isolation
- ✅ **All isolation primitives**: Complete isolation of CPU, memory,
  devices, network, storage
- ✅ **Independent kernel**: Guest runs its own kernel — completely
  independent of host
- ✅ **Full seccomp/capabilities**: Guest has its own security model
- ✅ **Snapshot/restore**: QEMU supports live migration and snapshots
- ✅ **Cross-architecture**: QEMU can emulate ARM on x86 and vice versa
- ✅ **Device passthrough**: GPU (virtio-gpu), network (virtio-net),
  block devices (virtio-blk)
- ✅ **No root required for KVM**: `/dev/kvm` access (usually in `kvm` group)

### Limitations
- ❌ **High resource overhead**: Full OS + kernel + memory (~100MB+ RAM,
  ~1-2 CPU cores minimum)
- ❌ **Slow startup**: Booting a full OS takes seconds to minutes
- ❌ **Complex configuration**: Requires kernel images, disk images,
  bootloader configuration
- ❌ **No native integration**: Guest is completely isolated — no shared
  filesystems without additional setup (9p, virtiofs, NFS)
- ❌ **No built-in orchestration**: Must be managed externally
- ❌ **Not for oneshot workloads**: Overkill for short-lived tasks
- ❌ **Android limitation**: Termux on Android generally cannot access
  `/dev/kvm` (requires root or specific device support)

### Where it fits in workload-runner

```
┌───────────────────────────────────────────────────┐
│  Host (workload-runner)                           │
│  ┌─────────────────────────────────────────────┐  │
│  │  KVM Virtual Machine                        │  │
│  │  ┌───────────────────────────────────────┐  │  │
│  │  │  Guest Kernel (Linux)                 │  │  │
│  │  │  ┌─────────────────────────────────┐  │  │  │
│  │  │  │  Guest OS processes             │  │  │  │
│  │  │  │  (completely isolated)          │  │  │  │
│  │  │  └─────────────────────────────────┘  │  │  │
│  │  └───────────────────────────────────────┘  │  │
│  │  virtio-blk (disk)                          │  │
│  │  virtio-net (network)                       │  │
│  │  virtio-gpu (graphics)                      │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

**Use case:** `kind: VirtualMachine` — high-isolation environments,
legacy OS support, kernel-dependent workloads, or when complete
host independence is required.

**Manifest mapping:**
```yaml
kind: VirtualMachine
metadata:
  name: isolated-workload
spec:
  emulator: qemu
  image: /path/to/debian.qcow2
  kernel: /path/to/vmlinuz
  initrd: /path/to/initrd.img
  resources:
    cpu: 2
    memory: "4Gi"
    gpu: 1
  devices:
    - type: virtio-blk
      source: /path/to/disk.qcow2
      target: vdb
    - type: virtio-net
      model: virtio
      network: bridge0
  args:
    - "-enable-kvm"
    - "-m"
    - "4G"
```

---

## 5. Podman (Rootless)

**What it is:** Daemonless container engine running without root
privileges, using user namespaces for isolation.

### Capabilities
- ✅ **Full OCI container support**: Pulls/runs OCI/Docker images
- ✅ **All kernel namespaces**: User, PID, mount, network, IPC, UTS
- ✅ **Image management**: Pull, build, tag, push images
- ✅ **Volume management**: Bind mounts, named volumes
- ✅ **Network management**: Bridge, host, slirp, pasta networking
- ✅ **Resource limits**: CPU, memory (cgroups v2)
- ✅ **Rootless**: No root required (with subuid/subgid setup)
- ✅ **Podman pods**: Group containers with shared namespaces
- ✅ **Buildah integration**: Build images without daemon
- ✅ **REST API**: RESTful API for programmatic access
- ✅ **Systemd integration**: `podman generate systemd`

### Limitations
- ❌ **Cannot bind to ports < 1024**: Without `CAP_NET_BIND_SERVICE`
- ❌ **Cannot create device nodes**: No `CAP_MKNOD`
- ❌ **No checkpoint/restore**: CRIU requires root
- ❌ **Subuid/subgid required**: Must be configured by admin
- ❌ **Limited to ~65536 UIDs**: Standard rootless config
- ❌ **NFS incompatibility**: NFS servers don't understand user namespaces
- ❌ **Requires writable home directory**: Cannot run from noexec mounts
- ❌ **pasta networking**: Default rootless networking copies host IP,
  breaking inter-container connections on single-interface systems
- ⚠️ **Performance**: Near-native but with namespace overhead
- ⚠️ **Kernel version**: Requires kernel >= 5.12 for native overlayfs
  (else uses slower fuse-overlayfs)

### Where it fits in workload-runner

```
┌────────────────────────────────────────────────────┐
│  Host (workload-runner) — user namespace mapped    │
│  ┌──────────────────────────────────────────────┐  │
│  │  Podman Container                            │  │
│  │  ┌────────────────────────────────────────┐  │  │
│  │  │  Container rootfs (overlayfs)          │  │  │
│  │  │  (UID 0 → host UID 1000)               │  │  │
│  │  │  ┌──────────────────────────────────┐  │  │  │
│  │  │  │  workload process (PID 1 in ns)  │  │  │  │
│  │  │  │  (new user/pid/mount/net ns)     │  │  │  │
│  │  │  └──────────────────────────────────┘  │  │  │
│  │  │  /proc, /sys, /dev (filtered)           │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  │  pasta: host IP → 10.0.2.x                  │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

**Use case:** Standard container workloads on Linux desktops/servers
where root access is not available or not desired. The **primary target**
for the `workload-runner` on Linux hosts.

**Manifest mapping:**
```yaml
kind: Pod
spec:
  runtime: podman
  container:
    image: ghcr.io/mostlygeek/llama-swap:unified-vulkan
    command: ["./llama-swap"]
    ports:
      - container: 8080
        host: 8080
    volumes:
      - name: config
        hostPath: ./config.d
        mountPath: /config
    resources:
      limits:
        memory: "2Gi"
        cpu: "2"
    env:
      - name: MODEL
        value: "llama-3.1-8b"
```

---

## 6. Podman (Rootful)

**What it is:** Traditional root-owned Podman with full system access.

### Capabilities
- ✅ **All rootless capabilities** + everything below
- ✅ **Bind to any port**: Full `CAP_NET_BIND_SERVICE`
- ✅ **Create device nodes**: Full `CAP_MKNOD` for GPU, block devices
- ✅ **Full cgroup management**: Fine-grained resource limits
- ✅ **Privileged mode**: `--privileged` for full host access
- ✅ **Checkpoint/restore**: CRIU integration
- ✅ **Full network control**: Bridge, macvlan, ipvlan, host networking
- ✅ **No subuid limits**: Can use any UID/GID in containers
- ✅ **NFS support**: No user namespace conflicts

### Limitations
- ❌ **Root required**: Must run as root or via sudo
- ❌ **Security surface**: Higher attack surface — container escape
  gives full host root
- ❌ **Not for Termux**: Termux runs as unprivileged user

### Where it fits in workload-runner

Same as rootless but with elevated capabilities. Use when:
- GPU device nodes are needed (`--device /dev/dri`)
- Low ports must be bound (`--publish 443:443`)
- Full network control is required
- The host is a dedicated server (not a desktop)

---

## 7. nerdctl (Rootless)

**What it is:** Docker-compatible CLI for containerd, with rootless support.
Similar to Podman rootless but uses containerd as the backend.

### Capabilities
- ✅ **OCI container support**: Full OCI image compatibility
- ✅ **All kernel namespaces**: Same as Podman rootless
- ✅ **containerd integration**: Uses containerd for image management
- ✅ **Rootless**: Same subuid/subgid requirements
- ✅ **Docker-compatible CLI**: `docker` → `nerdctl` drop-in

### Limitations
- ❌ **Same as Podman rootless**: All rootless limitations apply
- ❌ **containerd dependency**: Requires running containerd socket
- ❌ **Less mature rootless**: Podman's rootless is more battle-tested
- ❌ **No pods**: No native pod support (unlike Podman)
- ❌ **No build**: No built-in image building (requires buildctl)

### Where it fits in workload-runner

Alternative to Podman rootless. Use when:
- containerd is already installed/running
- Docker-compatible CLI is preferred
- Integration with containerd ecosystem is needed

---

## 8. Native Execution (Bare)

**What it is:** Running the workload directly on the host without any
sandboxing. This is the "Termux native" mode.

### Capabilities
- ✅ **Zero overhead**: No namespace, no emulation, no container
- ✅ **Full host access**: All devices, ports, capabilities
- ✅ **Fastest startup**: No sandbox setup
- ✅ **Works everywhere**: No kernel features required

### Limitations
- ❌ **No isolation**: Process has full host access
- ❌ **No resource limits**: Cannot enforce CPU/memory limits
- ❌ **No filesystem isolation**: Full access to host filesystem
- ❌ **No network isolation**: Direct host network access
- ❌ **No restart policies**: Must be externally supervised
- ❌ **No image support**: Must have binaries installed on host

### Where it fits in workload-runner

```
┌─────────────────────────────────────────┐
│  workload-runner (host)                 │
│  ┌───────────────────────────────────┐  │
│  │  workload process                 │  │
│  │  (directly on host)               │  │
│  │  full access to everything        │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

**Use case:** Termux native execution, development mode, or when the
workload is trusted and isolation is not needed.

**Manifest mapping:**
```yaml
kind: Pod
spec:
  runtime: native
  command: ["./my-app"]
  env:
    - name: HOME
      value: /data/data/com.termux/files/home
```

---

## 9. Runtime Selection Strategy

The `workload-runner` should auto-select the best runtime based on
availability and manifest hints:

```
Runtime Selection Priority:
─────────────────────────────────────────────────────────
1. QEMU/KVM       → kind: VirtualMachine (always)
2. Podman (root)  → host has root + needs GPU/devices
3. Podman (rootless) → host has subuid/subgid + containerd/podman
4. nerdctl        → host has containerd socket + nerdctl
5. bubblewrap     → host has bwrap + kernel namespaces available
6. termux-proot   → Termux environment + no container runtime
7. native         → fallback, no sandboxing
─────────────────────────────────────────────────────────
```

### Auto-detection Logic

```go
func autoDetectRuntime() Runtime {
    // 1. Check for container runtimes
    if hasPodman() {
        if hasRoot() {
            return PodmanRootful
        }
        if hasSubuidSubgid() {
            return PodmanRootless
        }
    }
    if hasNerdctl() && hasContainerd() {
        return Nerdctl
    }

    // 2. Check for bubblewrap
    if hasBubblewrap() && hasKernelNamespaces() {
        return Bubblewrap
    }

    // 3. Check for proot (Termux)
    if isTermux() && hasProot() {
        return Proot
    }

    // 4. Fallback to native
    return Native
}
```

### Manifest Runtime Override

Users can explicitly request a runtime:

```yaml
spec:
  runtime: podman        # explicit runtime selection
  # or
  runtime: auto          # auto-detect (default)
  # or
  runtime: bwrap         # force bubblewrap
```

---

## 10. Security Boundary Summary

| Primitive | Security Boundary | Escape Risk | Use for untrusted workloads |
|-----------|------------------|-------------|---------------------------|
| **Native** | None | N/A | ❌ Never |
| **termux-proot** | Filesystem only | Low (ptrace escapes possible) | ⚠️ Limited isolation |
| **bubblewrap** | Kernel namespaces | Low (namespace escapes rare) | ✅ Good for most cases |
| **Podman rootless** | Full OCI isolation | Low (container escapes rare) | ✅ Good for most cases |
| **Podman rootful** | Full OCI isolation | Medium (root access) | ✅ With restrictions |
| **QEMU/KVM** | Hardware isolation | Very low (VM escapes extremely rare) | ✅ Best isolation |

---

## 11. Recommended Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    workload-runner                          │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Pod      │  │ Deploy   │  │ VM       │  │ Secret   │   │
│  │ (oneshot)│  │ (replica)│  │ (QEMU)   │  │ (Infis.) │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │              │        │
│       ▼              ▼              ▼              │        │
│  ┌─────────────────────────────────────────────────┐      │
│  │              Runtime Dispatcher                  │      │
│  │  ┌────────┐ ┌──────────┐ ┌────────┐ ┌────────┐ │      │
│  │  │ Podman │ │ bwrap    │ │ proot  │ │ native │ │      │
│  │  └────┬───┘ └────┬─────┘ └───┬────┘ └───┬────┘ │      │
│  └───────┼──────────┼──────────┼──────────┼──────┘      │
│          │          │          │          │              │
│          ▼          ▼          ▼          ▼              │
│  ┌─────────────────────────────────────────────────┐    │
│  │           Supervision Loop (gokrazy-style)       │    │
│  │  • Process-group isolation (Setpgid)            │    │
│  │  • Graceful shutdown (SIGTERM → SIGKILL)         │    │
│  │  • Restart policies (always/on_failure/once)    │    │
│  │  • Health probes (HTTP/exec/log-line)           │    │
│  │  • Structured logging (ring buffer + streams)   │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

The supervision loop is **runtime-agnostic** — it works the same
regardless of whether the underlying runtime is Podman, bubblewrap,
proot, or native. The dispatcher handles runtime selection and
translation of the manifest into runtime-specific commands.

---

## Appendix: bwrap usage audit against the containers/bubblewrap reference (2026-09-10)

Audit of bubblewrap usage found in the GitHub mirror tree
(`~/Downloads/references/github`), verified flag-by-flag against the
upstream source/docs clone at
`~/Downloads/references/github/containers/bubblewrap` (`bwrap.xml` man
page and `bubblewrap.c`).

### Usage found in the mirror tree

1. **mini-swe-agent** (`SWE-agent/mini-swe-agent`) — the only in-tree
   *code* consumer: `src/minisweagent/environments/extra/bubblewrap.py`
   implements a `BubblewrapEnvironment` that wraps every agent command
   in `bwrap`, invoked as:

   ```
   bwrap --unshare-user-try --ro-bind /usr /usr --ro-bind /bin /bin \
        --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc \
        --tmpfs /tmp --proc /proc --dev /dev --new-session \
        --setenv PATH … \
        --bind <cwd> <cwd> --chdir <cwd> \
        --setenv K V … bash -c <command>
   ```

   Marked **experimental** upstream; not supported on Windows;
   executable overridable via `MSWEA_BUBBLEWRAP_EXECUTABLE`. Also
   referenced only as documentation elsewhere (docs, mkdocs, CI yaml);
   the sole other hit is a doc citation in `cline/kanban` (codex CLI
   reference), i.e. not code.

2. **This repo's own prior-art docs** (`OVERLAY_RUNTIMES.md`,
   `COHESION_AND_GAPS.md`) reference bwrap as the Pressure-Vessel /
   Flatpak-style ideal sandbox layer for a containerless Termux
   runtime, and list `bwrap` as one of the pluggable workload
   runtimes — consistent with the mini-swe-agent usage shape.

### Plausibility verification vs `containers/bubblewrap`

Every flag mini-swe-agent passes is a real, documented option in the
upstream man page (`bwrap.xml`) and parsed in `bubblewrap.c`
(occurrence counts man page/source):

| Flag | bwrap.xml | bubblewrap.c | Notes |
|---|---|---|---|
| `--unshare-user-try` | 2 | 3 | unshare user ns only if permitted — the right *try* form for heterogeneous hosts |
| `--ro-bind` | 4 | 11 | 4× system dirs; keeps base OS read-only |
| `--bind` | 14 | 63 | 1× per-run workspace cwd (RW) |
| `--chdir` | 2 | 23 | enters the bound workspace |
| `--tmpfs` | 16 | 22 | private `/tmp` |
| `--proc` | 25 | 95 | fresh `/proc` |
| `--dev` | 6 | 29 | minimal `/dev` |
| `--new-session` | 2 | 2 | new TTY session; upstream man page explicitly recommends it "in a general sandbox" |
| `--setenv` | 4 | 9 | PATH + per-var env injection |

Semantic consistency with upstream `README.md`:

- Bubblewrap's supported mode is **unprivileged user namespaces**
  (`--unshare-user-try` matches; upstream setuid mode has been removed,
  so a plain unprivileged invocation is the correct, plausible usage —
  no setuid expectations anywhere in mini-swe-agent).
- The layout (ro-bind system trees + tmpfs tmp + fresh proc/dev +
  per-run RW workspace bind) is exactly the minimal-sandbox pattern
  upstream demos/tests exercise; nothing invented.
- Correct sequencing: option order (binds before `--chdir`/exec) is
  legal — bwrap processes options positionally; `bash` as the payload
  runs inside the namespace.

### Gaps / caveats if adopted as a workload runtime here

- mini-swe-agent does **not** pass `--die-with-parent` (documented,
  `bwrap.xml:587`) — advisable for our supervision loop so the sandbox
  dies with its supervisor.
- No `--unshare-net`; the sandbox keeps host networking. Our workload
  model may want opt-in network isolation instead.
- No `--dev-bind` for GPU/device trees; fine for CPU-only agent work,
  would need extension for CUDA workloads (cf. HF cache mount needs).
- Env forwarding is explicit-only (`--setenv` per key), which mirrors
  this repo's `workload_env` allowlist pattern — a good match.
- Upstream marks this environment experimental; if we wire a `bwrap`
  runtime into `lib/workload-runtime.sh`, treat it as the
  `proot`/`native` tier's peer (`COHESION_AND_GAPS.md` line 31), not a
  podman replacement.

**Verdict: plausible.** The only real bwrap consumer in the mirror
tree uses exclusively documented, semantically correct flags against
the containers/bubblewrap reference clone; the usage is a faithful
minimal-sandbox construction consistent with upstream docs and with
this repo's own prior-art notes.

