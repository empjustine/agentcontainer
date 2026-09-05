#!/bin/sh
# re-chown — re-claim root-owned files after rootful container runs.
# Usage: ./re-chown [path] (default: CWD).  Uses "podman unshare chown" when
# podman is available, else "sudo chown".

# shellcheck disable=SC1091
. "$(dirname "$0")/lib/log.sh"
LOG_TOOL='re-chown'
export LOG_TOOL

_path="${1:-.}"
_path="$(cd "$_path" 2>/dev/null && pwd)" ||
  log_die 1 "cannot resolve path" arg="${1:-.}"

if [ -x /usr/bin/podman ]; then
  # In the podman user namespace, UID 0 = the host user (rootless mapping).
  podman unshare chown -R 0:0 "$_path" ||
    log_die 1 "podman unshare chown failed" path="$_path"
elif [ -x /usr/bin/docker ]; then
  # When invoked via sudo, SUDO_UID / SUDO_GID carry the original caller's
  # identity; when invoked directly, fall back to the current user.
  sudo chown -R "${SUDO_UID:-$(id -u)}:${SUDO_GID:-$(id -g)}" "$_path" ||
    log_die 1 "sudo chown failed" path="$_path"
else
  log_die 1 "no container tool (podman or docker) found"
fi
