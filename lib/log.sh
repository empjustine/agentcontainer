#!/bin/sh
# lib/log.sh — structured logging shared by this repo's shell tools.
#
# One JSON object per line on stderr:
#   {"ts":"2025-09-02T12:00:00Z","level":"info","tool":"coding-agent/run","msg":"...","key":"value"}
# Set LOG_FORMAT=logfmt for logfmt instead (key=value pairs).  Stdout stays
# reserved for machine-consumed output (file contents, lists, redirected
# artifacts) — never log to it.
#
# Env:
#   LOG_LEVEL  debug|info|warn|error   (default: info)
#   LOG_FORMAT json|logfmt             (default: json)
#   LOG_TOOL   component name          (default: "sh"; each tool overrides,
#              e.g. LOG_TOOL=coding-agent/generate)
#
# Usage:
#   . /path/to/lib/log.sh
#   LOG_TOOL=mytool
#   log_info "regenerated models" path="$out" providers="$n"
#   log_die 91 "no container tool"
#
# Field args must be key=value; non-conforming args are ignored.  Values are
# JSON-escaped (\, ", tab, CR; newlines become \n).  Keys are emitted verbatim.

LOG_LEVEL="${LOG_LEVEL:-info}"
LOG_FORMAT="${LOG_FORMAT:-json}"
LOG_TOOL="${LOG_TOOL:-sh}"

_log_prio() {
	case "$1" in
		debug) printf 0 ;; info) printf 1 ;; warn) printf 2 ;; error) printf 3 ;;
		*) printf 1 ;;
	esac
}

_log_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# _log_json_escape string — escape for a JSON string literal (no surrounding
# quotes).  awk joins records with a literal \n so multi-line values survive.
_log_json_escape() {
	printf '%s' "$1" | awk 'BEGIN { ORS = "" }
	{
		gsub(/\\/, "\\\\")
		gsub(/"/, "\\\"")
		gsub(/\t/, "\\t")
		gsub(/\r/, "\\r")
		if (NR > 1) printf "\\n"
		print
	}'
}

# log_emit LEVEL MSG [key=value ...] — the single choke point.
log_emit() {
	_l_level="$1"; shift
	_l_msg="$1"; shift
	[ "$(_log_prio "$_l_level")" -ge "$(_log_prio "$LOG_LEVEL")" ] || return 0

	_l_fields=""
	for _l_kv in "$@"; do
		case "$_l_kv" in *=*) ;; *) continue ;; esac
		_l_k="${_l_kv%%=*}"
		_l_v="${_l_kv#*=}"
		_l_fields="$_l_fields,\"$_l_k\":\"$(_log_json_escape "$_l_v")\""
	done

	case "$LOG_FORMAT" in
		logfmt)
			_l_kvout=""
			for _l_kv in "$@"; do
				case "$_l_kv" in *=*) ;; *) continue ;; esac
				_l_k="${_l_kv%%=*}"
				_l_v="${_l_kv#*=}"
				case "$_l_v" in
					*['" 	']*|'') _l_kvout="$_l_kvout $_l_k=\"$_l_v\"" ;;
					*)       _l_kvout="$_l_kvout $_l_k=$_l_v" ;;
				esac
			done
			printf 'ts=%s level=%s tool=%s msg="%s"%s\n' \
				"$(_log_ts)" "$_l_level" "$LOG_TOOL" "$_l_msg" "$_l_kvout" >&2
			;;
		*)
			printf '{"ts":"%s","level":"%s","tool":"%s","msg":"%s"%s}\n' \
				"$(_log_ts)" "$_l_level" "$LOG_TOOL" \
				"$(_log_json_escape "$_l_msg")" "$_l_fields" >&2
			;;
	esac
}

log_debug() { log_emit debug "$@"; }
log_info()  { log_emit info  "$@"; }
log_warn()  { log_emit warn  "$@"; }
log_error() { log_emit error "$@"; }

# log_die EXIT_CODE MSG [key=value ...] — log at error level, then exit.
log_die() {
	_d_code="$1"; shift
	log_error "$@"
	exit "$_d_code"
}
