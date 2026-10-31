#!/bin/sh
# maintain.sh — interpreter shim: run the repo-pinned node on the mirror
# maintenance. Usage lives in maintain-mirrors.mjs (--help) and
# non-bare-issues.md. No secrets and no container runtime are involved.
#
# The flock wrap is d099's maintenance surface: a hand-run sweep must queue
# behind an agent-driven compact_repo (and vice versa) so the farm never has
# two repacks or a fetch-beside-repack in flight — see farm-lock.sh.
set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$(dirname "$0")/../lib/node-run.sh"
# shellcheck source-path=SCRIPTDIR source=farm-lock.sh
. "$(dirname "$0")/farm-lock.sh"
with_farm_mutation_lock node_run "$(dirname "$0")/maintain-mirrors.mjs" "$@"
