#!/usr/bin/env bash
# vm-bench.sh — provision + operate the d020 Level-1 VM build bench.
#
# The podman-build test bench this container tooling cannot express in-band:
# a libvirt/qemu guest (Fedora cloud image) that runs podman INSIDE the guest
# (d020 §2 Level 1), so image builds get a real kernel — real fuse-overlayfs,
# real cgroups, real /dev/net/tun — without giving the agent container the
# host podman socket (a socket lease is a full user-data control channel and
# was rejected; see the container-tooling threat-position note).
# Full docs/thinking: docs/vm-build-bench.md (the SOP this script automates).
#
# Posture: everything under `qemu:///session` (the rootless posture d020 §3
# pinned) plus `--network user` (slirp) — no system daemon, no polkit, and
# after the one-time deps install no root at all. Guest ports reach the host
# via slirp hostfwd, so the rootless-podman high-ports rule holds by
# construction and no port < 1024 is ever promised.
#
# Whatever runs INSIDE the guest is operator-managed environment, not part of
# the workload API: lib/workload-runtime.sh gets NO libvirt backend (d020 §6
# decision 1) — this script exists so that stays true.
#
# Commands:
#   check      verify host prerequisites (kvm, tools) — no root needed
#   deps       one-time package install (Bazzite/ostree: rpm-ostree + reboot)
#   provision  fetch image, define guest + cloud-init (user/key/podman), wait for ssh
#   sync       rsync the repo tree into the guest
#   bench      nested-podman inception build inside the guest (the actual test)
#   ssh        interactive shell into the guest
#   status|snapshot|rollback|destroy
#
# Env overrides: VM_NAME · CPUS · MEMORY_MIB · DISK_GIB · FEDORA_RELEASE ·
#   SSH_PORT · GUEST_USER · SSH_KEY · SYSPAD
#
# Logging: lib/log.sh (docs/d045) — jsonlines, no level filtering.

set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=lib/log.sh
. "${SCRIPT_DIR}/lib/log.sh"
LOG_TOOL="vm-bench"

# --- config ------------------------------------------------------------------

VM_NAME="${VM_NAME:-agent-build-bench}"
CPUS="${CPUS:-4}"
MEMORY_MIB="${MEMORY_MIB:-4096}"
# 20 GiB comfortably over a fedora-cloud-base (~3 GiB soil) plus one
# coding-agent image build's unpacked layers (~6 GiB) and its layer cache.
DISK_GIB="${DISK_GIB:-20}"
# Stay on the host's Fedora release lane (the bench's toolchain should match
# what build.mjs targets at compile time); a FEDORA_RELEASE bump is a
# provision-from-scratch event, not a guest in-place upgrade.
FEDORA_RELEASE="${FEDORA_RELEASE:-43}"
SSH_PORT="${SSH_PORT:-2222}"
GUEST_USER="${GUEST_USER:-bench}"
GUEST_HOME="/home/${GUEST_USER}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
# Everything lives under the operator's own home — session qemu never needs
# root for storage, and SELinux user-confined session daemons keep it that way.
SYSPAD="${SYSPAD:-$HOME/.local/share/libvirt/vm-bench}"
# early-system-storage reserved for operator override: (see cloud-image url)
IMAGE_FILE="${SYSPAD}/disk0.qcow2"

# cloud image coordinates: Fedora's mirrored URL layout; if the artifact name
# drifts again (it has before: Fedora-Cloud-Base → -Generic), CLOUD_IMAGE_URL
# is the override knob and mirror.repo URLs are the manual fallback (d020 §3
# points at download.fedoraproject.org's index).
CLOUD_IMAGE_URL="${CLOUD_IMAGE_URL:-https://download.fedoraproject.org/pub/fedora/linux/releases/${FEDORA_RELEASE}/Cloud/x86_64/images/Fedora-Cloud-Base-Generic.x86_64-${FEDORA_RELEASE}-${CLOUD_IMAGE_VER:-1.2}.qcow2}"

QEMU_CONNECT="${QEMU_CONNECT:-qemu:///session}"

guest() {
	ssh -o "User=${GUEST_USER}" \
		-o StrictHostKeyChecking=no \
		-o UserKnownHostsFile=/dev/null \
		-o IdentitiesOnly=yes -i "${SSH_KEY}" \
		-p "${SSH_PORT}" 127.0.0.1 "$@"
}

libvirt() {
	virsh --connect "${QEMU_CONNECT}" "$@"
}

# --- check -------------------------------------------------------------------

cmd_check() {
	log_info "checking host prerequisites" fedora_release="${FEDORA_RELEASE}"
	# /dev/kvm absence only DEGRADES the bench (tcg emuration), so a warning
	# not a fatal error: the Point-of-bca bench keeps fail-loudly for the
	# things that would lie.
	if [ ! -c /dev/kvm ]; then
		log_warn "/dev/kvm not present — builds will run under tcg emulation (10-50x slower); see 'deps'"
	elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
		log_warn "/dev/kvm present but not rw for this user — kvm group membership or udev rule needed"
	fi
	for want in virt-install virsh ssh-keygen rsync curl jq; do
		command -v "$want" >/dev/null 2>&1 ||
			log_warn "missing tool — 'deps' installs it" tool="$want"
	done
	if command -v virt-host-validate >/dev/null 2>&1; then
		virt-host-validate qemu 2>&1 | tail -5 | sed 's/^/  /' || true
	fi
	if [ ! -s "${SSH_KEY}" ] || [ ! -s "${SSH_KEY}.pub" ]; then
		log_warn "no ssh keypair yet — 'provision' will generate one" path="$SSH_KEY"
	fi
	log_info "host check done"
}

# --- deps --------------------------------------------------------------------

cmd_deps() {
	if command -v rpm-ostree >/dev/null 2>&1; then
		# Bazzite is rpm-ostree: package layers need a reboot before the
		# session daemons restart with them present (d020 §3 caveat).
		log_info "ostree host — layering packages; a REBOOT is required before provision"
		rpm-ostree install --assumeyes \
			qemu-kvm libvirt virt-install guestfs-tools curl jq
	else
		log_info "traditional rpm host — installing via dnf -y"
		sudo dnf install -y \
			qemu-kvm libvirt virt-install guestfs-tools curl jq
	fi
	# User-session daemon sockets (virtqemud/virtstoraged/virtnetworkd) —
	# this is the whole rootless story; the system libvirtd stays untouched.
	systemctl --user enable --now \
		virtqemud.socket \
		virtstoraged.socket \
		virtnetworkd.socket 2>&1 ||
		log_warn "session sockets not started — re-run after the reboot"
	log_info "deps done"
}

generate_key() {
	if [ ! -s "$SSH_KEY" ]; then
		log_info "generating ssh keypair" path="$SSH_KEY"
		ssh-keygen -t ed25519 -N "" -f "$SSH_KEY"
	fi
}

# cloud-init user-data: guest user + operator key + podman toolchain. The
# guest mirrors the rootless posture of docs/container-tooling.md ('--plain'
# backend detection, high ports) but with the FULL kernel (fuse, cgroups v2,
# tun) that a VM boundary actually provides.
_cloud_init_user_data() {
	cat <<YAML
#cloud-config
users:
  - name: ${GUEST_USER}
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: [wheel]
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "${SSH_KEY}.pub")
packages:
  - podman
  - rsync
runcmd:
  # The guest's rootless podman defaults already do the right thing
  # (overlay + fuse-overlayfs, native cgroups v2), so no storage.conf edits
  # are needed here — the VFS-only degradation mode is THIS container's
  # constraint, not the guest's.
  - loginctl enable-linger ${GUEST_USER}
YAML
}

# --- provision ---------------------------------------------------------------

cmd_provision() {
	generate_key
	mkdir -p "${SYSPAD}"
	if [ ! -s "${IMAGE_FILE}" ]; then
		log_info "fetching cloud image" release="${FEDORA_RELEASE}"
		curl -fSL -o "${IMAGE_FILE}" "${CLOUD_IMAGE_URL}"
		qemu-img resize "${IMAGE_FILE}" "${DISK_GIB}G"
	fi
	if libvirt dominfo "${VM_NAME}" >/dev/null 2>&1; then
		log_die 70 "vm already exists — run 'destroy' first" name="${VM_NAME}"
	fi
	# The seed files live beside the image; cloud-init picks up only paths
	# labeled cidata (meta-data + user-data) on first boot.
	_cloud_init_user_data >"${SYSPAD}/${VM_NAME}-user-data.yaml"
	printf 'instance-id: %s\nlocal-hostname: %s\n' "${VM_NAME}" "${VM_NAME}" \
		>"${SYSPAD}/${VM_NAME}-meta-data.yaml"
	local seed_iso="${SYSPAD}/${VM_NAME}-seed.iso"
	if command -v xorrisofs >/dev/null 2>&1; then
		xorrisofs -quiet -J -r -V cidata -o "${seed_iso}" \
			"${SYSPAD}/${VM_NAME}-user-data.yaml" \
			"${SYSPAD}/${VM_NAME}-meta-data.yaml"
	else
		log_die 70 "no iso tool (xorrisofs) — install guestfs-tools via 'deps'"
	fi
	log_info "defining guest" name="${VM_NAME}"
	# Attach the NoCloud seed we built (cidata label). virt-install's own
	# --cloud-init would build a SECOND seed from the same user-data and leave
	# this ISO dead, so the hand-built cidata ISO is the one that must be
	# attached.
	virt-install --connect "${QEMU_CONNECT}" \
		--name "${VM_NAME}" \
		--memory "${MEMORY_MIB}" \
		--vcpus "${CPUS}" \
		--disk path="${IMAGE_FILE}",format=qcow2 \
		--disk path="${seed_iso}",device=cdrom,readonly=on \
		--network "user,model=virtio,hostfwd=tcp::${SSH_PORT}-:22" \
		--console pty,target_type=serial \
		--noautoconsole \
		--import >/dev/null
	_wait_for_ssh
	log_info "guest reachable" port="${SSH_PORT}"
}

_wait_for_ssh() {
	log_info "waiting for ssh to come up" port="${SSH_PORT}"
	for _ in $(seq 1 90); do
		if guest /bin/true </dev/null 2>/dev/null; then
			return 0
		fi
		sleep 4
	done
	log_die 74 "ssh never became reachable — 'virsh console' via 'status' for boot messages"
}

# --- sync --------------------------------------------------------------------

# Workspace transport: ssh/rsync (d020 §5 default), not virtiofs — the bench
# only needs a tree snapshot, not live sharing, and slirp+rsync skips the
# virtiofsd confined-broker + SELinux label friction d020 §3 flags.
cmd_sync() {
	log_info "rsyncing repo into guest" dest="${GUEST_HOME}/${VM_NAME}"
	rsync -a --delete \
		--exclude .git --exclude node_modules \
		-e "ssh -o User=${GUEST_USER} -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i ${SSH_KEY} -p ${SSH_PORT}" \
		"${SCRIPT_DIR}/" \
		"${GUEST_USER}@127.0.0.1:${GUEST_HOME}/${VM_NAME}" 2>&1 | tail -3
	log_info "sync done"
}

# --- bench -------------------------------------------------------------------

# The test the bench exists for: the guest's rootless podman builds the
# coding-agent image — the exact Containerfile build.mjs would build — with
# the FULL kernel surface. --progress=plain is mandatory here (build.mjs's
# comment: default "auto" is tty-detected and renders overlapping redraw into
# captured logs) and NO_COLOR/MISE_QUIET come from the Containerfile's own ENV.
cmd_bench() {
	cmd_sync
	log_info "nested podman bench" phase="build"
	guest 'set -eu
cd '"${GUEST_HOME}/${VM_NAME}"'/coding-agent
podman image build \
  --pull --progress=plain \
  --tag localhost/vm-bench/agent:latest \
  -f Containerfile .
echo BUILD_OK'
	log_info "nested podman bench" phase="smoke"
	guest "podman run --rm localhost/vm-bench/agent:latest echo SMOKE_OK"
	log_info "bench passed"
}

# --- lifecycle ---------------------------------------------------------------

cmd_status() {
	libvirt domstate "${VM_NAME}" 2>&1 || true
}

cmd_snapshot() {
	local label
	label="pre-$(date +%Y%m%d-%H%M%S)"
	log_info "creating snapshot" label="${label}"
	libvirt snapshot-create-as "${VM_NAME}" "${label}"
}

cmd_rollback() {
	log_info "reverting to latest snapshot"
	libvirt snapshot-revert "${VM_NAME}" --current >/dev/null
	log_info "reverted"
}

cmd_destroy() {
	log_info "destroying guest" name="${VM_NAME}"
	libvirt shutdown "${VM_NAME}" 2>/dev/null || true
	sleep 2
	libvirt destroy "${VM_NAME}" 2>/dev/null || true
	libvirt undefine "${VM_NAME}" --nvram 2>/dev/null || true
	log_info "destroyed"
}

# --- dispatch ----------------------------------------------------------------

cmd="${1:-help}"
case "${cmd}" in
check) cmd_check ;;
deps) cmd_deps ;;
provision) cmd_provision ;;
sync) cmd_sync ;;
bench) cmd_bench ;;
ssh) exec guest ;;
status) cmd_status ;;
snapshot) cmd_snapshot ;;
rollback) cmd_rollback ;;
destroy) cmd_destroy ;;
help | *)
	printf '%s\n' "usage: $0 <check|deps|provision|sync|bench|ssh|status|snapshot|rollback|destroy>"
	;;
esac
