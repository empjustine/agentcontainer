#!/bin/sh
# Shared description-driven workload runner for the agentcontainer run scripts.
#
# Supported backends: rootless podman and rootful docker (the "workload"
# backend). PRoot was removed as a supported backend — it is a ptrace
# path-translation shim, not isolation (no namespaces, no cgroups, no real
# root, no GPU passthrough); the termux/a50 path serves natively via
# llm-reverse-proxy/run-native.sh instead. A qemu/libvirt VM backend is
# assessed in docs/d020-libvirt-qemu-sandbox.md (not implemented).

# path resolution (the only "where do I live" logic; run scripts reuse these)
# shellcheck disable=SC2034  # exported-by-contract for sourcing scripts
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# structured logging (see lib/log.sh) — every tool sourcing this file inherits
# log_debug/log_info/log_warn/log_error/log_die
# shellcheck disable=SC1091
. "$REPO_ROOT/lib/log.sh"

# --- profile + runner helpers ----------------------------------------------
# Shared by every script that sources this file (the generate.sh scripts used
# to carry their own identical copies — see docs/d023).
#
# Termux profile: 1 = Termux (PREFIX under /data/data/com.termux) — system
# node, no mise, no container runtime.
_termux=0
case "${PREFIX:-}" in
	*/com.termux/*) _termux=1 ;;
esac

# node_run [args...] — run node with the repo-pinned version, or the system
# node on Termux (there is no mise there).  Callers own the version-floor
# checks, which differ by product (>= 18 for the llm-reverse-proxy
# generators' global fetch, >= 22.19 for pi-coding-agent's engines).
node_run() {
	if [ "$_termux" = 1 ]; then
		node "$@"
	else
		mise exec node@24 -- node "$@"
	fi
}

# default_run_dir — the ${RUN_DIR:-...} fallback shared by the generate.sh
# scripts (scratch dir for intermediate artifacts; the script's own dir may be
# a read-only mount).  Termux: $TMPDIR or $PREFIX/tmp; elsewhere $TMPDIR or
# /tmp.
default_run_dir() {
	if [ "$_termux" = 1 ]; then
		printf '%s' "${TMPDIR:-${PREFIX}/tmp}"
	else
		printf '%s' "${TMPDIR:-/tmp}"
	fi
}

# Infisical identity, pinned so `infisical` resolves the correct workspace from
# any working directory (proposals-upstream.md D). Self-hosted instances override
# INFISICAL_API_URL; the project id matches the workspaceId in the checked-in
# .infisical.json.  Exported so the generate/run scripts (and the in-workload
# launch chain) reference these instead of duplicating the literal across
# scripts.  These are routing, NOT secrets — safe to forward via workload_env.
INFISICAL_API_URL="${INFISICAL_API_URL:-https://app.infisical.com}"
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-628c46b6-a5d5-4671-9435-c205847397ce}"
export INFISICAL_API_URL INFISICAL_PROJECT_ID

# --- secrets ---------------------------------------------------------------
# load_secrets — the single place that decides where secrets come from.
#
# NO SECRET FILES, EVER.  No script in this repo reads a dotenv file: not
# `.env`, not `$ENV_FILE`, not a cache file.  The former ENV_FILE override and
# the `<caller's dir>/.env` last-resort fallback were removed — a file of
# plaintext keys on disk is the failure mode this loader exists to avoid, and
# every host that used them has infisical (Termux via the locally built CLI,
# see ./build.sh).  `llm-reverse-proxy/.env.example` is DOCUMENTATION ONLY:
# it lists the key names the generators and the server read; nothing sources,
# copies or loads it.
#
# Priority:
#   1. the caller's environment — the "emergency not-infisical loader": if the
#      caller has already seeded the environment (or explicitly opts out of the
#      vault), accept that env as-is and never contact infisical.  Two ways to
#      trigger it:
#
#      * SECRETS_ASSUME=1 — "the environment is already correct; do not
#        re-derive anything".  Canonical user: the coding-agent workload.  run.sh
#        (host) forwards the vault env through its workload_env allowlist and the
#        in-workload launch.sh exports SECRETS_ASSUME=1, so load_secrets inside
#        the workload only ever consumes that forwarded env — infisical is never
#        run inside the workload.  This header is the flag's canonical
#        definition; elsewhere it is only referenced (coding-agent/run.sh,
#        coding-agent/config.toml).
#      * any well-known inference key already set (PEER_API_KEY, CLINE_API_KEY,
#        OPENCODE_API_KEY, OPENROUTER_API_KEY, HF_TOKEN, MISTRAL_API_KEY) —
#        same short-circuit without the flag.
#   2. infisical: ONE `infisical secrets --output=dotenv` per call, injected
#      into the environment IN MEMORY (the dotenv text is only the CLI's wire
#      format; it is parsed straight out of a here-string and never lands on
#      disk).  Binary resolution, in order: $INFISICAL_BIN
#      (explicit) › $HOME/Infisical/cli/infisical (the Termux/Android build —
#      the CLI now builds there with -checklinkname=0, see
#      see the repo's root ./build.sh, which is what provisions it and
#      documents the flags; tried before mise so a Termux host with mise
#      still uses the locally built CLI, as no official Android release
#      exists) › `mise x infisical@latest -- infisical` (mise hosts; the
#      explicit version pins the tool rather than depending on the host's
#      global config) › `infisical` on PATH.
#
# Never fatal: callers must tolerate missing keys (generators skip key-less
# providers; launchers warn).  Sets SECRETS_SOURCE (none|injected|infisical)
# for diagnostics.
_SECRETS_LOADED=0
load_secrets() {
	[ "$_SECRETS_LOADED" = 1 ] && return 0
	_SECRETS_LOADED=1
	SECRETS_SOURCE=none

	# 1. already-injected environment — the "emergency not-infisical loader"
	#    (canonical definition in the load_secrets header above)
	if [ "${SECRETS_ASSUME:-0}" = 1 ] || [ -n "${PEER_API_KEY:-}" ] \
		|| [ -n "${CLINE_API_KEY:-}" ] || [ -n "${OPENCODE_API_KEY:-}" ] \
		|| [ -n "${OPENROUTER_API_KEY:-}" ] || [ -n "${HF_TOKEN:-}" ] \
		|| [ -n "${MISTRAL_API_KEY:-}" ]; then
		SECRETS_SOURCE=injected
		return 0
	fi

	# Dotenv parser for an IN-MEMORY string ($1) — the infisical fetch.  There
	# is deliberately no file variant of this (no `.env`, no `$ENV_FILE`): the
	# vault keys must never be materialized on disk, so the CLI's dotenv output
	# is parsed straight from a here-doc.  The here-doc keeps the `while` loop
	# in the current shell (exports persist), and parameter expansion yields
	# literal text (no eval / no re-expansion).
	# shellcheck disable=SC2163  # intentional dynamic export
	_secrets_inject() {
		while IFS= read -r _l || [ -n "$_l" ]; do
			case "$_l" in ''|\#*) continue ;; esac
			_l="${_l#export }"
			case "$_l" in *=*) export "$_l" ;; esac
		done <<EOF
$1
EOF
	}

	# 2. infisical — all platforms (see header for binary resolution)
	_secrets_infisical() {
		if [ -n "${INFISICAL_BIN:-}" ] && [ -x "$INFISICAL_BIN" ]; then
			"$INFISICAL_BIN" "$@"
		elif [ -x "$HOME/Infisical/cli/infisical" ]; then
			# The Termux/Android build (see the repo's root ./build.sh) — tried
			# before mise so a Termux host with mise installed still uses the
			# locally built CLI (no official Android release exists).
			"$HOME/Infisical/cli/infisical" "$@"
		elif command -v mise >/dev/null 2>&1; then
			mise x infisical@latest -- infisical "$@"
		elif command -v infisical >/dev/null 2>&1; then
			infisical "$@"
		else
			return 1
		fi
	}
	_secrets_available=0
	if { [ -n "${INFISICAL_BIN:-}" ] && [ -x "$INFISICAL_BIN" ]; } \
		|| [ -x "$HOME/Infisical/cli/infisical" ] \
		|| command -v mise >/dev/null 2>&1 \
		|| command -v infisical >/dev/null 2>&1; then
		_secrets_available=1
	fi
	if [ "$_secrets_available" = 1 ]; then
		# Fetch the vault ONCE and inject it into the environment in memory —
		# never a cache file on disk.  A prior revision wrote the dotenv
		# export to $XDG_RUNTIME_DIR/.agentcontainer-secrets.<uid>.env (falling
		# back to /tmp or $PREFIX/tmp), materializing the vault keys in
		# persistent storage — including on Termux, where $PREFIX/tmp lives
		# inside the app's data dir.  Secrets belong in the process environment,
		# so there is deliberately no cross-invocation cache (SECRETS_ASSUME=1 /
		# already-set keys still short-circuit above).
		# Gate the fetch inside an `if` condition: a failing (or empty) vault
		# call must be non-fatal under the caller's set -e ("never fatal"
		# contract), not abort the script.  `set -e` is suspended in a condition,
		# so a non-zero exit is captured here the same way the old cache write
		# was.
		if _secrets_dotenv="$(_secrets_infisical secrets --output=dotenv --silent \
				--domain="${INFISICAL_API_URL:-https://app.infisical.com}" \
				--projectId="${INFISICAL_PROJECT_ID:-}" \
				--env=prod --path=/inference)" && [ -n "$_secrets_dotenv" ]; then
			_secrets_inject "$_secrets_dotenv"
			SECRETS_SOURCE=infisical
			return 0
		fi
		log_warn "infisical secrets fetch failed — continuing without vault secrets"
	fi

	if [ "$_secrets_available" != 1 ] && [ "$SECRETS_SOURCE" = none ]; then
		# No binary anywhere to fetch from — say how to provision one instead of
		# failing silently (Termux must source-build the CLI; see the repo's
		# ./build.sh, which builds it).  Keys can also simply be exported into the
		# environment before the call (see the header).
		case "${PREFIX:-}" in
			*/com.termux/*)
				log_warn "no secrets source and no infisical binary — run the repo's ./build.sh to build the Termux CLI, or export the keys" ;;
			*)
				log_warn "no secrets source (no mise/infisical, no keys in the environment)" ;;
		esac
	fi
	return 0
}

# backend detection
_workload_tool=''
_userns=''
_keep_groups=''

detect_workload_tool() {
	if [ -x /usr/bin/podman ]; then
		_workload_tool='podman'; _userns='--userns=keep-id'
		_keep_groups='--group-add keep-groups'
	elif [ -x /usr/bin/docker ]; then
		_workload_tool='docker'; _userns=''; _keep_groups=''
	else
		return 1
	fi
	return 0
}

_workload='none'
detect_workload_tool && _workload='workload'

# workload_has <field> — succeed when a named array of the description is
# non-empty.  This is how callers ask the description a question without
# reaching into its internals: llm-reverse-proxy/generate.sh gates the
# local-inference layer on `workload_has devices` (plus the workload backend).
# The predicate itself lives in lib/workload-has.jq and is carried by jq's -e
# exit status (0 = true, 1 = false/null), so there is no string comparison.
workload_has() {
	# -n is mandatory: without it jq reads the filter's input from stdin, which
	# is not a description document — it would block, or produce no output at
	# all (exit 4 with -e).  The description arrives through --argjson, not
	# through input.
	_sb_jq -rn -e --argjson doc "$workload_LISTS" --arg field "$1" \
		--from-file "$workload_JQDIR/workload-has.jq" >/dev/null
}

# --- description -----------------------------------------------------------
# Two halves.  Scalar settings are one shell global each: they are plain
# strings and 0/1 flags with no data-structure problem, so jq would only add a
# subprocess.  List settings (mounts, env names, ports, devices, command
# words) live in ONE JSON document in $workload_LISTS, mutated by the filters in
# lib/workload-*.jq and turned into argv by lib/workload-render.jq — the header
# of each filter carries its input/output contract, and those headers are the
# documentation for this half of the API.
#
# Why jq only for the lists: the old code emulated indexed arrays with `eval`
# (_sb_add_vol plus a matching eval in the renderer) and carried env/ports/
# devices as space-joined strings that were word-split inside unquoted `for`
# loops.  Word-splitting an unquoted expansion is a bash/dash behaviour, not a
# shell one — zsh does not do it — so that form was silently dialect-dependent.
# jq behaves identically whichever shell called it, and --arg carries values
# without any shell quoting.
#
# EMPTY STRING MEANS "NOT SET": every scalar is handed to the renderer as an
# --arg, and the renderer omits the flag for an empty value (it never forwards
# an empty flag).  See lib/workload-render.jq.
workload_JQDIR="$REPO_ROOT/lib"

# jq is needed only by the workload_* calls.  Scripts that source this file just
# for log_* or load_secrets (e.g. local-llm/run-all.sh) never touch it, so the
# lookup is lazy: it happens on the first workload_* call that needs it, not at
# source time.  (The cache below is best-effort: the mutators assign through
# `$( ... )`, which runs this function in a subshell, so a mutator's lookup
# does not persist.  That only costs one extra `command -v` per call.)
workload_JQ=''
_sb_jq() {
	if [ -z "$workload_JQ" ]; then
		workload_JQ="$(command -v jq 2>/dev/null || true)"
		[ -n "$workload_JQ" ] || log_die 92 \
			"jq not found — required by the workload_* API" \
			hint='host: add jq to mise.toml; Termux: pkg install jq'
	fi
	"$workload_JQ" "$@"
}

# _wrapper is the host-side command `workload_run [wrapper...]` prefixes the
# launch with (historically `infisical run … --`).  Initialised here so
# _render_workload is also callable on its own — tests/check-workload.sh does
# exactly that, and an unset global would trip `set -u`.
_wrapper=''

workload_NAME=''
workload_IMAGE=''
workload_MODE=''
workload_NETWORK=''
workload_INIT=0
workload_USER=0
workload_GPU=0
workload_HARDEN=0
workload_WORKDIR=''
workload_ENTRYPOINT=''
workload_LISTS='{}'

# declarative API — scalars are plain assignments
workload_name()     { workload_NAME="$1"; }
workload_image()    { workload_IMAGE="$1"; }
workload_detach()   { workload_MODE='detach'; }
workload_interactive() { workload_MODE='interactive'; }
workload_init()     { workload_INIT=1; }
workload_network()  { workload_NETWORK="$1"; }
workload_user()     { workload_USER=1; }
workload_gpu()      { workload_GPU=1; detect_gpu_devs; }
workload_hardening(){ workload_HARDEN=1; }
workload_workdir()  { workload_WORKDIR="$1"; }
workload_entrypoint(){ workload_ENTRYPOINT="$1"; }

# declarative API — lists, one jq call each (see each filter's header)
workload_publish() {
	workload_LISTS="$(_sb_jq -nc --argjson doc "$workload_LISTS" --arg host "$1" \
		--arg guest "$2" --from-file "$workload_JQDIR/workload-port.jq")" ||
		log_die 92 "workload_publish failed" host="$1" guest="$2"
}
workload_env() { _sb_append env "$@"; }
workload_cmd() {
	[ "$#" -gt 0 ] || return 0
	# The bare `--` after --args is REQUIRED: jq keeps parsing options after
	# --args, so a command word starting with a dash (`-config-dir`) would be
	# read as jq flags.  -- ends option parsing; everything after is data.
	workload_LISTS="$(_sb_jq -nc --argjson doc "$workload_LISTS" \
		--from-file "$workload_JQDIR/workload-cmd.jq" --args -- "$@")" ||
		log_die 92 "workload_cmd failed"
}

# _sb_append <field> <value...> — append strings to a named array of the
# description.  --args must come last: every following argument is positional.
_sb_append() {
	_sb_field="$1"; shift
	[ "$#" -gt 0 ] || return 0
	# `--` after --args: see workload_cmd — a value may start with a dash.
	workload_LISTS="$(_sb_jq -nc --argjson doc "$workload_LISTS" --arg field "$_sb_field" \
		--from-file "$workload_JQDIR/workload-append.jq" --args -- "$@")" ||
		log_die 92 "workload append failed" field="$_sb_field"
}

# workload_rw_if was removed: nothing called it (only workload_ro_if is used).
workload_ro()  { _require "$1" "read-only mount $1"  && _sb_add_mount ro "$1" "$2"; }
workload_rw()  { _require "$1" "read-write mount $1" && _sb_add_mount rw "$1" "$2"; }
workload_ro_if() { [ -e "$1" ] && _sb_add_mount ro "$1" "$2"; return 0; }

_sb_add_mount() {
	workload_LISTS="$(_sb_jq -nc --argjson doc "$workload_LISTS" --arg mode "$1" \
		--arg host "$2" --arg guest "$3" \
		--from-file "$workload_JQDIR/workload-mount.jq")" ||
		log_die 92 "workload mount failed" mode="$1" host="$2" guest="$3"
}

workload_rm() {
	[ "$_workload" = 'workload' ] || return 0
	# Remove by name through every backend, not just the one picked for `run`.
	# podman and docker keep separate stores, so a stale workload left by the
	# other tool (or a tool-detection flip between runs) would otherwise slip
	# past a single-backend `rm` and collide with the new `--name` at run time.
	for _ct in podman docker; do
		command -v "$_ct" >/dev/null 2>&1 || continue
		"$_ct" container rm -f "$1" >/dev/null 2>&1 || true
	done
}
workload_logs() {
	[ "$_workload" = 'workload' ] || return 0
	"$_workload_tool" logs "$1"
}

_require() { [ -e "$1" ] || log_die 91 "$2 not found" path="$1"; }

detect_gpu_devs() {
	# Collect into the function's own positional parameters — a real list, not a
	# space-joined string — then append the lot in ONE jq call.
	set --
	for _n in /dev/kfd /dev/dri/renderD*; do
		[ -e "$_n" ] && set -- "$@" "$_n"
	done
	[ "$#" -gt 0 ] && _sb_append devices "$@"
	# Always succeed: this is called as a side effect of workload_gpu() and its
	# return value carries no meaning.  A GPU-less host leaves the last test
	# non-zero, which would trip `set -e` in the caller.
	return 0
}

# render — ONE jq call.  lib/workload-render.jq owns the flag order and the
# empty-string-means-omit contract; read its header, not this function, to
# learn what the argv looks like.
_render_argv() {
	_sb_jq -rn \
		--argjson doc "$workload_LISTS" \
		--arg tool "$_workload_tool" \
		--arg image "$workload_IMAGE" \
		--arg name "$workload_NAME" \
		--arg network "$workload_NETWORK" \
		--arg entrypoint "$workload_ENTRYPOINT" \
		--arg workdir "$workload_WORKDIR" \
		--arg mode "$workload_MODE" \
		--arg init "$workload_INIT" \
		--arg user "$workload_USER" \
		--arg uid "${SUDO_UID:-$(id -u)}" \
		--arg gid "${SUDO_GID:-$(id -g)}" \
		--arg userns "$_userns" \
		--arg keepgroups "$_keep_groups" \
		--arg harden "$workload_HARDEN" \
		--from-file "$workload_JQDIR/workload-render.jq"
}

# shellcheck disable=SC2120  # "$@" is set by the `eval set --` below, not passed in
_render_workload() {
	[ -n "$workload_IMAGE" ] || log_die 91 "workload_image not set"
	_sb_argv="$(_render_argv)" ||
		log_die 92 "workload render failed (see the jq error above)"
	# The renderer emits one line of @sh-quoted words, so expanding $_sb_argv
	# unquoted is the point — @sh supplies the quoting that keeps each word
	# (paths with spaces, quotes, newlines) intact as a single argument.
	# shellcheck disable=SC2086  # intentionally unquoted: @sh-quoted argv
	eval "set -- $_sb_argv"
	# shellcheck disable=SC2086  # $_wrapper is an intentional word list
	$_wrapper "$_workload_tool" container run "$@"
}

# workload_run [wrapper...] — render and launch; optional wrapper prefixes the
# launch command.  Note: the wrapper runs on the HOST around the workload-runtime
# invocation, so it cannot inject env into the workload — secrets reach the
# workload only through the workload_env allowlist (the coding-agent run
# forwards host-loaded vault keys that way; it no longer runs infisical inside
# the workload — see coding-agent/run.sh).
workload_run() {
	_wrapper="$*"
	[ "$_workload" = 'workload' ] ||
		log_die 91 "no workload backend available (need podman or docker)"
	# shellcheck disable=SC2119  # see SC2120 above: "$@" comes from the eval
	_render_workload
}
