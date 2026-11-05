#!/bin/sh
# -forge-mirror.sh — acquire any forge repo (public https forges and the
# work tenant's software forge) into a reference farm as a BARE MIRROR.
# Interpreter shim: usage lives in forge-mirror.mjs (--help) and
# docs/d044/d099. The leading `-` matches the hand-run git/ entries.
#
# The flock wrap is d099's maintenance surface: acquisition is a farm
# mutation, so it queues behind a hand-run ./git/maintain.sh sweep and vice
# versa — one mutation on the farm no matter which entry started it.
set -eu
unit=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=${unit%/*}
# shellcheck source-path=SCRIPTDIR source=farm-lock.sh
. "$unit/farm-lock.sh"
with_farm_mutation_lock "$repo/node-run.sh" "$unit/forge-mirror.mjs" "$@"
