#!/bin/sh
# clean-os-junk.sh — remove operating-system junk under a root.
# Files are removed under the git guards; ._* directories are only reported:
# a whole ._* .git copy can be the only copy of a repository.
set -eu
DIR=$(dirname "$0")
# shellcheck source-path=SCRIPTDIR/lib source=cleanup.sh
. "$DIR/lib/cleanup.sh"

usage() {
	cat <<EOF
usage: clean-os-junk.sh [--apply] [root]
  remove .DS_Store, Thumbs.db, desktop.ini, *~ and ._* files; report ._*
  directories without removing them. Default: dry-run.
EOF
}

init_cleanup "OS junk" "$@"

find "$ROOT" \
	\( -name .git -o -name node_modules -o -name '.venv*' \) -prune -o \
	\( -name .DS_Store -o -name Thumbs.db -o -name desktop.ini \
	-o -name '*~' -o -name '._*' \) -type f -print -o \
	-name '._*' -type d -print \
	>"$TMPF" 2>/dev/null || true

while IFS= read -r p; do
	[ -n "$p" ] || continue
	if [ -d "$p" ]; then
		REPORTED_DIRS=$((REPORTED_DIRS + 1))
		log_warn "kept dot-directory" path="$p" reason="origin-unconfirmed"
	else
		consider "$p"
	fi
done <"$TMPF"

report
