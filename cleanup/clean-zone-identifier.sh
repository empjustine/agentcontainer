#!/bin/sh
# clean-zone-identifier.sh — remove Windows/WSL Zone.Identifier sidecars.
# The sidecar is a ':'-suffixed filename that breaks Unix build and checkout
# tools; a tracked sidecar is still protected by the git guard.
set -eu
DIR=$(dirname "$0")
# shellcheck source-path=SCRIPTDIR/lib source=cleanup.sh
. "$DIR/lib/cleanup.sh"

usage() {
	cat <<EOF
usage: clean-zone-identifier.sh [--apply] [root]
  remove files named "*:Zone.Identifier" (NTFS/WSL download markers).
  Default: dry-run; tracked paths are skipped.
EOF
}

init_cleanup "Zone.Identifier sidecars" "$@"

find "$ROOT" -name .git -prune -o \
	-name '*:Zone.Identifier' -type f -print \
	>"$TMPF" 2>/dev/null || true

each_candidate
report
