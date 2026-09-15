#!/bin/sh
# audit.sh — interpreter shim: run the repo-pinned node on the reference-farm
# audit. Usage lives in audit.mjs (--help) and non-bare-issues.md.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/audit.mjs" "$@"
