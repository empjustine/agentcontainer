#!/bin/sh
# re-chown — re-claim root-owned files after rootful container runs.
# Usage: ./re-chown [path] (default: CWD).  Uses "podman unshare chown" when
# podman is available, else "sudo chown".

_path="${1:-.}"
_path="$(cd "$_path" 2>/dev/null && pwd)" || {
  >&2 printf 'error: cannot resolve %s\n' "${1:-.}"
  exit 1
}

if [ -x /usr/bin/podman ]; then
  # In the podman user namespace, UID 0 = the host user (rootless mapping).
  podman unshare chown -R 0:0 "$_path" || {
    >&2 printf 'error: podman unshare chown failed\n'
    exit 1
  }
elif [ -x /usr/bin/docker ]; then
  # When invoked via sudo, SUDO_UID / SUDO_GID carry the original caller's
  # identity; when invoked directly, fall back to the current user.
  sudo chown -R "${SUDO_UID:-$(id -u)}:${SUDO_GID:-$(id -g)}" "$_path" || {
    >&2 printf 'error: sudo chown failed\n'
    exit 1
  }
else
  >&2 printf 'error: no container tool (podman or docker) found\n'
  exit 1
fi
