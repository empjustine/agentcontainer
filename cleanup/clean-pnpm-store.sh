#!/bin/sh
# clean-pnpm-store.sh — remove local JS package stores under a root.
# The .pnpm inside node_modules belongs to clean-node-modules.sh; removing the
# parent already takes it.
set -eu
DIR=$(dirname "$0")
# shellcheck source-path=SCRIPTDIR/lib source=cleanup.sh
. "$DIR/lib/cleanup.sh"

usage() {
	cat <<EOF
usage: clean-pnpm-store.sh [--apply] [root]
  remove .pnpm-store, .pnpm, .yarn and .npm (package stores/caches).
  Default: dry-run.
EOF
}

init_cleanup "JS package stores" "$@"

find "$ROOT" \
	\( -name .git -o -name node_modules \) -prune -o \
	\( -name .pnpm-store -o -name .pnpm -o -name .yarn -o -name .npm \) \
	-type d -print -prune \
	>"$TMPF" 2>/dev/null || true

each_candidate
report
