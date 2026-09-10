# d020 — qemu/libvirt VM workloades (requirements assessment)

**Status: verified requirements only — nothing implemented.** This note
establishes what it would take to support qemu/libvirt VMs as workload runtimes
next to the existing podman/docker container backend, for both serving
(`llm-reverse-proxy/`) and usage (`coding-agent/`). It is the deliberate
replacement for the retired PRoot backend (see
[container-tooling.md](container-tooling.md), "PRoot backend removed"): where PRoot only *translated
paths over ptrace* (no namespaces, no cgroups, no real root, no GPU), a
qemu/KVM VM is a full kernel boundary — real isolation, real devices, at the
cost of an image + lifecycle surface that containers hide.

---

## 1. Why a VM backend, and why not instead of containers

| Property | rootless podman/docker | qemu/KVM VM |
|---|---|---|
| Kernel boundary | shared host kernel | separate guest kernel |
| Escalation risk of agent `bash` | namespaces + seccomp + SELinux (strong, same-kernel) | confined by the hypervisor (strongest short of hardware) |
| GPU compute (ROCm/Vulkan, llama.cpp) | device nodes passed through natively | only via VFIO PCI passthrough (whole device) |
| Image model | OCI (layers, registries) | disk image + cloud-init (no OCI natively) |
| Resource cost | MBs, shared kernel | GBs of pinned RAM + vCPUs per VM |
| Boot/teardown | ms | seconds |
| Snapshot/rollback | rebuild image | `virsh snapshot-*` / qcow2 — cheap full-state reset |

**Conclusion up front:** VMs should *complement* containers, in the "VM as
workload **host**" shape (§2 Level 1), not replace them. A full "VM as the
workload" backend (Level 2) is only worth building for workloads that are
peers-only/CPU — GPU inference is strictly worse inside a VM on this fleet
(§4).

### 1.1 Isolation ladder (decision basis for the table above)

Where each available boundary sits, by what it confines and its escape
risk — this is what "stronger than container, weaker than hardware"
means concretely:

| Boundary | Security boundary | Escape risk | For untrusted workloads |
|---|---|---|---|
| native (bare) | none | n/a | never |
| proot (retired) | filesystem path translation only | low (ptrace escapes possible) | not isolation |
| bubblewrap | kernel namespaces | low (namespace escapes rare) | good for most cases |
| podman rootless | full OCI isolation | low (container escapes rare) | good for most cases |
| podman rootful | full OCI isolation | medium (container escape = host root) | with restrictions |
| qemu/KVM VM | hypervisor / separate guest kernel | very low (VM escapes extremely rare) | best isolation |

Two host facts fall out of the same survey and are worth recording here:

- **Termux (a50) cannot reach `/dev/kvm`** (unprivileged app sandbox), so a
  VM backend is never available on the a50 — its runtime ladder tops out at
  native execution (see [termux-serving.md](termux-serving.md)).
- **Rootless podman cannot bind ports < 1024 or create device nodes** (no
  `CAP_NET_BIND_SERVICE` / `CAP_MKNOD`) — the container backend on bazzite
  publishes high ports and passes GPUs via `--device`, which only works
  because device *access* (not creation) is available to the rootless user.

## 2. Two integration levels

### Level 1 — VM as the workload host (recommended first step)

A libvirt domain boots a cloud image that runs **podman inside the guest**;
the existing container backend and the whole `workload_*` API then run inside
the VM unchanged. `lib/workload-runtime.sh` needs no new renderer — the guest
re-creates the bazzite/work environment (same `lib/workload-runtime.sh`, same
run scripts) inside a stronger boundary.

What this requires:

- **Guest image**: a cloud image (`Fedora-CoreOS`, `fedora-cloud`, `debian
  generic-cloud`) with podman + `lib/workload-runtime.sh` baked in via cloud-init
  (write_files + runcmd), or CoreOS Ignition. No OCI-on-libvirt problem — the
  OCI workflow stays inside the guest.
- **Workspace sharing**: virtiofs share for the workspace + `~/.pi/agent`
  staging (see §5 caveats), or git as the transport (clone/push via host-side
  bare repo) if virtiofs is too coarse.
- **Secrets**: infisical CLI works unchanged in the guest (outbound HTTPS).
  No host env forwarding across the VM boundary — inject via cloud-init
  `write_files` into the guest, or run `infisical run` inside the guest.
- **Networking**: default NAT network (outbound-only) is enough for the agent
  and for peers-only serving; publish serving ports with
  `<interface type='user'>`-style hostfwd (user-mode net) or a forwarded port
  on the NAT network.
- **Lifecycle**: `virt-install --import` + cloud-init for first boot, then
  `virsh start/shutdown`; snapshots give the "reset the agent box" workflow
  that podman approximates with `container rm`.

Code cost: a thin `vm-run.sh`-style helper (define/tear down domain, wait for
SSH, exec a script inside). **No changes to the `workload_*` API.**

### Level 2 — VM as the workload itself (new libvirt backend)

A `_workload='libvirt'` backend in `lib/workload-runtime.sh` rendering `workload_*`
descriptions to domain XML / `virt-install`. The mapping, for the record:

| `workload_*` API | libvirt rendering |
|---|---|
| `workload_name` | domain name (`virsh define/start`) |
| `workload_image` | **does not map** — needs a cloud image + cloud-init seed instead of an OCI ref (this is the main gap) |
| `workload_publish h g` | `<interface type='user'>` + hostfwd, or NAT-network port forward |
| `workload_ro` / `workload_rw` | virtiofs share (`<filesystem type='mount'>` + virtiofsd); read-only via virtiofs `--shared-dir` ro or guest mount option |
| `workload_gpu` | VFIO `<hostdev>` PCI passthrough — whole GPU only (§4) |
| `workload_user` | guest-managed (cloud-init user); host UID mapping is meaningless |
| `workload_env` / `workload_env_set` | cloud-init or `ssh` injection — no `--env` equivalent |
| `workload_init` / `workload_hardening` | N/A / subsumed (the guest has no host access beyond explicit shares) |
| `workload_rm` / `workload_logs` | `virsh destroy/undefine`, journal via serial console or guest journald |

This is a real backend, not a flag-flip — and only Level-1's gap list (image
model, sharing, secrets) shrinks. Defer until Level 1 proves insufficient.

## 3. Host prerequisites (verify on bazzite)

```sh
# virtualization present + permitted for the user
ls -l /dev/kvm && lsmod | grep -E 'kvm_(amd|intel)'
sudo dnf install -y qemu-kvm libvirt virt-install virt-viewer \
     edk2-ovmf virtiofsd swtpm guestfs-tools libguestfs-rescue-e2fsprogs
sudo systemctl enable --now libvirtd
# non-root user session vs system daemon: pick ONE story
libvirt-host-validate 2>/dev/null || virt-host-validate      # TSC/KVM/IOMMU report
systemctl --user status virtqemud virtstoraged 2>/dev/null   # user-session daemons
```

- **Session vs system daemon**: rootless (bazzite's default posture) wants
  `qemu:///session` (per-user `virtqemud`); SELinux sVirt confinement of QEMU
  processes is a *system-session* feature, so a system daemon + polkit is the
  choice if guest process labeling matters. Decide per host; the container
  backend keeps its own SELinux story either way.
- **SELinux on bazzite**: virtiofsd runs confined (`virtiofsd_t`); shared dirs
  may need `setsebool -P virtiofs_use_execmem` and proper labels
  (`container_file_t` / `virtiofs_content_t`) — same class of friction as the
  `:z,U` handling `lib/workload-runtime.sh` already centralizes.

## 4. Serving scenario (`llm-reverse-proxy`) in a VM

- **Peers-only serving (cpu image)**: fully viable at Level 1 or 2. The
  llama-swap container is stateless, outbound-only, one published port; give
  the VM 2 vCPU / 1–2 GB and a NAT network. This is the easiest first target —
  e.g. isolate the untrusted-facing peer endpoint (8654b72a… reverse proxy) in
  a VM while local inference stays on the host.
- **Local GGUF inference**: the blocker is GPU compute:
  - **VFIO PCI passthrough** of the gfx1030 to the guest works technically
    (IOMMU group must isolate the GPU: check
    `find /sys/kernel/iommu_groups -type l`, `amd_iommu=on iommu=pt` kernel
    args, `vfio-pci` early-bind) **but transfers the entire GPU to the VM for
    its lifetime** — on bazzite (single dGPU desktop) that means the host
    desktop loses the GPU while serving, and the VM now owns a 16 GB device
    exclusively. Requires `rom-file`/reset handling for AMD Navi21 (vendor
    reset quirk).
  - **virtio-gpu / Venus (Vulkan passthrough)** is a rendering path; ROCm/HIP
    compute does not work through it. Not an option for llama.cpp.
  - **AMD SR-IOV / MxGPU**: not supported on gfx1030 in practice.
  → **Verdict: keep local inference on the host container backend.** A VM
  serving configuration only makes sense with a *second* GPU dedicated to
  VFIO, or for CPU-only GGUF (where the VM's pinned-RAM tax buys isolation at
  a real throughput cost on this 1-GPU host).
- **HF cache**: mount via virtiofs (rw) works, but weight loading is
  mmap-heavy; a dedicated virtio-blk disk for the cache gives better cold-start
  than a network-ish FS. Either way the `launch-gguf.sh` resolver is unchanged
  (it only needs the hub layout at a path).

## 5. Usage scenario (`coding-agent`) in a VM

Fully viable and the better isolation win (agent `bash` behind a kernel
boundary). Requirements beyond Level 1:

- **Workspace**: virtiofs rw share (or in-guest clone + push-back). Caveats:
  mmap-heavy tooling over virtiofs is slower than 9p-free native; file
  ownership mapping needs `virtiofsd --idmap` or matching UIDs in the guest
  (map the guest user to the host UID to keep git happy).
- **Credentials**: SSH agent forwarding or copied keys; git config via
  cloud-init; pi `auth.json` staged into the guest like `run.sh` stages it
  into the container today.
- **Network**: NAT (outbound-only) suffices; tailscale can run inside the
  guest if the agent must be reachable.
- **Rollback**: external qcow2 snapshots per session = cheap "clean room"
  semantics for the agent, which podman cannot give (the workspace survives
  only on the shared mount — decide deliberately what is inside vs outside
  the snapshot).

## 6. Decision record

1. **Do not build a full libvirt backend now.** Level 1 (podman inside a VM)
   reuses everything; implement a minimal VM helper if/when a workload
   actually needs kernel-boundary isolation.
2. **First candidate workload**: the untrusted-facing peers-only serving
   instance, or the coding-agent with an untrusted-repo workflow.
3. **Never migrate local GGUF serving into a VM** on the current 1×gfx1030
   host; revisit only with a second VFIO-dedicated GPU.
4. PRoot stays retired regardless — a VM backend fills the "stronger than
   container" slot, not the "weaker than container" one PRoot occupied.

## References

- `lib/workload-runtime.sh` — current container-only workload runner.
- [container-tooling.md](container-tooling.md) — `workload_*` API + PRoot removal note.
- [sandbox-helper-env-analysis.md](sandbox-helper-env-analysis.md) — why PRoot is not a workload (§2–3).
- libvirt domain XML (hostdev/VFIO, filesystem/virtiofs), `virt-install --cloud-init`, `virt-host-validate`.
