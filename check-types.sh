#!/bin/sh
# Type-check the JSDoc-typed scripts. The types themselves live in the code,
# next to the functions they describe (see tsconfig.json for the file list and
# the strictness) — this script only provisions the checker and runs it.
#
# Tools are provisioned ad hoc: typescript + @types/node are npm-installed once
# per pinned set into a scratch dir outside the repo (the repo has no
# node_modules and is not gitignoring one, so installing in-tree would dirty
# every `git status`). Same approach as lint.sh: no pinned dev deps.
#
# Usage: ./check-types.sh [path]   (default: repo root)

set -eu

# shellcheck disable=SC1091
. "$(dirname "$0")/lib/log.sh"
LOG_TOOL='check-types'
export LOG_TOOL

root="${1:-$(CDPATH='' cd "$(dirname "$0")" && pwd)}"
cd "$root"

ts_pin='typescript@7.0.2'
node_types_pin='@types/node@24.19.2'
tsdir="${XDG_STATE_HOME:-$HOME/.local/state}/agentcontainer/check-types"
stamp="$tsdir/pins"

# The existence-only check used to keep a bumped pin from ever landing when the
# scratch dir already had a tsc; the stamp makes the installed set explicit.
if [ ! -x "$tsdir/node_modules/.bin/tsc" ] || [ "$(cat "$stamp" 2>/dev/null || :)" != "$ts_pin $node_types_pin" ]; then
	log_info "installing $ts_pin + $node_types_pin" path="$tsdir"
	mkdir -p "$tsdir"
	npm i --no-save --no-audit --no-fund --prefix "$tsdir" "$ts_pin" "$node_types_pin"
	printf '%s\n' "$ts_pin $node_types_pin" > "$stamp"
fi

log_info "tsc (checkJs, strict, incl. noUncheckedIndexedAccess)"
# --typeRoots is explicit because the types are not installed in-tree: tsc has
# to be told where the scratch-dir @types live.
exec "$tsdir/node_modules/.bin/tsc" -p tsconfig.json --typeRoots "$tsdir/node_modules/@types"
