#!/bin/sh
# local-changes.sh — interpreter shim: run the repo-pinned node on the
# local-changes viewer. Usage lives in local-changes.mjs (--help). No secrets
# and no container runtime are involved — this only reads git state.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/local-changes.mjs" "$@"
