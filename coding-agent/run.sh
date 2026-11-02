#!/bin/sh
# run.sh — compatibility shim. The launcher is run.mjs (docs/d041/d113 keep the
# entry per folder; the port moved argv assembly into a pure buildLaunch so it
# can be asserted without a backend). This word stays because the documented
# chain `./environment.sh ./coding-agent/run.sh`, the README and every operator
# habit name it — the code behind it is the same, one process deeper.
#
# Not `exec`: node_run is a shell FUNCTION, and `exec` cannot resolve one, so
# the exit code is carried back through this shim instead (set -e makes a
# non-zero node status this script's status).
set -eu
unit=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib/node-run.sh
. "$unit/lib/node-run.sh"
node_run "$unit/run.mjs" "$@"
