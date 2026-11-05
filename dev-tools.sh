#!/bin/sh
# dev-tools.sh — the DEV-host toolchain bootstrap, in one place (docs/d139).
#
# WHY mise lives here and nowhere a unit runs: mise is a developer convenience
# and is absent on Termux, this repo's other RUNTIME target (docs/d051, d082).
# Nothing a unit executes may depend on it — node-run.sh resolves node itself
# and Termux takes host packages. This file is the dev half of that split: the
# acquisition path for the tools that are not npm packages (those are
# npm-tools.sh, docs/d107), consulted by ./lint.sh and ./test.sh so the two
# sweeps cannot disagree about a tool or its version.
#
# WHY the pins live here rather than in each sweep: go is needed twice over
# (the Go suite in test.sh, golangci-lint's child `go list` in lint.sh) at ONE
# version, and a second copy of a version string is drift waiting to happen.
# docs/d139 supersedes d137's "the pin lives in lint.sh" placement. The pin
# STYLE is unchanged: a tool whose output IS the gate's meaning is pinned
# (golangci-lint, oxfmt — d137); a utility whose only contract is "a plausibly
# current shellcheck/jq" floats at @latest (d107).
#
# WHY there is no committed mise.toml, restated here because this file is now
# where that question lands: a root mise.toml re-pins bare `node`/`go` for
# every process entering the tree and silently changes what an operator's shell
# resolves (d051/d082/d137 rejected it), and mise cannot express the question
# anyway — its filters are os/arch, while the real distinction is "is this a dev
# host I install toolchains on, or a runtime/Termux box I must not touch?". Only
# a program can answer that, so the answer is DEV_TOOLS_PROFILE below.
#
# Usage:
#   ./dev-tools.sh               # install this environment's whole profile
#   ./dev-tools.sh go oxfmt      # install just these tools
#   . ./dev-tools.sh             # then dev_tool_run / dev_tool_bin / dev_tool_ensure
#
# Env:
#   DEV_TOOLS_PROFILE=full|none  (default: full on a mise host, none otherwise)
#
# Source log.sh first when sourcing this file (npm-tools.sh's convention):
# the functions below log through it.

# The one pin table (docs/d139). A value is a mise tool version specifier;
# @latest means "whatever the environment offers", the posture the floating
# lint legs already had.
dev_tool_pin() {
	case "$1" in
	go) printf '%s\n' '1.27' ;;
	golangci-lint) printf '%s\n' '2.15.0' ;;
	oxfmt) printf '%s\n' '0.75.0' ;;
	shellcheck | shfmt | jq | ruff | uv | ty) printf '%s\n' 'latest' ;;
	*)
		printf 'dev-tools.sh: unknown tool: %s\n' "$1" >&2
		return 2
		;;
	esac
}

# Every tool a `full` profile installs, in one list so ./dev-tools.sh and the
# sweeps cannot drift about what "the dev toolchain" means.
DEV_TOOLS_ALL='go golangci-lint shellcheck shfmt jq oxfmt ruff uv ty'

dev_tools_is_termux() {
	case "${PREFIX:-}" in
	*/com.termux/*) return 0 ;;
	*) return 1 ;;
	esac
}

# full — acquire through mise; none — use what the host already has and never
# install. Termux and mise-less hosts default to none: there is no mise to
# acquire with, and "empty" is the honest profile there (docs/d139).
dev_tools_profile() {
	case "${DEV_TOOLS_PROFILE:-}" in
	full | none) printf '%s\n' "${DEV_TOOLS_PROFILE}" ;;
	'')
		if dev_tools_is_termux || ! command -v mise >/dev/null 2>&1; then
			printf 'none\n'
		else
			printf 'full\n'
		fi
		;;
	*)
		log_die 64 'unknown DEV_TOOLS_PROFILE' value="$DEV_TOOLS_PROFILE" \
			hint='DEV_TOOLS_PROFILE=full|none'
		;;
	esac
}

_dev_tools_mise() {
	[ "$(dev_tools_profile)" = full ] && command -v mise >/dev/null 2>&1
}

# dev_tool_run <tool> <command> [args...] — run COMMAND with TOOL's pinned
# version provided. Usually the command IS the tool; the other use is a driver
# that shells out to it (`find … -exec shellcheck`, `go test`), where the tool
# only has to sit on PATH. On a dev host mise acquires it on demand (`mise exec`
# auto-installs — the behaviour the lint legs already relied on); elsewhere the
# host binary is the only option and its absence is a fatal, explained error,
# never a silent skip.
dev_tool_run() {
	_dev_tool=$1
	shift
	if _dev_tools_mise; then
		mise exec "$_dev_tool@$(dev_tool_pin "$_dev_tool")" -- "$@"
		return $?
	fi
	command -v "$_dev_tool" >/dev/null 2>&1 ||
		log_die 96 "missing $_dev_tool — no mise on this host" tool="$_dev_tool" \
			hint="install it with the host package manager"
	"$@"
}

# dev_tool_bin <tool> — the real binary path, for callers that must run it
# DIRECTLY: golangci-lint shells out to `go list`, and `mise exec` rebuilds PATH
# from its own tool set, so the child would hit the version-less mise shim of a
# repo that pins nothing (docs/d137). `mise which` is no use here — it answers
# only for an already-installed exact version, while the pin is a prefix.
dev_tool_bin() {
	_dev_tool=$1
	if _dev_tools_mise; then
		# shellcheck disable=SC2016  # $0 is the inner sh's argv[0], not this shell's
		mise exec "$_dev_tool@$(dev_tool_pin "$_dev_tool")" -- sh -c 'command -v "$0"' "$_dev_tool" ||
			return 1
	elif command -v "$_dev_tool" >/dev/null 2>&1; then
		command -v "$_dev_tool"
	else
		return 1
	fi
}

# dev_tool_ensure <tool> — the same acquisition with no command to run (the
# one-shot installer path).
dev_tool_ensure() {
	_dev_tool=$1
	if _dev_tools_mise; then
		mise install "$_dev_tool@$(dev_tool_pin "$_dev_tool")"
	elif command -v "$_dev_tool" >/dev/null 2>&1; then
		log_info 'present (host package)' tool="$_dev_tool"
	else
		log_die 96 "missing $_dev_tool — no mise on this host" tool="$_dev_tool" \
			hint="install it with the host package manager"
	fi
}

_dev_tools_install() {
	if dev_tools_is_termux; then
		_environment=termux
	else
		_environment=$(uname -sm)
	fi
	_profile=$(dev_tools_profile)
	log_info 'dev toolchain' profile="$_profile" environment="$_environment"
	if [ "$_profile" = none ]; then
		# Deliberately empty: a runtime/restrictive box must not be mutated by a
		# dev convenience, and there is no mise to mutate it with.
		log_info 'nothing to install — the host package manager owns this environment' \
			hint='install what you need with the host package manager'
		return 0
	fi
	for _t in "$@"; do
		log_info 'install' tool="$_t" version="$(dev_tool_pin "$_t")"
		dev_tool_ensure "$_t"
	done
}

# Executed, not sourced: install. The guard compares the BASENAME of $0,
# because the sweeps source this file from their own directory and must not
# trigger an install walk.
case "${0##*/}" in
dev-tools.sh)
	set -eu
	_dev_tools_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
	# shellcheck source-path=SCRIPTDIR source=log.sh
	. "$_dev_tools_dir/log.sh"
	LOG_TOOL='dev-tools'
	export LOG_TOOL
	if [ "$#" -gt 0 ]; then
		_dev_tools_install "$@"
	else
		# shellcheck disable=SC2086  # splitting the one tool list is the point
		_dev_tools_install $DEV_TOOLS_ALL
	fi
	;;
esac
