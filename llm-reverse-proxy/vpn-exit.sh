#!/bin/sh
# vpn-exit.sh — the EXIT NODE deployment of the tunnel family (docs/d088):
# the funnel front plus the tunnel server, on a host with free internet and
# tsnet to the LLM endpoints. The name is the deployment's network position,
# not a protocol role.
#
# WHY THIS IS NOT A CHAIN STEP (docs/d095): the exit node is the FAR side of
# the tunnel — there is no local consumer to route, and its provider egress is
# direct by policy (egress.go; the upstream chain belongs to the relay node's
# tunnel leg, docs/d094). Nothing to export, no child to wrap; the loopback
# proxy and the wrapping both live in vpn-relay.sh.
#
# Container hosts run the image the root ./build.mjs produced (docs/d041) in
# HOST NETWORK mode: the tailscale funnel serves this route on the HOST's own
# loopback :8080, so a bridge/slirp container would answer a loopback the
# funnel never sees. The in-container -listen 0.0.0.0:$HOST_PORT overrides the
# config's listen (llama-swap's port model, docs/d027). Termux / no container
# tool: exec the native binary (llm-reverse-proxy-android on Termux; the host
# binary as fallback).
#
# Secrets live ONLY in the environment chain (VPN-R32/d078): lib/environment.sh
# owns the vault round-trip onto the host env — this script never loads secrets
# itself. Mode A serving holds none (requests must already carry valid provider
# keys); an armed exit node (docs/d084/d085) carries VPN_OPERATOR_KEYS.
# VPN_OPERATOR_TOKEN is deliberately absent: it is the relay node's credential
# and the exit node stopped reading it (docs/d090).
#
# Env overrides: HOST_PORT / LISTEN / IMAGE_TAG / LLM_PROXY_BIN / CONFIG /
# EXIT_CONTAINER.

set -eu
# Shared infra arrives through one injectable directory (docs/d082): default
# the repo's ../lib, or point LIB_DIR at a vendored copy in a standalone
# checkout — no other path crosses the unit boundary.
# shellcheck disable=SC1091
. "${LIB_DIR:-$(dirname "$0")/../lib}/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/vpn-exit'
export LOG_TOOL

# SCRIPT_DIR is assigned by the sourced lib/workload-runtime.sh (derived from
# this caller's $0), which shellcheck cannot see across a source boundary.
# shellcheck disable=SC2153
script_dir="$SCRIPT_DIR"

config="${CONFIG:-$script_dir/llm-reverse-proxy.json}"
[ -f "$config" ] ||
	log_die 94 "config not found — generate it first with ./generate.sh (or copy llm-reverse-proxy.example.json for a hand-written deployment)" path="$config"

# shellcheck disable=SC2154  # _workload/_workload_tool from the sourced lib
if [ "$_workload" = 'workload' ]; then
	# ========================= container backend =========================
	# Same image as the relay node (build.mjs's default tag) — the exit and
	# relay are the one binary in two network positions (docs/d088).
	image="${IMAGE_TAG:-localhost/estige:latest}"
	# estige-exit mirrors the relay's estige-relay (vpn-relay.sh): container
	# names are runtime identities of the tunnel family, while
	# llm-reverse-proxy is the (legacy) folder name — and the two deployments
	# must not share a name, or whichever starts second workload_rm's the
	# other's container.
	container_id="${EXIT_CONTAINER:-estige-exit}"
	HOST_PORT="${HOST_PORT:-8080}"
	log_info "serving (container, host network, exit node)" image="$image" port="$HOST_PORT" config="$config"

	workload_rm "$container_id"
	workload_name     "$container_id"
	workload_image    "$image"
	workload_detach
	workload_init
	workload_network  'host'
	workload_hardening
	# Forwarded only when set — the same arming contract as native (docs/d084):
	# a containerized exit node can carry the tunnel family. VPN_OPERATOR_TOKEN
	# is deliberately absent (docs/d090).
	workload_env_allowlist VPN_OPERATOR_KEYS
	workload_ro       "$config" /etc/llm-reverse-proxy/llm-reverse-proxy.json
	workload_cmd      -config /etc/llm-reverse-proxy/llm-reverse-proxy.json -listen "0.0.0.0:$HOST_PORT"
	workload_run

	sleep 2
	workload_logs "$container_id" | head
	exit 0
fi

# ========================= native (Termux or bare host) ==================
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

log_info "serving (native, exit node)" bin="$bin" config="$config" listen="${LISTEN:-:8080}"
exec "$bin" -config "$config" -listen "${LISTEN:-:8080}"
