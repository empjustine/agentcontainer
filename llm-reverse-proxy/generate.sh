#!/bin/sh
# generate.sh — interpreter shim (docs/d041): all generator logic lives in
# generate.mjs. Secrets: none at generation time; no vault round-trip, ever.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/generate.mjs" "$@"
