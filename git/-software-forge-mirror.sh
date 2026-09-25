#!/bin/sh
# -software-forge-mirror.sh — interpreter shim: run the repo-pinned node on the
# software-forge work-mirror acquisition. Usage lives in
# software-forge-mirror.mjs (--help) and docs/d044. The leading `-` matches its
# hand-run acquisition siblings -forge-mirror.sh / -github-clone.sh.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/software-forge-mirror.mjs" "$@"
