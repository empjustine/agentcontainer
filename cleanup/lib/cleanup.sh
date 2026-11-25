#!/bin/sh
# cleanup.sh — shared engine for the clean-*.sh scripts.
#
# The caller sets DIR to the cleanup/ directory, then sources this file. It
# sources lib/log.sh (structured JSON logs) and owns the CLI, the three git
# guards and the summary. Source this file after setting DIR:
#
#   DIR=$(dirname "$0")
#   # shellcheck source-path=SCRIPTDIR/lib source=cleanup.sh
#   . "$DIR/lib/cleanup.sh"
#
# CLI: ./clean-<kind>.sh [--apply] [root]
#   root defaults to the current directory. --apply removes; the default is a
#   dry-run. The git guards decide per candidate: tracked -> skip, ignored ->
#   remove, in-repo but neither -> keep and warn.
set -eu

: "${DIR:?DIR must point at cleanup/ before sourcing cleanup.sh}"
LOG_TOOL=cleanup
# shellcheck source-path=SCRIPTDIR source=log.sh
. "$DIR/lib/log.sh"

APPLY=0
ROOT=$PWD
KIND=""
N=0
FREED_KB=0
SKIPPED_TRACKED=0
WARNED=0
REPORTED_DIRS=0
FAILED=0
TMPF=""

human_kb() {
	awk -v k="${1:-0}" 'BEGIN {
		if (k >= 1048576)      printf "%.2f GB", k / 1048576
		else if (k >= 1024)    printf "%.1f MB", k / 1024
		else                   printf "%d KB", k
	}'
}

# init_cleanup <kind> [--apply] [root]
# Normalizes the root to absolute because the git guards depend on it.
init_cleanup() {
	KIND=$1
	shift
	for arg in "$@"; do
		case "$arg" in
			--apply) APPLY=1 ;;
			-h | --help)
				usage
				exit 0
				;;
			-*)
				log_die 2 "unknown option" option="$arg"
				;;
			*) ROOT=$arg ;;
		esac
	done
	if [ ! -d "$ROOT" ]; then
		log_die 1 "root does not exist" root="$ROOT"
	fi
	ROOT=$(cd "$ROOT" && pwd) || log_die 1 "cannot resolve root" root="$ROOT"
	TMPF=$(mktemp) || log_die 1 "cannot create temporary file"
	trap 'rm -f "$TMPF"' 0
}

# git_top <path> — repository toplevel containing the path (empty outside).
git_top() {
	git -C "$(dirname "$1")" rev-parse --show-toplevel 2>/dev/null || true
}

# git_rel <path> <toplevel> — path relative to the repository (empty outside).
git_rel() {
	case "$1" in
		"$2"/*) printf '%s\n' "${1#"$2"/}" ;;
		*) : ;;
	esac
}

# is_tracked <path> — true when git tracks any file inside the path.
is_tracked() {
	p=$1
	top=$(git_top "$p")
	[ -n "$top" ] || return 1
	rel=$(git_rel "$p" "$top")
	[ -n "$rel" ] || return 1
	hit=$(git -C "$top" ls-files -- "$rel" 2>/dev/null | sed -n '1p') || hit=""
	[ -n "$hit" ]
}

# is_ignored <path> — true when the repository's .gitignore covers the path.
# The retry with a trailing slash resolves patterns such as "dist/", which
# match a directory only.
is_ignored() {
	p=$1
	top=$(git_top "$p")
	[ -n "$top" ] || return 1
	rel=$(git_rel "$p" "$top")
	[ -n "$rel" ] || return 1
	if git -C "$top" check-ignore -q -- "$rel" 2>/dev/null; then
		return 0
	fi
	git -C "$top" check-ignore -q -- "$rel/" 2>/dev/null
}

# is_in_repo <path> — true when the path is inside a git repository.
is_in_repo() {
	top=$(git_top "$1")
	[ -n "$top" ]
}

# consider <path> — measure, log and (with --apply) remove under the guards.
consider() {
	p=$1
	# shellcheck disable=SC2310  # the guard's status is the answer, not an error
	if is_tracked "$p"; then
		SKIPPED_TRACKED=$((SKIPPED_TRACKED + 1))
		log_info "skipped tracked path" path="$p" reason="git-tracked"
		return 0
	fi
	# shellcheck disable=SC2310  # idem: the guard answers with its status
	if is_in_repo "$p" && ! is_ignored "$p"; then
		WARNED=$((WARNED + 1))
		log_warn "kept path without a git signal" path="$p" reason="neither-tracked-nor-ignored"
		return 0
	fi
	kb=$(du -sk "$p" 2>/dev/null | sed -n '1s/[[:space:]].*//p')
	[ -n "$kb" ] || kb=0
	N=$((N + 1))
	FREED_KB=$((FREED_KB + kb))
	size=$(human_kb "$kb")
	if [ "$APPLY" = 1 ]; then
		if rm -rf "$p"; then
			log_info "removed" path="$p" size="$size" size_kb="$kb"
		else
			FAILED=$((FAILED + 1))
			log_error "remove failed" path="$p" size="$size" size_kb="$kb"
		fi
	else
		log_info "would remove" path="$p" size="$size" size_kb="$kb"
	fi
}

# each_candidate — run consider over every path the script wrote to $TMPF.
each_candidate() {
	while IFS= read -r p; do
		if [ -n "$p" ]; then consider "$p"; fi
	done <"$TMPF"
}

report() {
	if [ "$APPLY" = 1 ]; then mode=apply; else mode=dry-run; fi
	log_info "cleanup summary" \
		kind="$KIND" mode="$mode" items="$N" size_kb="$FREED_KB" \
		size="$(human_kb "$FREED_KB")" skipped_tracked="$SKIPPED_TRACKED" \
		warned="$WARNED" reported_dirs="$REPORTED_DIRS" failed="$FAILED"
}
