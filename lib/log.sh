#!/bin/sh
# lib/log.sh — structured logging shared by this repo's shell tools.
#
# One JSON object per line on stdout (LOG_FORMAT=logfmt for logfmt):
#   {"ts":"2025-09-02T12:00:00Z","level":"info","tool":"coding-agent/run","msg":"...","key":"value"}
#
# No level filtering happens here, ever — debug/trace/warn/error all go to the
# stream; a consumer that wants less noise filters downstream with jsonlines
# tooling (`jq 'select(.level=="error")'`). docs/d045 owns the policy.
#
# Stream: stdout by default; a script whose stdout IS the machine-consumed
# payload (a report, a list, a manifest) exports LOG_STREAM=stderr so logs
# cannot interleave with the payload — `2>&1 | jq` still yields one jsonlines
# stream.
#
# Env:
#   LOG_STREAM  stdout|stderr   (default: stdout)
#   LOG_FORMAT  json|logfmt     (default: json)
#   LOG_TOOL    component name  (default: "sh"; each tool overrides, e.g.
#               LOG_TOOL=coding-agent/generate)
#
# Usage:
#   . /path/to/lib/log.sh
#   LOG_TOOL=mytool
#   log_info "regenerated models" path="$out" providers="$n"
#   log_die 91 "no container tool"
#
# Field args must be key=value; non-conforming args are ignored.  Values are
# JSON-escaped (\, ", tab, CR; newlines become \n).  Keys are emitted verbatim.

LOG_FORMAT="${LOG_FORMAT:-json}"
LOG_STREAM="${LOG_STREAM:-stdout}"
LOG_TOOL="${LOG_TOOL:-sh}"

_log_out() {
	if [ "$LOG_STREAM" = stderr ]; then
		printf '%s\n' "$1" >&2
	else
		printf '%s\n' "$1"
	fi
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
			_log_out "ts=$(_log_ts) level=$_l_level tool=$LOG_TOOL msg=\"$_l_msg\"$_l_kvout"
			;;
		*)
			_log_out "{\"ts\":\"$(_log_ts)\",\"level\":\"$_l_level\",\"tool\":\"$LOG_TOOL\",\"msg\":\"$(_log_json_escape "$_l_msg")\"$_l_fields}"
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
