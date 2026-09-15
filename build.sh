#!/bin/sh
# build.sh — interpreter shim (docs/d041): build.mjs builds every target for
# THIS host (container images in parallel on container hosts; provisioning +
# the android binary serialized on Termux — see lib/provision-termux.sh, the
# former root build.sh, for the Termux-only environment plumbing).
set -eu
# shellcheck source-path=SCRIPTDIR source=lib/node-run.sh
. "$(dirname "$0")/lib/node-run.sh"
node_run "$(dirname "$0")/build.mjs" "$@"
