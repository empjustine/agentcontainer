#!/bin/sh
# clean-node-modules.sh — remove node_modules directories under a root.
# The lockfile reinstalls them; pruning the directory avoids a second listing
# of the .pnpm tree it contains.
set -eu
DIR=$(dirname "$0")
# shellcheck source-path=SCRIPTDIR/lib source=cleanup.sh
. "$DIR/lib/cleanup.sh"

usage() {
	cat <<EOF
usage: clean-node-modules.sh [--apply] [root]
  remove node_modules (npm/pnpm/yarn). Default: dry-run.
  Reinstall with npm ci / pnpm install --frozen-lockfile.
EOF
}

init_cleanup "node_modules" "$@"

find "$ROOT" -name .git -prune -o \
	-name node_modules \( -type d -o -type l \) -print -prune \
	>"$TMPF" 2>/dev/null || true

each_candidate
report
