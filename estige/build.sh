#!/bin/sh
# build.sh — interpreter shim (docs/d041, d083): estige's build lives in its
# own build.mjs (docs/d104 folded the root builder into the units), which
# builds the target THIS host can use — the image on a container host, the
# native binary otherwise. Extra args are build.mjs target names.
# Secrets: none — builds are keyless.
set -eu
# shellcheck source-path=SCRIPTDIR source=lib/node-run.sh
. "$(dirname "$0")/lib/node-run.sh"
node_run "$(dirname "$0")/build.mjs" "$@"
