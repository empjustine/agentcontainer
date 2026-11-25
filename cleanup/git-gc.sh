#!/bin/sh
# git-gc.sh — git maintenance, deliberately outside run-all.sh.
# A gc keeps the reflog, so a commit reachable only from a reset or a deleted
# branch survives; --prune=now is not used because the reflog grace period is
# the safety net for an interrupted operation. No --aggressive: the gain comes
# from consolidating loose objects, not from a costlier repack.
set -eu
DIR=$(dirname "$0")
# shellcheck source-path=SCRIPTDIR/lib source=cleanup.sh
. "$DIR/lib/cleanup.sh"

usage() {
	cat <<EOF
usage: git-gc.sh [--apply] [root]
  run git gc in every repository under root (default grace period, no
  --prune=now). Default: dry-run; measures .git and prints the command.
  This is maintenance, not cleanup: it never runs from run-all.sh.
EOF
}

init_cleanup "git gc" "$@"

find "$ROOT" -name .git \( -type d -o -type f \) -prune -print \
	>"$TMPF" 2>/dev/null || true

TOTAL_KB=0
FAILED=0
while IFS= read -r g; do
	[ -n "$g" ] || continue
	repo=$(dirname "$g")
	gitdir=$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null) || gitdir=""
	if [ -z "$gitdir" ] || [ ! -d "$gitdir" ]; then
		log_warn "skipped invalid git repository" path="$repo"
		continue
	fi
	kb=$(du -sk "$gitdir" 2>/dev/null | sed -n '1s/[[:space:]].*//p')
	[ -n "$kb" ] || kb=0
	TOTAL_KB=$((TOTAL_KB + kb))
	N=$((N + 1))
	if [ "$APPLY" = 1 ]; then
		git_size=$(human_kb "$kb")
		log_info "git gc" path="$repo" git_dir_size="$git_size"
		if git -C "$repo" gc --quiet; then
			kb2=$(du -sk "$gitdir" 2>/dev/null | sed -n '1s/[[:space:]].*//p')
			[ -n "$kb2" ] || kb2=$kb
			freed=$((kb - kb2))
			[ "$freed" -gt 0 ] || freed=0
			FREED_KB=$((FREED_KB + freed))
			log_info "git gc done" path="$repo" \
				git_dir_size="$(human_kb "$kb2")" freed="$(human_kb "$freed")"
		else
			FAILED=$((FAILED + 1))
			log_error "git gc failed" path="$repo" reason="lock-or-error"
		fi
	else
		log_info "would run git gc" path="$repo" git_dir_size="$(human_kb "$kb")"
	fi
done <"$TMPF"

if [ "$APPLY" = 1 ]; then mode=apply; else mode=dry-run; fi
log_info "git gc summary" \
	mode="$mode" repos="$N" git_dir_total_kb="$TOTAL_KB" \
	git_dir_total="$(human_kb "$TOTAL_KB")" freed_kb="$FREED_KB" \
	freed="$(human_kb "$FREED_KB")" failed="$FAILED"
exit 0
