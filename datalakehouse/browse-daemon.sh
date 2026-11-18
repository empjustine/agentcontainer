#!/bin/sh
# browse-daemon.sh - the shell entry for the browsing endpoint.
#
# WHY a shim and not a shell service: the daemon needs HTTP framing, URL
# canonicalisation and SQLite, which the pinned python (via uv, py-run.sh) owns;
# this layer only execs that entry so the daemon starts the repo's way, exactly
# as agent-warehouse-daemon.sh does for the session route.
#
# Needs: ./py-run.sh (uv). The store and port are env, not flags, so an
# orchestration file holds one contract: BROWSE_ADDR, BROWSE_DB, BROWSE_TOKEN.
set -eu
unit=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(dirname "$unit")
exec "$repo/py-run.sh" "$unit/browse-daemon.py" "$@"
