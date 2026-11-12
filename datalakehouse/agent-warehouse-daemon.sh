#!/bin/sh
# agent-warehouse-daemon.sh - the requested shell entry for the ingest route.
#
# WHY a shim and not a shell service (docs/d181): the route needs HTTP framing
# and an append-only write, which the pinned node already owns; the shell layer
# only execs that entry so the daemon starts the repo's way. The daemon body
# lives in the .mjs beside this file.
set -eu
unit=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(dirname "$unit")
exec "$repo/node-run.sh" "$unit/agent-warehouse-daemon.mjs" "$@"

