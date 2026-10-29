#!/bin/sh
# run.sh — serve llm-reverse-proxy, llama-swap style (dual ROLE mode,
# PROXY_MODE=exit|relay — the node names, docs/d088; plus the usual dual host mode):
#
#   container host: run the image the root ./build.mjs produced (docs/d041)
#     via the declarative sandbox API — HOST NETWORK mode in both roles.
#     exit node (the default)
#     mirrors llama-swap's port model: the in-container -listen
#     0.0.0.0:${HOST_PORT:-8080} overrides the config's `listen`, and the
#     port is what the tailscale funnel serves the <funnel-id> route on.
#     Host networking is required, not cosmetic: the funnel front dials the
#     HOST's own loopback :8080 (tailscaled → the serve target), so a
#     bridge/slirp container would answer a loopback the funnel never sees.
#     For the relay node it is doubly required: the loopback CONNECT/SOCKS5
#     listeners become the HOST's loopback (usable by host apps, and
#     VPN-R23 forbids anything else), and the container inherits the host's tailnet routes the
#     tunnel URL needs.
#   Termux / no container tool: exec the native binary the root ./build.mjs
#     produced (llm-reverse-proxy-android on Termux; the host binary as
#     fallback)
#     in the selected role.
#
# Secrets live ONLY in the environment chain (VPN-R32/d078;
# lib/environment.sh owns the vault round-trip onto the host env — run.sh
# never loads secrets itself). Mode A serving holds none: requests must
# already carry valid provider keys. When the tunnel family arms (docs/d084/
# d085: the operator keyset env is the opt-in), the exit node carries the
# keyset and the relay node carries VPN_OPERATOR_TOKEN; both reach the
# container through the env allowlists below. The relay node has no config
# file at all: URL + token + optional label are its whole surface. The capability
# path is the Funnel mount's business (docs/d085): stripped at the edge,
# never seen here — the tunnel answers the fixed /vpn.
#
# Env overrides: PROXY_MODE / HOST_PORT / LISTEN / PROXY_LISTEN /
# SOCKS_LISTEN / IMAGE_TAG / LLM_PROXY_BIN / CONFIG, and for the
# relay node VPN_TUNNEL_URL (http(s):// or ws(s):// host[/<funnel-mount>]/vpn
# — the URL's wire form, docs/d090) / VPN_OPERATOR_TOKEN / VPN_CLIENT_LABEL;
# for an armed exit node VPN_OPERATOR_KEYS (the credentials split by node
# since docs/d090 — TOKEN is the relay's alone).

set -eu
# Shared infra arrives through one injectable directory (docs/d082): default
# the repo's ../lib, or point LIB_DIR at a vendored copy in a standalone
# checkout — no other path crosses the unit boundary.
# shellcheck disable=SC1091
. "${LIB_DIR:-$(dirname "$0")/../lib}/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/run'
export LOG_TOOL

# SCRIPT_DIR is assigned by the sourced lib/workload-runtime.sh (derived from
# this caller's $0), which shellcheck cannot see across a source boundary.
# shellcheck disable=SC2153
script_dir="$SCRIPT_DIR"

proxy_mode="${PROXY_MODE:-exit}"
case "$proxy_mode" in
exit | relay) ;;
*) log_die 94 "unknown PROXY_MODE — want exit or relay (docs/d088 node names)" mode="$proxy_mode" ;;
esac

# Fail the launch HERE, with the missing variable's NAME, instead of inside
# a detached container whose first log line is the only trace — the mirror
# of the exit node's config gate.
if [ "$proxy_mode" = relay ]; then
	[ -n "${VPN_TUNNEL_URL:-}" ] ||
		log_die 94 "relay mode needs VPN_TUNNEL_URL (http(s):// or ws(s):// host[/<funnel-mount>]/vpn — docs/d090)" var=VPN_TUNNEL_URL
	[ -n "${VPN_OPERATOR_TOKEN:-}" ] ||
		log_die 94 "relay mode needs VPN_OPERATOR_TOKEN (env-only credential, VPN-R44)" var=VPN_OPERATOR_TOKEN
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

	if [ "$proxy_mode" = relay ]; then
		log_info "serving (container, host network, relay node)" image="$image"
	else
		HOST_PORT="${HOST_PORT:-8080}"
		log_info "serving (container, host network, exit node)" image="$image" port="$HOST_PORT" config="$config"
	fi

	workload_rm "$container_id"
	workload_name     "$container_id"
	workload_image    "$image"
	workload_detach
	workload_init
	workload_network 'host'
	workload_hardening
	if [ "$proxy_mode" = relay ]; then
		# allowlist, not bare --env: an unset host var would inject an
		# EMPTY value the relay node reads as "set" (lib/workload-runtime.sh).
		# The capability prefix is not forwarded — it is part of the
		# tunnel URL path, the relay node's only notion of it.
		workload_env_allowlist VPN_TUNNEL_URL VPN_OPERATOR_TOKEN VPN_CLIENT_LABEL
		# The whole transport ladder rides — selection is the relay node's
		# per-dial ranking, not a knob (docs/d093).
		workload_cmd -mode relay \
			-proxy-listen "${PROXY_LISTEN:-127.0.0.1:3128}" \
			-socks-listen "${SOCKS_LISTEN:-127.0.0.1:1080}"
	else
		# Forwarded only when set — the same arming contract as native
		# (docs/d084): a containerized exit node can carry the tunnel family.
		# VPN_OPERATOR_TOKEN is deliberately absent: it is the relay node's
		# credential, and the exit node stopped reading it (docs/d090).
		workload_env_allowlist VPN_OPERATOR_KEYS
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

	if [ "$proxy_mode" = relay ]; then
		log_info "serving (native, relay node)" bin="$bin"
		# set -- (not an array): this file is POSIX sh.
		set -- -mode relay \
			-proxy-listen "${PROXY_LISTEN:-127.0.0.1:3128}" \
			-socks-listen "${SOCKS_LISTEN:-127.0.0.1:1080}"
		exec "$bin" "$@"
	fi
	log_info "serving (native, exit node)" bin="$bin" config="$config" listen="${LISTEN:-:8080}"
	exec "$bin" -config "$config" -listen "${LISTEN:-:8080}"
fi
