#!/data/data/com.termux/files/usr/bin/sh
# Native (no-container) serve path for Termux / a50-style hosts.  Complements
# run.sh (the containerized multipurpose instance) — same config.d/, just
# executed by the native llama-swap binary instead of a container.  Build the
# binary first with build.sh (on termux it builds the native android/arm64
# llama-swap binary).  Termux has no podman/docker and no GPU,
# so generate.sh produces a peers-only config.d/ here by construction; this
# path replaced the retired PRoot sandbox (proot was dropped as a backend —
# ptrace path translation is not isolation).
#
# The native llama-swap binary resolves the ${env.*} references in config.d/
# from its process environment.  Secrets (PEER_API_KEY, provider keys) are no
# longer read from a .env file: export them in the shell before running, or rely
# on Infisical on non-Termux hosts.  A local .env is still honored if present
# (optional, never required).

script_dir="$(cd "$(dirname "$0")" && pwd)"
config_d="$script_dir/config.d"

if [ -f "$script_dir/.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$script_dir/.env"
	set +a
fi

ip addr show dev wlan0 2>/dev/null || true

exec ~/ls-build/llama-swap-termux -config-dir "$config_d" -listen "${LISTEN:-:8080}"
