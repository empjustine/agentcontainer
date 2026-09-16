---
id: vm-build-bench
type: reference
status: draft
title: "VM build bench — d020 Level-1 SOP (vm-bench.sh runbook)"
parent: architecture
tags: ["reference", "runbook", "vm", "d020"]
---

# VM build bench (d020 Level 1) — SOP

This is the standard operating procedure for provisioning a **libvirt/qemu VM
workload host** on a supplement-capable Linux desktop host (Bazzite / Fedora),
per the Level-1 shape assessed in
[d020-libvirt-qemu-sandbox.md](d020-libvirt-qemu-sandbox.md) §2: the guest
boots a cloud image, installs podman in the guest, and re-uses the repo's
`workload_*` container API **unchanged inside the stronger boundary**.
`vm-bench.sh` at the repo root automates every step below; this document is
the rationale + manual fallback, the script is the artifact.

> **Why this exists now:** the coding-agent container already runs rootless,
> but it cannot legitimately use the HOST podman socket (that lease is a full
> user-data control channel — see the threat position note in
> [container-tooling.md](container-tooling.md)). A nested rootless podman in
> the agent container would be degraded to the `vfs` storage driver (no
> `/dev/fuse`, unprivileged overlay `upperdir` is rejected). The VM is the
> honest test bench: full kernel, real fuse-overlayfs, real cgroups v2.

## One-time host prerequisites

Perform **on the host**, not inside the agent container (the guest needs real
kernel access, `qemu:///session`, and buffered storage):

```sh
. vm-bench.sh check   # → confirms /dev/kvm, tools, and prints the missing list
. vm-bench.sh deps    # → rpm-ostree install (Bazzite) or sudo dnf install
```

On Bazzite (rpm-ostree) **`deps` finishes with a required reboot**: the layered
packages (`qemu-kvm`, `libvirt`, `virt-install`, `guestfs-tools`) only re-appear
in the booted image after the layered packages land — nothing takes effect until the session daemons restart.

Both steps are **deliberately session-scoped**: the `deps` step ends with
`systemctl --user enable --now virtqemud.socket virtstoraged.socket
virtnetworkd.socket`, so the guest is owned by YOUR user session — no root daemon, no polkit, no port publication
under 1024 (the same rootless-podman constraints the container backend already
documents in [container-tooling.md](container-tooling.md) §1.1).

## Provisioning

```sh
. vm-bench.sh provision
```

What `provision` does, so this SOP stays true if the artifact drifts:

1. Generates an ed25519 keypair at `~/.ssh/id_ed25519` if absent (used only
   for the guest; `vm-bench.sh` never touches other keys).
2. Fetches the Fedora cloud image matching the **host's** Fedora lane —
   `download.fedoraproject.org/.../releases/<FEDORA_RELEASE>/Cloud/x86_64/images/…`
   into `~/.local/share/libvirt/vm-bench/disk0.qcow2`, resizing it to
   `DISK_GIB` (default 20 GiB — ~3 GiB image + ~6 GiB unpacked coding-agent
   layers + layer cache headroom). `CLOUD_IMAGE_URL` is the
   override knob if upstream renames the artifact again.
3. Emits a **cloud-init NoCloud seed** (via `xorrisofs` into a `cidata` ISO)
   with:
   - guest user `bench` (sudo NOPASSWD via wheel, OUR new key);
   - packages `podman`, `rsync` (the guest needs NO other runtime — that is
     the whole point of Level 1: the existing `workload_*` API runs unchanged
     inside the guest, docs/d020 §2);
   - runcmd: `loginctl enable-linger` (so podman stays usable over ssh).
4. Defines + boots the domain with `virt-install --connect qemu:///session
   --import` and **`--network user,model=virtio,hostfwd=tcp::2222-:22`**
   (slirp user-mode net — outbound-only, so it satisfies the d020 §5 "NAT
   (outbound-only) suffices" requirement without any system daemon).
5. Polls ssh up to 6 min (`SSH_PORT` override), then reports. under `~/.local/share/libvirt/vm-bench/` (`SYSPAD` override) —
**no image, disk, or state file is committed to the repo** (mirrors the d044
principle: heavy/ephemeral storage never lives in-tree). `rm -rf` that dir +
`. destroy` is the full "burn it down" reset.

## Operating the bench

| command | meaning |
|---|---|
| `sync` | rsyncs the repo into `~/${VM_NAME}/` inside the guest (default `/home/bench/agent-build-bench/`) (transport = ssh/rsync per d020 §5, NOT virtiofs — the bench needs a snapshot, not live sharing, and slirp+rsync skips the virtiofsd_t SELinux friction d020 §3 flags) |
| `bench` | **the actual test**: inside the guest's rootless podman runs the agent Containerfile with `--progress=plain` (mandatory — see build.mjs comment) and `mise` under the Containerfile's own `MISE_QUIET=1`/`NO_COLOR=1` ENV. Then smoke-runs the image in the guest. |
| `snapshot` / `rollback` | `virsh snapshot-create-as` / `snapshot-revert --current` — the "clean-room" reset podman cannot offer (d020 §5's "clean room" semantics; the synced workspace is OUTSIDE the snapshot) |
| `status` / `ssh` / `destroy` | `virsh domstate`, an interactive shell, `shutdown`+`undefine --nvram` |

## Validation checklist (what "the bench passed" means)

1. Guest boots from cloud image with the seed (user reachable on :2222).
2. `podman info` in the guest reports **kvm**-accelerated qemu + **fuse-overlayfs**
   (not vfs) — that's the FULL-kernel result nested-in-agent-container can
   never give.
3. `bench` chapter: `coding-agent/Containerfile` builds end-to-end in the
   guest and the image answers `echo SMOKE_OK` — the same Containerfile
   runs on a real isolated host, not just inside the agent container.
4. jsonlines from `vm-bench.sh` remain parseable line-by-line — confirming
   the bench, like every repo tool, honors d045 (no tty progress redraw).

## References

- [d020-libvirt-qemu-sandbox.md](d020-libvirt-qemu-sandbox.md) — the Level-1 / Level-2 decision record (requirements assessment; Level 2 never built).
- [container-tooling.md](container-tooling.md) — why the host podman socket is NOT a substitute (threat position).
- `vm-bench.sh` — the automation this SOP describes.
