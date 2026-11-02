#!/bin/sh
# generate.sh — interpreter shim (docs/d041): the whole generator (output dir,
# stage sequencing, installs) lives in generate.mjs. Secrets arrive as plain
# environment — run through the explicit chain: ./environment.sh ./generate.sh
#
# Delegates to the package.json `generate` script through lib/npm-run.sh, so the
# documented local entrypoint and the discoverable npm script are one code path
# under the same pinned interpreter (no `npm` on PATH involved).
set -eu
# shellcheck source-path=SCRIPTDIR source=lib/node-run.sh
. "$(dirname "$0")/lib/node-run.sh"
# shellcheck source-path=SCRIPTDIR source=lib/npm-run.sh
. "$(dirname "$0")/lib/npm-run.sh"
npm_run generate "$@"
