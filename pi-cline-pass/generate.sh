#!/bin/sh
# generate.sh — interpreter shim (docs/d041): everything (the two source
# reads, the reconciliation, the eligibility guards, the artifact writes)
# lives in generate.mjs. Both sources are public — the models.dev catalog
# and Cline's published docs file — and reach the network through the
# environment's forward proxy (NODE_USE_ENV_PROXY=1, docs/d074), so this
# needs no vault and no ./lib/environment.sh chain.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/generate.mjs" "$@"
