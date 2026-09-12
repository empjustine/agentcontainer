#!/bin/sh
# Resolve a GGUF (and its mmproj projector and optional MTP drafter, for
# multimodal / speculatively-decoded models) from the in-container HF hub cache
# to ONE snapshot directory, normalize sharded GGUFs to their 00001 shard, then
# exec the inference server with --model/--mmproj/--model-draft appended.  When
# the files are not cached, fall back to the server's own HF downloader (--hf-repo/--hf-file), which fetches into the same hub-cache
# layout — the naive `llama-server -hf <repo>` behavior.
#
# Why this exists: llama-swap runs model `cmd`s through posix shlex splitting +
# direct exec (internal/config/commands.go SanitizeCommand) — NO shell. Shell
# syntax ($(...), assignments, globs) therefore cannot appear inline in a
# `cmd:` string, and `sh -c '...'` wrapping breaks on the single quotes inside
# the sampling macros (--chat-template-kwargs '{...}'). This script carries the
# dynamic resolution instead; generate-local-llm-models.yaml.mjs emits plain
# argv cmds that call it.
#
# Mounted read-only via run.sh (config.d -> /etc/llama-swap/config.d); invoked
# as `sh <script>` so no exec bit is needed.
#
# Source copy lives at the folder root (llm-local-inference/launch-gguf.sh);
# llm-local-inference/generate.sh copies it into config.d/ alongside
# 10-local-llm-inference.yaml when the host supports local inference.
#
# usage: launch-gguf.sh <repo-dir> <repo-id> <gguf-file> <mmproj-file|-> <draft-file|-> -- \
#            <server-cmd> [server args...]
#   repo-dir    models--<org>--<repo> dir name under the HF hub cache
#   repo-id     <org>/<repo> (for --hf-repo on the download fallback)
#   gguf-file   GGUF filename inside the snapshot (later shards normalized)
#   mmproj      projector filename required in the SAME snapshot, or "-" for none
#   draft       MTP/drafter GGUF filename required in the SAME snapshot, or "-";
#               appended as --model-draft (pairs with an explicit --spec-type,
#               which the caller must emit: a bare --model-draft enables no
#               speculative impl when the model is passed as a local path)
#   server-cmd  first token of the expanded ${LLAMA_SERVER} macro ("llama-server")
#
# The server binary is looked up in PATH first, then common install dirs —
# image layouts differ across llama-swap unified-image revisions, and a bare
# argv[0] that llama-swap cannot resolve exits 127 without a usable hint.
#
# Download fallback: enabled by default; LAUNCH_GGUF_DOWNLOAD=0 makes a cache
# miss a hard error instead (offline hosts, surprise-bandwidth avoidance).
# Auth uses HF_TOKEN from the environment, as passed by run.sh (which mounts
# the HF hub cache only on locally-capable hosts).

set -u

# Structured JSON logging to stderr.  Self-contained: this script is copied
# into config.d/ (read-only mount inside the serving container) and cannot
# reach lib/log.sh.  Values below are paths/ids — no metacharacters — so the
# escaping of the full lib is omitted.
LOG_TOOL='launch-gguf'
log_emit() {
	_l_level="$1"; shift
	_l_msg="$1"; shift
	_l_fields=""
	for _l_kv in "$@"; do
		case "$_l_kv" in *=*) ;; *) continue ;; esac
		_l_fields="$_l_fields,\"${_l_kv%%=*}\":\"${_l_kv#*=}\""
	done
	printf '{"ts":"%s","level":"%s","tool":"%s","msg":"%s"%s}\n' \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_l_level" "$LOG_TOOL" "$_l_msg" \
		"$_l_fields" >&2
}
log_info() { log_emit info "$@"; }
log_warn() { log_emit warn "$@"; }
log_error() { log_emit error "$@"; }
log_die() { _d_code="$1"; shift; log_error "$@"; exit "$_d_code"; }

# Container mount per run.sh; LAUNCH_GGUF_HUB overrides for testing.
hub=${LAUNCH_GGUF_HUB:-/home/ubuntu/.cache/huggingface/hub}

repo_dir=$1
repo_id=$2
gguf=$3
mmproj=$4
draft=$5
shift 5

if [ "${1:-}" != "--" ]; then
	log_die 64 "expected -- separator" got="${1:-}"
fi
shift

# Sharded GGUFs: llama.cpp auto-loads sibling shards when pointed at the
# 00001 shard; normalize up front so both the cache lookup and the download
# fallback use the first shard.
case $gguf in
*-[0-9][0-9][0-9][0-9][0-9]-of-[0-9][0-9][0-9][0-9][0-9].gguf)
	base=${gguf%-of-*}
	base=${base%-*}
	gguf=$base-00001-of-${gguf##*-of-}
	;;
esac

snap=
for d in "$hub/$repo_dir"/snapshots/*; do
	[ -f "$d/$gguf" ] || continue
	if [ "$mmproj" != "-" ] && [ ! -f "$d/$mmproj" ]; then continue; fi
	if [ "$draft" != "-" ] && [ ! -f "$d/$draft" ]; then continue; fi
	snap=$d
	break
done

server=$1
case $server in
*/*) ;;
*)
	if ! command -v "$server" >/dev/null 2>&1; then
		found=
		for d in /usr/local/bin /usr/bin /bin /opt/llama.cpp/bin /app /app/bin; do
			if [ -x "$d/$server" ]; then
				found=$d/$server
				break
			fi
		done
		if [ -z "$found" ]; then
			log_error "server not found in PATH nor in common install dirs" \
				server="$server" path="${PATH:-<unset>}"
			exit 127
		fi
		shift
		set -- "$found" "$@"
	fi
	;;
esac

missing_msg() {
	printf '%s' "$gguf"
	[ "$mmproj" != "-" ] && printf ' and/or mmproj %s' "$mmproj"
	[ "$draft" != "-" ] && printf ' and/or drafter %s' "$draft"
}

if [ -n "$snap" ]; then
	set -- "$@" --model "$snap/$gguf"
	if [ "$mmproj" != "-" ]; then
		set -- "$@" --mmproj "$snap/$mmproj"
	fi
	if [ "$draft" != "-" ]; then
		set -- "$@" --model-draft "$snap/$draft"
	fi
else
	case ${LAUNCH_GGUF_DOWNLOAD:-1} in
	0 | false | no)
		log_error "not found in the same snapshot; download fallback disabled (LAUNCH_GGUF_DOWNLOAD=0)" \
			missing="$(missing_msg)" repo="$repo_id" hub="$hub/$repo_dir/snapshots"
		exit 1
		;;
	esac
	log_warn "not cached; delegating download to the server (--hf-repo/--hf-file)" \
		missing="$(missing_msg)" repo="$repo_id" hub="$hub/$repo_dir/snapshots" server="$server"
	set -- "$@" --hf-repo "$repo_id" --hf-file "$gguf"
fi
exec "$@"
