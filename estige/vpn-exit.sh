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
# loopback port, so a bridge/slirp container would answer a loopback the funnel
# never sees — and host networking is also what makes the container's bind the
# host's bind, so one PORT reaches both paths (docs/d110). Termux / no
# container tool: exec the native binary (estige-android on Termux; the host
# binary as fallback).
#
# Secrets live ONLY in the environment chain (VPN-R32/d078): ./environment.sh
# owns the vault round-trip onto the host env — this script never loads secrets
# itself. An armed exit node (docs/d084/d085) carries VPN_OPERATOR_KEYS.
# VPN_OPERATOR_TOKEN is deliberately absent: it is the relay node's credential
# and the exit node stopped reading it (docs/d090).
#
# Env overrides: PORT / IMAGE_TAG / ESTIGE_BIN / EXIT_CONTAINER.
# PORT is the bind, and it is the only spelling of it — no flag, no launcher
# variable of our own (docs/d110). There is no config file to name any more
# (docs/d108 slice 5): what the exit enforces arrives as VPN_TUNNEL_EGRESS on
# the env chain, beside the credential.

set -eu
# The workload API is this folder's own copy (docs/d113): estige carries no
# cross-folder dependency, so a split-out checkout is complete as it stands.
# shellcheck disable=SC1091
. "${WORKLOAD_LIB_DIR:-$(dirname "$0")/lib}/workload-runtime.sh"
LOG_TOOL='estige/vpn-exit'
export LOG_TOOL

# SCRIPT_DIR is assigned by the sourced lib/workload-runtime.sh (derived from
# this caller's $0), which shellcheck cannot see across a source boundary.
# shellcheck disable=SC2153
script_dir="$SCRIPT_DIR"

# shellcheck disable=SC2154  # _workload/_workload_tool from the sourced lib
if [ "$_workload" = 'workload' ]; then
	# ========================= container backend =========================
	# Same image as the relay node (build.mjs's default tag) — the exit and
	# relay are the one binary in two network positions (docs/d088).
	image="${IMAGE_TAG:-localhost/estige:latest}"
	# estige-exit mirrors the relay's estige-relay (vpn-relay.sh): the
	# container names are per-role runtime identities of the tunnel family —
	# the two deployments must not share one, or whichever starts second
	# workload_rm's the other's container.
	container_id="${EXIT_CONTAINER:-estige-exit}"
	port="${PORT:-8080}"
	log_info "serving (container, host network, exit node)" image="$image" port="$port"

	workload_rm "$container_id"
	workload_name     "$container_id"
	workload_image    "$image"
	workload_detach
	workload_init
	workload_network  'host'
	workload_hardening
	# Forwarded only when set — the same arming contract as native (docs/d084).
	# PORT rides in by the same allowlist machinery: the container's bind must
	# be the host's bind, and the standard name is the only one to forward
	# (d110). VPN_TUNNEL_EGRESS is the exit's opt-in egress policy (VPN-R38);
	# VPN_OPERATOR_TOKEN is deliberately absent (docs/d090).
	workload_env_allowlist VPN_OPERATOR_KEYS VPN_TUNNEL_EGRESS PORT
	workload_cmd  -mode exit
	workload_run

	sleep 2
	workload_logs "$container_id" | head
	exit 0
fi

# ========================= native (Termux or bare host) ==================
bin="${ESTIGE_BIN:-}"
if [ -z "$bin" ]; then
	if [ -x "$script_dir/estige-android" ]; then
		bin="$script_dir/estige-android"
	elif [ -x "$script_dir/estige" ]; then
		bin="$script_dir/estige"
	fi
fi
[ -n "$bin" ] && [ -x "$bin" ] ||
	log_die 95 "no proxy binary — run ./build.sh first (on Termux it builds estige-android)" bin="${bin:-unset}"

port="${PORT:-8080}"
log_info "serving (native, exit node)" bin="$bin" port="$port"
exec "$bin"
