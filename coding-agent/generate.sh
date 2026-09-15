#!/bin/sh
# generate.sh — interpreter shim (docs/d041): the whole generator (staging,
# stage sequencing, installs) lives in generate.mjs. Secrets arrive as plain
# environment — run through the explicit chain: ./lib/environment.sh ./generate.sh
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/generate.mjs" "$@"
