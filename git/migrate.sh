#!/bin/sh
# migrate.sh — interpreter shim: run the repo-pinned node on the migration.
# Usage lives in migrate-to-bare.mjs (--help) and non-bare-issues.md.
# No secrets and no container runtime are involved — this only touches the
# host reference farm.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/migrate-to-bare.mjs" "$@"
