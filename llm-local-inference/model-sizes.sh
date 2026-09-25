#!/bin/sh
# model-sizes.sh — interpreter shim (docs/d041): all logic lives in
# model-sizes.mjs. Secrets: none; this reads committed manifests + the local
# HF cache and never touches the network.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/model-sizes.mjs" "$@"
