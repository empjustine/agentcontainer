#!/bin/sh
# generate.sh — interpreter shim (docs/d041): all generator logic lives in
# generate.mjs. Secrets: none at generation time; no vault round-trip, ever.
set -eu
# Shared infra arrives through one injectable directory (docs/d082), the
# same LIB_DIR contract generate.mjs takes: default the repo's ../lib.
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "${LIB_DIR:-$(dirname "$0")/../lib}/node-run.sh"
node_run "$(dirname "$0")/generate.mjs" "$@"
