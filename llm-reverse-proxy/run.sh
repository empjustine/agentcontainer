#!/bin/sh
# run.sh — serve llm-reverse-proxy, llama-swap style (dual mode, detected
# from the environment):
#
#   container host: run the image build.sh produced, via the declarative
#     sandbox API — HOST NETWORK mode, listening on the host's
#     ${HOST_PORT:-8080} directly (the port the tailscale funnel serves the
#     <funnel-id> route on). Host networking is required, not cosmetic: the
#     deployed config routes llama-swap (the local GGUF peer, LAN 8101) at
#     http://127.0.0.1:8101 — reachable only from the host's own loopback, so
#     a bridge/slirp container would see nothing at its own 127.0.0.1. The
#     in-container -listen 0.0.0.0:${HOST_PORT} overrides the config's
#     `listen`, mirroring llama-swap's port model.
#   Termux / no container tool: exec the native binary build.sh produced
#     (llm-reverse-proxy-android on Termux; the host binary as fallback)
#     against ./llm-reverse-proxy.json and ${LISTEN:-:8080}.
#
# The proxy holds NO secrets: requests must already carry valid provider keys
# (that is the whole design — no credential handling), so unlike the
# llama-swap launcher there is no vault round-trip and no env
# allowlist here.
#
# Env overrides: HOST_PORT / LISTEN / IMAGE_TAG / LLM_PROXY_BIN / CONFIG.

set -eu
# shellcheck disable=SC1091
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/run'
export LOG_TOOL

script_dir="$SCRIPT_DIR"
config="${CONFIG:-$script_dir/llm-reverse-proxy.json}"

[ -f "$config" ] ||
	log_die 94 "config not found — copy llm-reverse-proxy.example.json to llm-reverse-proxy.json and edit it" path="$config"

# shellcheck disable=SC2154  # _workload/_workload_tool from the sourced lib
if [ "$_workload" = 'workload' ]; then
	# ========================= container backend =========================
	HOST_PORT="${HOST_PORT:-8080}"
	image="${IMAGE_TAG:-localhost/llm-reverse-proxy:latest}"
	container_id='llm-reverse-proxy'

	log_info "serving (container, host network)" image="$image" port="$HOST_PORT" config="$config"

	workload_rm "$container_id"
	workload_name     "$container_id"
	workload_image    "$image"
	workload_detach
	workload_init
	# Host network, NOT --publish: the proxy must reach llama-swap on the
	# host's own loopback (http://127.0.0.1:8101 in the deployed config),
	# and podman rejects --publish together with --network=host anyway.
	workload_network 'host'
	workload_ro       "$config" /etc/llm-reverse-proxy/llm-reverse-proxy.json
	workload_hardening
	workload_cmd      -config /etc/llm-reverse-proxy/llm-reverse-proxy.json -listen "0.0.0.0:$HOST_PORT"
	workload_run

	sleep 2
	workload_logs "$container_id" | head
else
	# ========================= native (Termux or bare host) ==============
	bin="${LLM_PROXY_BIN:-}"
	if [ -z "$bin" ]; then
		if [ -x "$script_dir/llm-reverse-proxy-android" ]; then
			bin="$script_dir/llm-reverse-proxy-android"
		elif [ -x "$script_dir/llm-reverse-proxy" ]; then
			bin="$script_dir/llm-reverse-proxy"
		fi
	fi
	[ -n "$bin" ] && [ -x "$bin" ] ||
		log_die 95 "no proxy binary — run ./build.sh first (on Termux it builds llm-reverse-proxy-android)" bin="${bin:-unset}"

	log_info "serving (native)" bin="$bin" config="$config" listen="${LISTEN:-:8080}"
	exec "$bin" -config "$config" -listen "${LISTEN:-:8080}"
fi
