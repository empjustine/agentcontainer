#!/bin/sh
# generate.sh — interpreter shim (docs/d041): everything (source reads, merge,
# guards, artifact writes) lives in generate.mjs. Sources reach the provider
# through the reverse-proxy relay chain when REVERSE_PROXY_BASE_URLS is set
# (docs/d047/d063) and fall back to the vendored catalogs otherwise, so this
# needs no vault: run it through the explicit chain
# (./lib/environment.sh ./generate.sh) when a live relay base matters.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
node_run "$(dirname "$0")/generate.mjs" "$@"
