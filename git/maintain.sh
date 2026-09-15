#!/bin/sh
# maintain.sh — interpreter shim: run the repo-pinned node on the mirror
# maintenance. Usage lives in maintain-mirrors.mjs (--help) and
# non-bare-issues.md. No secrets and no container runtime are involved.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/maintain-mirrors.mjs" "$@"
