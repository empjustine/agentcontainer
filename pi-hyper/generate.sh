#!/bin/sh
# generate.sh — interpreter shim (docs/d041): everything (source reads, merge,
# guards, artifact writes) lives in generate.mjs. The catalog endpoint is
# PUBLIC, so no vault is needed; the request rides the environment's forward
# proxy (NODE_USE_ENV_PROXY=1 via ../lib/node-run.sh, docs/d074).
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/generate.mjs" "$@"
