#!/data/data/com.termux/files/usr/bin/sh

script_dir="$(cd "$(dirname "$0")" && pwd)"
config_d="$script_dir/config.d"
env_file="$script_dir/.env"

set -a
source "$env_file"
set +a

ip addr show dev wlan0 2>/dev/null || true

exec ~/ls-build/llama-swap-termux -config-dir "$config_d" -listen "${LISTEN:-:8080}"
