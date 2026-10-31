#!/bin/sh
# vpn-relay.sh — the RELAY NODE deployment (docs/d088) and the chain step that
# points a local consumer at it (docs/d095).
#
#   serve (no arguments): run the relay node in the foreground. Its loopback
#     CONNECT/SOCKS5 listeners become the HOST's loopback (usable by host
#     apps; VPN-R23 forbids anything else), and the tunnel URL rides the
#     host's tailnet routes.
#
#   chain (arguments): ensure a relay is serving, gate readiness, export the
#     conventional proxy variables pointing at it, then exec the target:
#
#       ./lib/environment.sh ./llm-reverse-proxy/vpn-relay.sh ./coding-agent/run.sh
#
#     One vault round-trip (docs/d046) buys the relay its credential and the
#     child its environment; the child never holds VPN_OPERATOR_TOKEN (d090).
#
# WHY THE CHAIN STEP EXISTS (docs/d095): the conventional proxy variables are
# the one spelling a restricted network already speaks (docs/d094 §1), so
# pointing a consumer at the relay is an env fact — and a WRONG env fact is
# worse than none: every client that honors it fails, including requests that
# would have worked direct. The chain step owns the two things a bare
# "export HTTP_PROXY=..." cannot: it starts the relay when it is absent, and
# it refuses to hand out the spelling unless a relay answering THIS tunnel is
# live on it. It is also the one place the variables' two meanings are
# separated: the relay's own upstream chain (docs/d094) is read from the host
# env BEFORE the loopback spelling is exported — exporting first would make
# the relay chain to itself.
#
# Env overrides: PROXY_LISTEN / SOCKS_LISTEN / IMAGE_TAG / LLM_PROXY_BIN /
# RELAY_CONTAINER / RELAY_READY_TRIES / RELAY_STATE_DIR, plus the relay node's
# own surface (VPN_TUNNEL_URL / VPN_OPERATOR_TOKEN / VPN_CLIENT_LABEL,
# docs/d090) and its optional chain (docs/d094).

set -eu
# Shared infra arrives through one injectable directory (docs/d082): default
# the repo's ../lib, or point LIB_DIR at a vendored copy in a standalone
# checkout — no other path crosses the unit boundary.
# shellcheck disable=SC1091
. "${LIB_DIR:-$(dirname "$0")/../lib}/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/vpn-relay'
export LOG_TOOL

# SCRIPT_DIR is assigned by the sourced lib/workload-runtime.sh (derived from
# this caller's $0), which shellcheck cannot see across a source boundary.
# shellcheck disable=SC2153
script_dir="$SCRIPT_DIR"

relay_http="${PROXY_LISTEN:-127.0.0.1:3128}"
relay_socks="${SOCKS_LISTEN:-127.0.0.1:1080}"
# Container names ride the estige-* spelling; llm-reverse-proxy is the
# (legacy) folder/unit name, not a runtime identity. The two deployments
# workload_rm before launching, so their names must not collide either —
# whichever starts second would force-remove the other's container on a host
# serving both nodes (same image, different listeners).
container_id="${RELAY_CONTAINER:-estige-relay}"
health_url="http://${relay_http}/healthz"

# Result carriers, not locals: POSIX sh has no "local", and a log_die inside a
# command substitution would kill only the SUBSHELL — a probe that died that
# way would read as "nothing answered" and start a second relay. Every helper
# below is therefore called directly, never in $(...).
_vr_want=''
_vr_needle=''
_vr_body=''
_vr_state=0
_vr_bin=''
_vr_state_dir=''

# _relay_env — the relay's own surface, refused HERE with the missing
# variable's NAME (the mirror of the binary's startup gate; VPN-R26/NFR-2).
_relay_env() {
	[ -n "${VPN_TUNNEL_URL:-}" ] ||
		log_die 94 "relay node needs VPN_TUNNEL_URL (http(s):// or ws(s):// host[/<funnel-mount>]/vpn — docs/d090)" var=VPN_TUNNEL_URL
	[ -n "${VPN_OPERATOR_TOKEN:-}" ] ||
		log_die 94 "relay node needs VPN_OPERATOR_TOKEN (env-only credential, VPN-R44)" var=VPN_OPERATOR_TOKEN
}

# _want_tunnel — the endpoint the RUNNING relay must report for this
# invocation. The comparison is against the binary's own normalized spelling
# (docs/d090: http(s):// → ws(s)://), so mirroring it here is deliberate: an
# operator's https:// spelling would otherwise read as a foreign listener.
_want_tunnel() {
	case "$VPN_TUNNEL_URL" in
	http://* | ws://*) _vr_scheme='ws' ;;
	https://* | wss://*) _vr_scheme='wss' ;;
	*) log_die 94 "VPN_TUNNEL_URL must be http://, https://, ws:// or wss:// (docs/d090)" var=VPN_TUNNEL_URL ;;
	esac
	_vr_authority="${VPN_TUNNEL_URL#*://}"
	_vr_want="${_vr_scheme}://${_vr_authority%%/*}"
	# The healthz body is compact JSON (encoding/json, sorted keys), so the
	# needle is the whole identity check — no jq on the native path.
	_vr_needle='"tunnel":"'"$_vr_want"'"'
}

# _probe — stdout: the relay's /healthz body. Non-zero means nothing answered
# HTTP there. curl is the probe client (smoke-test.sh's precedent: the
# host-side check tool this repo already assumes).
_probe() {
	curl -sS --max-time 2 "$health_url" 2>/dev/null
}

# _probe_state — 0 = a relay answering THIS tunnel is live, 1 = nothing
# answered, 2 = something answered that is not ours (a foreign listener on the
# port would otherwise become the child's silent proxy).
_probe_state() {
	_vr_body="$(_probe)" || return 1
	case "$_vr_body" in
	*"$_vr_needle"*) return 0 ;;
	*) return 2 ;;
	esac
}

# _resolve_bin — the native binary, resolved like every other runner (docs/d059).
_resolve_bin() {
	_vr_bin="${LLM_PROXY_BIN:-}"
	if [ -z "$_vr_bin" ]; then
		if [ -x "$script_dir/llm-reverse-proxy-android" ]; then
			_vr_bin="$script_dir/llm-reverse-proxy-android"
		elif [ -x "$script_dir/llm-reverse-proxy" ]; then
			_vr_bin="$script_dir/llm-reverse-proxy"
		fi
	fi
	[ -n "$_vr_bin" ] && [ -x "$_vr_bin" ] ||
		log_die 95 "no proxy binary — run ./build.sh first (on Termux it builds llm-reverse-proxy-android)" bin="${_vr_bin:-unset}"
}

# _describe_relay — the container description both modes share. The env
# allowlists are the WHOLE relay surface: the chain variables (docs/d094) are
# forwarded only when set (unset reads as DIRECT — the bare `--env`
# empty-value law, lib/workload-runtime.sh), and the operator token reaches
# the CONTAINER,
# never the child the chain mode execs.
_describe_relay() {
	workload_name     "$container_id"
	# The default tag must match build.mjs's or a freshly built image is
	# invisible to a default serve (IMAGE_TAG is the operator's escape hatch).
	workload_image    "${IMAGE_TAG:-localhost/estige:latest}"
	workload_init
	workload_network  'host'
	workload_hardening
	# The capability prefix is not forwarded — it is part of the tunnel URL
	# path, the relay node's only notion of it.
	workload_env_allowlist VPN_TUNNEL_URL VPN_OPERATOR_TOKEN VPN_CLIENT_LABEL
	workload_env_allowlist HTTP_PROXY http_proxy HTTPS_PROXY https_proxy ALL_PROXY all_proxy SOCKS_SERVER socks_server SOCKS_VERSION socks_version
	# The whole transport ladder rides — selection is the relay node's
	# per-dial ranking, not a knob (docs/d093).
	workload_cmd -mode relay -proxy-listen "$relay_http" -socks-listen "$relay_socks"
}

# _no_self_chain — the relay's upstream chain is read from the host env, so an
# ambient spelling already pointing at the listener we are about to start
# would dial a loop. Refuse by name instead (docs/d095).
_no_self_chain() {
	case "${HTTP_PROXY:-}${HTTPS_PROXY:-}${ALL_PROXY:-}${http_proxy:-}${https_proxy:-}${all_proxy:-}" in
	*"$relay_http"* | *"$relay_socks"*)
		log_die 94 "the ambient proxy env already points at the relay's own listener — refusing to start a self-chained relay" http="$relay_http" socks="$relay_socks"
		;;
	esac
}

# _start_relay — bring the relay up detached, with the HOST's chain env (the
# loopback export happens only after this returns).
_start_relay() {
	_no_self_chain
	# shellcheck disable=SC2154  # _workload from the sourced lib
	if [ "$_workload" = 'workload' ]; then
		log_info "starting relay (container, host network)" http="$relay_http" socks="$relay_socks"
		workload_rm "$container_id"
		_describe_relay
		workload_detach
		# The child is handed a FIXED address, so a crash must not leave it
		# dead: the detached launch restarts (docs/d095).
		workload_restart unless-stopped
		workload_run
		return 0
	fi
	_start_native_relay
}

# _start_native_relay — the native analog of --restart: a background supervisor
# loop, orphaned on purpose. The relay is a host SERVICE, shared by every
# sandbox and host app, so it must outlive the child it was started for. The
# subshell forks BEFORE the loopback export below, which is what keeps the
# host's chain variables (docs/d094) in the relay's own environment.
_start_native_relay() {
	_resolve_bin
	_vr_state_dir="${RELAY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/llm-reverse-proxy}"
	mkdir -p -- "$_vr_state_dir"
	log_info "starting relay (native, supervised)" bin="$_vr_bin" log="$_vr_state_dir/relay.log"
	(
		while :; do
			"$_vr_bin" -mode relay \
				-proxy-listen "$relay_http" \
				-socks-listen "$relay_socks" >>"$_vr_state_dir/relay.log" 2>&1 || true
			sleep 1
		done
	) &
}

# _wait_ready — a detached container (or a freshly forked supervisor) is not
# serving the instant the launch returns, and the child must never start
# against a dead spelling (docs/d095). Bounded: a relay that cannot come up is
# a loud failure, not a hang.
_wait_ready() {
	_vr_tries="${RELAY_READY_TRIES:-100}"
	_vr_i=0
	while [ "$_vr_i" -lt "$_vr_tries" ]; do
		_vr_state=0
		_probe_state || _vr_state=$?
		case "$_vr_state" in
		0) return 0 ;;
		2) log_die 94 "a non-relay answered the health endpoint while starting — refusing to hand out the proxy spelling" url="$health_url" ;;
		esac
		_vr_i=$((_vr_i + 1))
		sleep 0.2
	done
	log_die 94 "relay did not become ready" url="$health_url" tries="$_vr_tries" hint='check the relay logs and VPN_TUNNEL_URL / VPN_OPERATOR_TOKEN'
}

# ========================= chain mode ====================================
if [ "$#" -gt 0 ]; then
	_relay_env
	command -v curl >/dev/null 2>&1 ||
		log_die 95 "curl not found — required to probe the relay at $health_url" hint='Termux: pkg install curl'
	_want_tunnel

	_vr_state=0
	_probe_state || _vr_state=$?
	case "$_vr_state" in
	0) log_info "relay already serving — reusing" url="$health_url" ;;
	1)
		_start_relay
		_wait_ready
		;;
	*) log_die 94 "something other than this relay answered the health endpoint — refusing to start a second one" url="$health_url" want="$_vr_want" hint='PROXY_LISTEN points at a foreign listener; unset it or stop that process' ;;
	esac

	# The child's spelling. Both cases ride because clients disagree about
	# which they read (Go/Node read either; SOCKS5h is the non-HTTP TCP one,
	# VPN-R24). NO_PROXY keeps loopback direct — the relay itself, and any
	# host-local service, must not depend on the tunnel being up — and the
	# host's list is merged so an operator's internal suffixes keep meaning.
	_vr_no_proxy="127.0.0.1,localhost,::1"
	if [ -n "${NO_PROXY:-}" ]; then
		_vr_no_proxy="$_vr_no_proxy,$NO_PROXY"
	fi
	HTTP_PROXY="http://$relay_http"
	HTTPS_PROXY="http://$relay_http"
	http_proxy="http://$relay_http"
	https_proxy="http://$relay_http"
	ALL_PROXY="socks5h://$relay_socks"
	all_proxy="socks5h://$relay_socks"
	NO_PROXY="$_vr_no_proxy"
	no_proxy="$_vr_no_proxy"
	# Handing out the spelling is only half a contract for a NODE child: node's
	# native fetch/http ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY is set
	# (docs/d074). The chain is the one place that knows it just handed the
	# spelling out, so it defaults the flag here — every parent would otherwise
	# have to know (the image sets it; a host-native node does not). Defaulted,
	# not forced: an operator's explicit value wins. Non-node children need no
	# flag (python/rust read ALL_PROXY, go reads HTTP(S)_PROXY, all natively).
	NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"
	export HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy NODE_USE_ENV_PROXY
	exec "$@"
fi

# ========================= serve mode ====================================
# Foreground on purpose: the operator sees the relay's own logs and Ctrl-C
# stops it. The detached, restart-policy half is the chain mode above.
_relay_env
# shellcheck disable=SC2154  # _workload from the sourced lib
if [ "$_workload" = 'workload' ]; then
	log_info "serving (container, host network, relay node)" http="$relay_http" socks="$relay_socks"
	workload_rm "$container_id"
	_describe_relay
	workload_run
	exit 0
fi
_resolve_bin
log_info "serving (native, relay node)" bin="$_vr_bin" http="$relay_http" socks="$relay_socks"
exec "$_vr_bin" -mode relay -proxy-listen "$relay_http" -socks-listen "$relay_socks"
