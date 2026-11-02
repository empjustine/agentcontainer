#!/bin/sh
# build.sh — interpreter shim (docs/d041, d083): the coding-agent image build
# lives in this folder's own build.mjs (docs/d104 folded the root builder into
# the units). Secrets: none — builds are keyless.
set -eu
# shellcheck source-path=SCRIPTDIR source=lib/node-run.sh
. "$(dirname "$0")/lib/node-run.sh"
node_run "$(dirname "$0")/build.mjs" "$@"
