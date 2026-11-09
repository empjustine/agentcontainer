#!/bin/sh
# lib/log.sh — structured logging shared by this repo's shell tools.
#
# One JSON object per line on stdout (LOG_FORMAT=logfmt for logfmt):
#   {"msg":"...","key":"value","ts":1756824000000,"severityNumber":9,"tool":"coding-agent/run"}
#
# `msg` leads and this kernel's three fields trail it, so the event is what a
# truncated view keeps. `ts` is Unix epoch MILLISECONDS as a number and
# `severityNumber` is OpenTelemetry's SeverityNumber, so a reader compares
# numbers where it used to match level words (docs/d151 owns the record shape,
# its field order and the canonical ranges; the bands are TRACE 1-4, DEBUG 5-8,
# INFO 9-12, WARN 13-16, ERROR 17-20, FATAL 21-24, and 0 is unspecified).
#
# Level filtering is the consumer's job (docs/d045, reaffirmed by d060):
# nothing is dropped here. A script logs the useful-but-noisy detail at
# `debug` unconditionally instead of growing a --verbose branch, and whoever
# reads the stream prunes it (`jq 'select(.severityNumber >= 5)'`, or takes
# one band with `jq 'select(.severityNumber >= 17)'`). docs/d045 owns the rest
# of that contract (static labels, key=value fields).
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

# Unix epoch milliseconds. `%3N` is GNU coreutils-only — BusyBox and toybox
# print the literal instead of a fraction — so the result is validated and a
# whole-second value widened: a coarser clock is survivable, two units in one
# stream are not.
_log_ts() {
	_log_now=$(date +%s%3N 2>/dev/null)
	case "$_log_now" in
		'' | *[!0-9]*) echo "$(( $(date +%s) * 1000 ))" ;;
		*) echo "$_log_now" ;;
	esac
}

# log_json_escape string — escape for a JSON string literal (no surrounding
# quotes).  awk joins records with a literal \n so multi-line values survive.
# Public because the escaping RULE must have exactly one implementation:
# logs and any JSON a script builds with this function must never disagree
# about what is valid JSON.
log_json_escape() {
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

# OpenTelemetry SeverityNumber per level (docs/d151). 0 is the spec's
# "unspecified" and is the unreachable fallback: every caller is one of the
# level functions below, so a stray name is a bug in this file.
_log_severity() {
	case "$1" in
		trace) echo 1 ;;
		debug) echo 5 ;;
		info) echo 9 ;;
		warn) echo 13 ;;
		error) echo 17 ;;
		fatal) echo 21 ;;
		*) echo 0 ;;
	esac
}

# log_emit LEVEL MSG [key=value ...] — the single choke point.
log_emit() {
	_l_level="$1"; shift
	_l_msg="$1"; shift
	_l_sev=$(_log_severity "$_l_level")

	_l_fields=""
	for _l_kv in "$@"; do
		case "$_l_kv" in *=*) ;; *) continue ;; esac
		_l_k="${_l_kv%%=*}"
		_l_v="${_l_kv#*=}"
		_l_fields="$_l_fields,\"$_l_k\":\"$(log_json_escape "$_l_v")\""
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
			# The event leads; the kernel's own three fields trail it, so a
			# reader skimming raw lines meets what happened before the
			# bookkeeping (docs/d151).
			_log_out "msg=\"$_l_msg\"$_l_kvout ts=$(_log_ts) severityNumber=$_l_sev tool=$LOG_TOOL"
			;;
		*)
			_log_out "{\"msg\":\"$(log_json_escape "$_l_msg")\"$_l_fields,\"ts\":$(_log_ts),\"severityNumber\":$_l_sev,\"tool\":\"$LOG_TOOL\"}"
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
