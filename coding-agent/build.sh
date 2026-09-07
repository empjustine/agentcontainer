#!/bin/sh
# Build the coding-agent container image (tagged :<date> and :latest).

set -eux

# shellcheck disable=SC1091
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='coding-agent/build'
export LOG_TOOL

# shellcheck disable=SC2154  # set by sourced lib/workload-runtime.sh
[ "$_workload" = 'workload' ] ||
	log_die 91 "can't find container tool"

BUILD_DATE="$(date +'%Y%m%d')"
export BUILD_DATE

_uid="${SUDO_UID:-$(id -u)}"
_gid="${SUDO_GID:-$(id -g)}"
build_context="$SCRIPT_DIR"
containerfile="$SCRIPT_DIR/Containerfile"
tag='localhost/empjustine/coding-agent'

# shellcheck disable=SC2154  # set by sourced lib/workload-runtime.sh
case "$_workload_tool" in
	podman) set -- image build ;;
	docker) set -- buildx build ;;
esac

"$_workload_tool" "$@" \
	--pull \
	--build-arg BUILD_DATE \
	--build-arg UID="$_uid" \
	--build-arg GID="$_gid" \
	--build-arg USER="$USER" \
	--tag "${tag}:${BUILD_DATE}" \
	--tag "${tag}:latest" \
	-f "$containerfile" \
	"$build_context"
