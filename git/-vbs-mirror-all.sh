#!/bin/sh
# -vbs-mirror-all.sh — interpreter shim: run the repo-pinned node on the VBS
# bulk mirror. Usage lives in vbs-mirror-all.mjs (--help); the leading dash on
# this name is deliberate, it keeps the operator entry visually separate from
# the tools the farm serve.
set -eu
# shellcheck source-path=SCRIPTDIR source=lib/node-run.sh
. "$(dirname "$0")/lib/node-run.sh"
node_run "$(dirname "$0")/vbs-mirror-all.mjs" "$@"
