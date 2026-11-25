#!/bin/sh
# run-all.sh — run every clean-*.sh in alphabetical order.
# git-gc.sh stays out: recovering history through the reflog is development
# routine, not automatic cleanup.
set -eu
DIR=$(dirname "$0")
LOG_TOOL=cleanup
# shellcheck source-path=SCRIPTDIR/lib source=log.sh
. "$DIR/lib/log.sh"

for s in "$DIR"/clean-*.sh; do
	[ -e "$s" ] || continue
	log_info "run cleaner" script="$(basename "$s")"
	sh "$s" "$@"
done
