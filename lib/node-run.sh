#!/bin/sh
# lib/node-run.sh — run node with the repo-pinned version, standalone.
#
# This is a general-purpose sh lib (docs/d041): any shell script — including
# ones that never touch the container API — sources just this file to get the
# repo's interpreter selection:
#
#   . "$(dirname "$0")/lib/node-run.sh"
#   node_run ./script.mjs [args...]
#
# System node on Termux (there is no mise there), `mise exec node@24`
# elsewhere (pinned via mise.toml / the image config).  The profile check is
# deliberately INSIDE the function: sourcing this file sets no globals, so it
# cannot collide with a host script's own variables or source order.
# Callers own the version-floor checks, which differ by product (>= 18 for
# the llm-local-inference generators' global fetch, >= 22.19 for
# pi-coding-agent's engines).
node_run() {
	case "${PREFIX:-}" in
	*/com.termux/*) node "$@" ;;
	*) mise exec node@24 -- node "$@" ;;
	esac
}
