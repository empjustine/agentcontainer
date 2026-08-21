#!/bin/sh
# Shared description-driven sandbox runner for the agentcontainer run scripts.
#
# Supported backends: rootless podman and rootful docker (the "container"
# backend). PRoot was removed as a supported backend — it is a ptrace
# path-translation shim, not a sandbox (no namespaces, no cgroups, no real
# root, no GPU passthrough); the termux/a50 path serves natively via
# openai-completions/run-native.sh instead. A qemu/libvirt VM backend is
# assessed in docs/d020-libvirt-qemu-sandbox.md (not implemented).

# path resolution (the only "where do I live" logic; run scripts reuse these)
# shellcheck disable=SC2034  # exported-by-contract for sourcing scripts
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Infisical identity, pinned so `infisical` resolves the correct workspace from
# any working directory (proposals-upstream.md D). Self-hosted instances override
# INFISICAL_API_URL; the project id matches the workspaceId in the checked-in
# .infisical.json.  Exported so the generate/run scripts reference these instead
# of duplicating the literal across six scripts.
INFISICAL_API_URL="${INFISICAL_API_URL:-https://app.infisical.com}"
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-628c46b6-a5d5-4671-9435-c205847397ce}"
export INFISICAL_API_URL INFISICAL_PROJECT_ID

# backend detection
_container_tool=''
_userns=''
_keep_groups=''

detect_container_tool() {
	if [ -x /usr/bin/podman ]; then
		_container_tool='podman'; _userns='--userns=keep-id'
		_keep_groups='--group-add keep-groups'
	elif [ -x /usr/bin/docker ]; then
		_container_tool='docker'; _userns=''; _keep_groups=''
	else
		return 1
	fi
	return 0
}

_sandbox='none'
detect_container_tool && _sandbox='container'

# description (accumulators)
_SB_NAME=''
_SB_IMAGE=''
_SB_MODE=''
_SB_INIT=0
_SB_NETWORK=''
_SB_USER=0
_SB_GPU=0
_SB_HARDEN=0
_SB_PORTS=''
_SB_DEV=''
_SB_ENV=''
_SB_ENVSET=''
_SB_WORKDIR=''
_SB_CMD=''
_SB_ENTRYPOINT=''
_sb_vol_n=0

# declarative API
sandbox_name()     { _SB_NAME="$1"; }
sandbox_image()    { _SB_IMAGE="$1"; }
sandbox_detach()   { _SB_MODE='detach'; }
sandbox_interactive() { _SB_MODE='interactive'; }
sandbox_init()     { _SB_INIT=1; }
sandbox_network()  { _SB_NETWORK="$1"; }
sandbox_user()     { _SB_USER=1; }
sandbox_gpu()      { _SB_GPU=1; detect_gpu_devs; }
sandbox_hardening(){ _SB_HARDEN=1; }
sandbox_publish()  { _SB_PORTS="$_SB_PORTS $1:$2/tcp"; }
sandbox_env()      { _SB_ENV="$_SB_ENV $*"; }
sandbox_env_set()  { _SB_ENVSET="$_SB_ENVSET $*"; }
sandbox_workdir()  { _SB_WORKDIR="$1"; }
sandbox_cmd()      { _SB_CMD="$*"; }
sandbox_entrypoint(){ _SB_ENTRYPOINT="$1"; }

sandbox_ro()  { _require "$1" "read-only mount $1"  && _sb_add_vol ro  "$1" "$2"; }
sandbox_rw()  { _require "$1" "read-write mount $1" && _sb_add_vol rw  "$1" "$2"; }
sandbox_ro_if() { [ -e "$1" ] && _sb_add_vol ro  "$1" "$2"; }
sandbox_rw_if() { [ -e "$1" ] && _sb_add_vol rw  "$1" "$2"; }

sandbox_rm() {
	[ "$_sandbox" = 'container' ] || return 0
	# Remove by name through every backend, not just the one picked for `run`.
	# podman and docker keep separate stores, so a stale container left by the
	# other tool (or a tool-detection flip between runs) would otherwise slip
	# past a single-backend `rm` and collide with the new `--name` at run time.
	for _ct in podman docker; do
		command -v "$_ct" >/dev/null 2>&1 || continue
		"$_ct" container rm -f "$1" >/dev/null 2>&1 || true
	done
}
sandbox_logs() {
	[ "$_sandbox" = 'container' ] || return 0
	"$_container_tool" logs "$1"
}

_require() { [ -e "$1" ] || { >&2 printf "fatal: %s not found\n" "$2"; exit 91; }; }

_sb_add_vol() {
	_sb_vol_n=$((_sb_vol_n + 1))
	eval "_sb_vol_${_sb_vol_n}_t=\"\$1\" _sb_vol_${_sb_vol_n}_h=\"\$2\" _sb_vol_${_sb_vol_n}_g=\"\$3\""
}

detect_gpu_devs() {
	for _n in /dev/kfd /dev/dri/renderD*; do
		[ -e "$_n" ] && _SB_DEV="$_SB_DEV $_n"
	done
}

# render
_render_mount() {
	_mt="$1"; _mh="$2"; _mg="$3"; _mo=''
	if [ "$_container_tool" = 'podman' ]; then
		_mo='z,U'
		[ "$_mt" = 'ro' ] && _mo="$_mo,ro"
	elif [ "$_container_tool" = 'docker' ]; then
		_mo='z'
		[ "$_mt" = 'ro' ] && _mo="$_mo,ro"
	fi
	_mnt="$_mh:$_mg:$_mo"
}

_render_container() {
	[ -n "$_SB_IMAGE" ] || { >&2 printf "fatal: sandbox_image not set\n"; exit 91; }
	set --
	[ "$_SB_INIT" = 1 ] && set -- "$@" --init
	case "$_SB_MODE" in
		detach)      set -- "$@" --detach ;;
		interactive) set -- "$@" -it ;;
	esac
	[ -n "$_SB_NAME" ]    && set -- "$@" --name="$_SB_NAME"
	[ -n "$_SB_NETWORK" ] && set -- "$@" --network="$_SB_NETWORK"
	[ -n "$_SB_ENTRYPOINT" ] && set -- "$@" --entrypoint "$_SB_ENTRYPOINT"
	if [ "$_SB_USER" = 1 ]; then
		_uid="${SUDO_UID:-$(id -u)}"; _gid="${SUDO_GID:-$(id -g)}"
		[ -n "$_userns" ]     && set -- "$@" $_userns
		set -- "$@" --user "$_uid:$_gid"
		# shellcheck disable=SC2086  # needs word splitting
		[ -n "$_keep_groups" ] && set -- "$@" $_keep_groups
	fi
	for _p in $_SB_PORTS; do set -- "$@" --publish "$_p"; done
	for _d in $_SB_DEV;   do set -- "$@" --device "$_d:$_d:rw"; done
	[ "$_SB_HARDEN" = 1 ] && set -- "$@" --cap-drop=all --security-opt no-new-privileges
	_i=1
	while [ "$_i" -le "$_sb_vol_n" ]; do
		eval "_t=\"\$_sb_vol_${_i}_t\" _h=\"\$_sb_vol_${_i}_h\" _g=\"\$_sb_vol_${_i}_g\""
		# shellcheck disable=SC2154  # eval-assigned above
		_render_mount "$_t" "$_h" "$_g"
		set -- "$@" -v "$_mnt"
		_i=$((_i + 1))
	done
	for _e in $_SB_ENV;    do set -- "$@" --env "$_e"; done
	for _e in $_SB_ENVSET; do set -- "$@" --env "$_e"; done
	[ -n "$_SB_WORKDIR" ] && set -- "$@" --workdir "$_SB_WORKDIR"
	# shellcheck disable=SC2086  # needs word splitting
	$_wrapper "$_container_tool" container run "$@" "$_SB_IMAGE" $_SB_CMD
}

# sandbox_run [wrapper...] — render and launch; wrapper (e.g. infisical run … --)
# prefixes the launch command.
sandbox_run() {
	_wrapper="$*"
	[ "$_sandbox" = 'container' ] || {
		>&2 printf "fatal: no sandbox backend available (need podman or docker)\n"
		exit 91
	}
	_render_container
}
