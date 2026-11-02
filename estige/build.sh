#!/bin/sh
# build.sh — interpreter shim (docs/d041, d083): estige's build lives in its
# own build.mjs (docs/d113 folded the root builder into the units), which
# builds the target THIS host can use — the image on a container host, the
# native binary otherwise. Extra args are build.mjs target names.
# Secrets: none — builds are keyless.
set -eu
# The node pin lives here, not in a root mise.toml (docs/d051/d082): system
# node on Termux (there is no mise there), `mise exec node@24` elsewhere.
node_run() {
	case "${PREFIX:-}" in
	*/com.termux/*) NODE_USE_ENV_PROXY=1 node "$@" ;;
	*) NODE_USE_ENV_PROXY=1 mise exec node@24 -- node "$@" ;;
	esac
}
node_run "$(dirname "$0")/build.mjs" "$@"
