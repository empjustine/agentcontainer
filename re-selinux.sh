#!/bin/sh
# re-selinux — re-label SELinux context for container access.
# Usage: ./re-selinux [path] (default: CWD).  Runs a throwaway rootless podman
# container that mounts PATH with :z so podman handles the relabel to
# container_file_t.  No-op (silently skipped) on non-SELinux systems.

# shellcheck disable=SC1091
. "$(dirname "$0")/lib/log.sh"
LOG_TOOL='re-selinux'
export LOG_TOOL

_path="${1:-.}"
_path="$(cd "$_path" 2>/dev/null && pwd)" ||
  log_die 1 "cannot resolve path" arg="${1:-.}"

# Capture stderr; show it only on failure so podman's diagnostics
# are available when something goes wrong (flight recorder pattern).
_err=$(podman run --rm \
  -v "$_path:$_path:z" \
  docker.io/library/busybox:latest \
  sleep 1 2>&1 >/dev/null) || {
  log_error "podman relabel failed" path="$_path" detail="${_err:-none}"
  exit 1
}
