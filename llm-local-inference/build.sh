#!/bin/sh
# build.sh — per-unit build entry (docs/d083): selects this folder's target
# in the ROOT builder. d041 keeps the build LOGIC one implementation (the
# target table in build.mjs); only the entry point is per-unit — the same
# shape as the generate.sh shims. Extra args are additional build.mjs target
# names. Secrets: none — builds are keyless.
set -eu
# Shared infra arrives through one injectable directory (docs/d082): default
# the repo's ../lib.
lib_dir="${LIB_DIR:-$(dirname "$0")/../lib}"
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$lib_dir/node-run.sh"
node_run "$(dirname "$0")/../build.mjs" llama-swap-image "$@"
