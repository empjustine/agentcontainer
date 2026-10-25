#!/bin/sh
# run.sh — serve llm-reverse-proxy, llama-swap style (dual ROLE mode,
# PROXY_MODE=server|client — docs/d073; plus the usual dual host mode):
#
#   container host: run the image build.sh produced, via the declarative
#     sandbox API — HOST NETWORK mode in both roles. server (the default)
#     mirrors llama-swap's port model: the in-container -listen
#     0.0.0.0:${HOST_PORT:-8080} overrides the config's `listen`, and the
#     port is what the tailscale funnel serves the <funnel-id> route on.
#     Host networking is required, not cosmetic: the deployed config routes
#     llama-swap (the local GGUF peer, LAN 8101) at http://127.0.0.1:8101 —
#     reachable only from the host's own loopback, so a bridge/slirp
#     container would see nothing at its own 127.0.0.1. For the client it
#     is doubly required: the loopback CONNECT/SOCKS5 listeners become the
#     HOST's loopback (usable by host apps, and VPN-R23 forbids anything
#     else), and the container inherits the host's tailnet routes the
#     tunnel URL needs.
#   Termux / no container tool: exec the native binary build.sh produced
#     (llm-reverse-proxy-android on Termux; the host binary as fallback)
#     in the selected role.
#
# The SERVER holds NO secrets: requests must already carry valid provider
# keys (that is the whole design — no credential handling), so that path
# has no vault round-trip and no env allowlist. The CLIENT is different:
# VPN_OPERATOR_TOKEN is the one credential this runner ever carries, and
# per VPN-R44 it exists ONLY in the environment — the allowlist below
# forwards it from the host; run.sh never loads secrets itself
# (lib/environment.sh owns the vault round-trip onto the host env). The
# client has no config file at all: URL + token + optional label are its
# whole surface.
#
# Env overrides: PROXY_MODE / HOST_PORT / LISTEN / PROXY_LISTEN /
# SOCKS_LISTEN / IMAGE_TAG / LLM_PROXY_BIN / CONFIG, and for client mode
# VPN_TUNNEL_URL / VPN_OPERATOR_TOKEN / VPN_CLIENT_LABEL.

set -eu
# shellcheck disable=SC1091
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/run'
export LOG_TOOL

# SCRIPT_DIR is assigned by the sourced lib/workload-runtime.sh (derived from
# this caller's $0), which shellcheck cannot see across a source boundary.
# shellcheck disable=SC2153
script_dir="$SCRIPT_DIR"

proxy_mode="${PROXY_MODE:-server}"
case "$proxy_mode" in
server | client) ;;
*) log_die 94 "unknown PROXY_MODE — want server or client" mode="$proxy_mode" ;;
esac

# Fail the launch HERE, with the missing variable's NAME, instead of inside
# a detached container whose first log line is the only trace — the mirror
# of the server's config gate.
if [ "$proxy_mode" = client ]; then
	[ -n "${VPN_TUNNEL_URL:-}" ] ||
		log_die 94 "client mode needs VPN_TUNNEL_URL (wss://host/<capability-path>)" var=VPN_TUNNEL_URL
	[ -n "${VPN_OPERATOR_TOKEN:-}" ] ||
		log_die 94 "client mode needs VPN_OPERATOR_TOKEN (env-only credential, VPN-R44)" var=VPN_OPERATOR_TOKEN
else
	config="${CONFIG:-$script_dir/llm-reverse-proxy.json}"
	[ -f "$config" ] ||
		log_die 94 "config not found — generate it first with ./generate.sh (or copy llm-reverse-proxy.example.json for a hand-written deployment)" path="$config"
fi

# shellcheck disable=SC2154  # _workload/_workload_tool from the sourced lib
if [ "$_workload" = 'workload' ]; then
	# ========================= container backend =========================
	image="${IMAGE_TAG:-localhost/llm-reverse-proxy:latest}"
	container_id='llm-reverse-proxy'

	if [ "$proxy_mode" = client ]; then
		log_info "serving (container, host network, tunnel client)" image="$image"
	else
		HOST_PORT="${HOST_PORT:-8080}"
		log_info "serving (container, host network, server)" image="$image" port="$HOST_PORT" config="$config"
	fi

	workload_rm "$container_id"
	workload_name     "$container_id"
	workload_image    "$image"
	workload_detach
	workload_init
	workload_network 'host'
	workload_hardening
	if [ "$proxy_mode" = client ]; then
		# allowlist, not bare --env: an unset host var would inject an
		# EMPTY value the client reads as "set" (lib/workload-runtime.sh).
		# The capability prefix is not forwarded — it is part of the
		# tunnel URL path, the client's only notion of it.
		workload_env_allowlist VPN_TUNNEL_URL VPN_OPERATOR_TOKEN VPN_CLIENT_LABEL MODES
		workload_cmd -mode client \
			-proxy-listen "${PROXY_LISTEN:-127.0.0.1:3128}" \
			-socks-listen "${SOCKS_LISTEN:-127.0.0.1:1080}" \
			-modes "${MODES:-d}"
	else
		workload_ro       "$config" /etc/llm-reverse-proxy/llm-reverse-proxy.json
		workload_cmd      -config /etc/llm-reverse-proxy/llm-reverse-proxy.json -listen "0.0.0.0:$HOST_PORT"
	fi
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

	if [ "$proxy_mode" = client ]; then
		log_info "serving (native, tunnel client)" bin="$bin"
		exec "$bin" -mode client \
			-proxy-listen "${PROXY_LISTEN:-127.0.0.1:3128}" \
			-socks-listen "${SOCKS_LISTEN:-127.0.0.1:1080}" \
			-modes "${MODES:-d}"
	fi
	log_info "serving (native, server)" bin="$bin" config="$config" listen="${LISTEN:-:8080}"
	exec "$bin" -config "$config" -listen "${LISTEN:-:8080}"
fi
