#!/bin/sh
# -forge-mirror.sh — acquire any forge repo (public https forges and the
# work tenant's software forge) into a reference farm as a BARE MIRROR.
# Interpreter shim: usage lives in forge-mirror.mjs (--help) and
# docs/d044/d099. The leading `-` matches the hand-run git/ entries.
#
# The flock wraps the ONE step that mutates a mirror which already exists —
# the implicit `remote update --prune` an acquisition runs on it, handed
# back through this entry as --align (docs/d166). Validation and cloning a
# path nothing else knows yet stay unlocked: an add must never queue behind a
# repack it has no part in, and the align sub-run is where "one mutation on
# the farm, no matter which entry started it" still applies.
set -eu
unit=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=${unit%/*}
# shellcheck source-path=SCRIPTDIR source=farm-lock.sh
. "$unit/farm-lock.sh"

# --align is the phase node cannot take itself: forge-mirror.mjs spawns this
# entry for the align so the lock stays in shell — flock on an fd is the one
# mechanism, and node names, probes and describes the lock only (docs/d121).
if [ "${1:-}" = "--align" ]; then
	shift
	with_farm_mutation_lock "$repo/node-run.sh" "$unit/forge-mirror.mjs" --align "$@"
	exit $?
fi
exec "$repo/node-run.sh" "$unit/forge-mirror.mjs" "$@"
