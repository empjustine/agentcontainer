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
# Secrets live ONLY in the environment chain (VPN-R32/d078): lib/environment.sh
# owns the vault round-trip onto the host env — this script never loads secrets
# itself. An armed exit node (docs/d084/d085) carries VPN_OPERATOR_KEYS.
# VPN_OPERATOR_TOKEN is deliberately absent: it is the relay node's credential
# and the exit node stopped reading it (docs/d090).
#
# Env overrides: PORT / IMAGE_TAG / ESTIGE_BIN / CONFIG / EXIT_CONTAINER.
# PORT is the bind, and it is the only spelling of it — no flag, no launcher
# variable of our own (docs/d110). CONFIG has no default: the tree carries no
# config file to point at (docs/d108), so absent means "serve the defaults".

set -eu
# Shared infra arrives through one injectable directory (docs/d082): default
# the repo's ../lib, or point LIB_DIR at a vendored copy in a standalone
# checkout — no other path crosses the unit boundary.
# shellcheck disable=SC1091
. "${LIB_DIR:-$(dirname "$0")/../lib}/workload-runtime.sh"
LOG_TOOL='estige/vpn-exit'
export LOG_TOOL

# SCRIPT_DIR is assigned by the sourced lib/workload-runtime.sh (derived from
# this caller's $0), which shellcheck cannot see across a source boundary.
# shellcheck disable=SC2153
script_dir="$SCRIPT_DIR"

# No config is the SUPPORTED shape (docs/d108): the export face is the tunnel,
# armed by the env chain, and the host-allowlist file estige used to require is
# deleted with the reverse-proxy mode. CONFIG still names a tunnel POLICY file
# explicitly (egress rules, the arming veto/assert — docs/d084): a file the
# operator names but cannot read is an error, not a silent default.
config="${CONFIG:-}"
if [ -n "$config" ] && [ ! -f "$config" ]; then
	log_die 94 "CONFIG names a policy file that does not exist" path="$config"
fi

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
	log_info "serving (container, host network, exit node)" image="$image" port="$port" config="$config"

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
	# PORT rides in by the same allowlist machinery: the container's bind must be
	# the host's bind, and the standard name is the only one to forward (d110).
	workload_env_allowlist VPN_OPERATOR_KEYS PORT
	if [ -n "$config" ]; then
		workload_ro   "$config" /etc/estige/tunnel-policy.json
		workload_cmd  -mode exit -config /etc/estige/tunnel-policy.json
	else
		workload_cmd  -mode exit
	fi
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
log_info "serving (native, exit node)" bin="$bin" config="$config" port="$port"
if [ -n "$config" ]; then
	exec "$bin" -config "$config"
fi
exec "$bin"
