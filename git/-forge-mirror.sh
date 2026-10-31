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
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
# shellcheck source-path=SCRIPTDIR source=farm-lock.sh
. "$(dirname "$0")/farm-lock.sh"
with_farm_mutation_lock node_run "$(dirname "$0")/forge-mirror.mjs" "$@"
