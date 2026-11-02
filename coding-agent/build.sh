#!/bin/sh
# build.sh — interpreter shim (docs/d041, d083): the coding-agent image build
# lives in this folder's own build.mjs (docs/d113 folded the root builder into
# the units). Secrets: none — builds are keyless.
#
# Since this unit's scripts moved under package.json, the shim delegates to the
# `build` script through lib/npm-run.sh: the entrypoint operators and CI already
# invoke keeps working, and `npm run build` here is the same code path instead of
# a second one. The delegation needs no `npm` on PATH (the body runs under the
# pinned node), so it adds no interpreter drift.
set -eu
# shellcheck source-path=SCRIPTDIR source=lib/node-run.sh
. "$(dirname "$0")/lib/node-run.sh"
# shellcheck source-path=SCRIPTDIR source=lib/npm-run.sh
. "$(dirname "$0")/lib/npm-run.sh"
npm_run build "$@"
