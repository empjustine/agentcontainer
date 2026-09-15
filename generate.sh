#!/bin/sh
# generate.sh — interpreter shim (docs/d041): generate.mjs generates every
# runner folder at once (proxy, local inference, coding agent); each folder's
# own generate.sh still works standalone. Secrets: only coding-agent stages
# consume vault env — use ./lib/environment.sh when that matters.
set -eu
# shellcheck source-path=SCRIPTDIR source=lib/node-run.sh
. "$(dirname "$0")/lib/node-run.sh"
node_run "$(dirname "$0")/generate.mjs" "$@"
