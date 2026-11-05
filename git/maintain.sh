#!/bin/sh
# maintain.sh — interpreter shim: run the repo-pinned node on the mirror
# maintenance. Usage lives in maintain-mirrors.mjs (--help) and
# non-bare-issues.md. No secrets and no container runtime are involved.
#
# The flock wrap is d099's maintenance surface: a hand-run sweep must queue
# behind an agent-driven compact_repo (and vice versa) so the farm never has
# two repacks or a fetch-beside-repack in flight — see farm-lock.sh.
set -eu
unit=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=${unit%/*}
# shellcheck source-path=SCRIPTDIR source=farm-lock.sh
. "$unit/farm-lock.sh"
with_farm_mutation_lock "$repo/node-run.sh" "$unit/maintain-mirrors.mjs" "$@"
