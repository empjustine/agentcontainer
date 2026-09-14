#!/bin/sh
# run.sh — llama-swap launcher for LOCAL GGUF inference (container hosts only;
# podman/docker via the declarative sandbox API).
#
# Cloud/remote peer relaying is served by ../llm-reverse-proxy — this launcher
# runs the single llama-swap instance that owns local llama.cpp serving.
#
# Port model (docs/d027): llama-swap publishes LAN port
# ${HOST_PORT:-8101} → in-container 8080. Host port 8080 belongs to
# ../llm-reverse-proxy — the tailscale funnel serves the whole <funnel-id>
# route on it, and the proxy points the local face back at this instance on
# loopback ("llama-swap": "http://127.0.0.1:8101" in its deployed config).
# The legacy 18080 port stays dead.
#
# Env overrides:
#   GENERATE           1 = regenerate config.d first (./generate.sh)
#   HOST_PORT          container published port (default 8101)
#   LLAMA_SWAP_IMAGE   container image override
#   HF_HUB_CACHE       HF cache override (default XDG_CACHE_HOME/huggingface/hub;
#                      must match the cache ./generate.sh baked model paths from)

set -eu
# shellcheck disable=SC1091
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='llm-local-inference/run'
export LOG_TOOL

script_dir="$(cd "$(dirname "$0")" && pwd)"
config_d="$script_dir/config.d"
HOST_PORT="${HOST_PORT:-8101}"

[ -d "$config_d" ] ||
	log_die 94 "config.d not found — generate it first with ./generate.sh" dir="$config_d"

[ -f "$config_d/10-local-llm-inference.yaml" ] ||
	log_die 94 "no local-inference layer in config.d — this host cannot serve local inference (run ./generate.sh on a GPU-capable container host)" dir="$config_d"

# Secrets: arrive as plain environment — loaded by the explicit chain
# (./lib/environment.sh ./run.sh, the ONE infisical round-trip) and forwarded
# through the workload_env allowlist below. PEER_API_KEY is llama-swap's
# inbound bearer key (00-general.yaml apiKeys) — the key clients present, not
# a provider key. HF_TOKEN is deliberately NOT forwarded: model paths are
# baked into the generated config at generation time (docs/d029 option B), so
# nothing in-container downloads — provisioning is local-llm/download_models.py
# on the HOST.

# Staleness preflight (docs/d029 B): the generated cmds bake
# models--<org>--<repo>/snapshots/<sha>/<file> paths resolved at generation
# time. A later download/prune cycle (local-llm/upkeep.py) can delete that
# snapshot — which would otherwise surface as a llama-server 127 only at
# model-swap time. The generator's .paths manifest lists every host-side file
# it verified; any miss means the cache changed since generation.
paths_file="$config_d/10-local-llm-inference.paths"
if [ -f "$paths_file" ]; then
	while IFS= read -r baked_path; do
		[ -n "$baked_path" ] || continue
		[ -e "$baked_path" ] ||
			log_die 95 "model file baked into config.d is gone from the HF cache — cache changed since generation; re-run ./generate.sh" path="$baked_path"
	done <"$paths_file"
fi

# shellcheck disable=SC2154  # _workload is set by the sourced lib/workload-runtime.sh
[ "$_workload" = 'workload' ] ||
	log_die 91 "no container tool (podman/docker) — local inference requires the container backend"

HF_HUB_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/huggingface/hub"
container_id='llama-swap'
image="${LLAMA_SWAP_IMAGE:-ghcr.io/mostlygeek/llama-swap:unified-vulkan}"

log_info "serving local inference" image="$image" port="$HOST_PORT"

workload_rm "$container_id"
workload_name     "$container_id"
workload_image    "$image"
workload_detach
workload_init
workload_publish  "$HOST_PORT" 8080
workload_user
workload_gpu
# Guest path = the generator's HUB_GUEST constant (generate-local-llm-models
# bakes cmd paths against it) — changing one means changing both in the same
# edit. Read-only: nothing in-container writes the cache anymore (no launch-
# time downloads); provisioning/pruning happen on the host (local-llm/).
workload_ro       "$HF_HUB_CACHE" /home/ubuntu/.cache/huggingface/hub
workload_ro       "$config_d" /etc/llama-swap/config.d
workload_hardening
workload_env_allowlist PEER_API_KEY
workload_entrypoint 'llama-swap'
workload_cmd      -config-dir /etc/llama-swap/config.d -listen 0.0.0.0:8080
# No infisical wrapper here: the values were loaded by the explicit chain
# (./lib/environment.sh ./run.sh) and are forwarded through the workload_env
# allowlist above.
workload_run

sleep 5
workload_logs "$container_id" | head
