#!/bin/sh
# farm-tool.sh — interpreter shim: run the repo-pinned node on d099's farm tool
# surface. Usage lives in farm-tool.mjs (--help); the posture the verbs share
# lives in lib/farm-posture.mjs.
#
# This entry NAME is the interface: the later stdio MCP server wraps
# `./git/farm-tool.sh TOOL [ARGS...]` verbatim (docs/d099), so the usage text
# names this shim rather than the .mjs beside it.
set -eu
# shellcheck source-path=SCRIPTDIR source=lib/node-run.sh
. "$(dirname "$0")/lib/node-run.sh"
node_run "$(dirname "$0")/farm-tool.mjs" "$@"
