#!/bin/sh
# vbs-har.sh — interpreter shim: run the repo-pinned node on the VBS HAR to
# mirror-manifest converter. Usage lives in vbs-har.mjs (--help) and docs/d044.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/vbs-har.mjs" "$@"
