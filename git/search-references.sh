#!/bin/sh
# search-references.sh — interpreter shim: run the repo-pinned node on the
# reference-farm search driver. Usage lives in search-references.mjs (--help)
# and docs/d043. The engine itself (Zoekt) runs as a container; this shim and
# the node program only discover mirrors and assemble argv.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/search-references.mjs" "$@"
