#!/bin/sh
# Type-check the JSDoc-typed scripts. The types themselves live in the code,
# next to the functions they describe (see tsconfig.json for the file list and
# the strictness) — this script only runs the checker.
#
# The checker is a root devDependency pinned by package-lock.json (docs/d107);
# ./npm-tools.sh installs it on demand. TypeScript is held at 6.0.3 on
# purpose: 7.x is the native compiler and publishes no android-arm64 binary,
# so it cannot run on Termux.
#
# Usage: ./check-types.sh   (from any directory)
#
# WHY there is no `[path]` argument (docs/d245): `tsc -p` checks the program
# tsconfig.json lists, so a swept directory could only ever have moved the cwd —
# and it did, aborting the config lookup with
# `TS5058: The specified path does not exist: 'tsconfig.json'`. The project is
# named absolutely instead, which is what makes the entry runnable from any
# directory, and an argument is a usage error rather than a silent no-op.

set -eu

# shellcheck source-path=SCRIPTDIR source=log.sh
. "$(dirname "$0")/log.sh"
# shellcheck source-path=SCRIPTDIR source=npm-tools.sh
. "$(dirname "$0")/npm-tools.sh"
LOG_TOOL='check-types'
export LOG_TOOL

repo_root=$(CDPATH='' cd "$(dirname "$0")" && pwd)

case "${1:-}" in
"") ;;
*)
	log_die 2 "check-types.sh takes no arguments" arg="$1" \
		hint="the program is tsconfig.json's file list; edit that rather than scoping this entry"
	;;
esac

npm_tools_ensure "$repo_root"
# The pi extension entries are IN tsconfig.json's program and resolve
# @earendil-works/pi-coding-agent from their own node_modules; without them tsc
# reports the missing modules. One store, one lockfile per folder (npm-tools.sh).
pnpm_tools_ensure "$repo_root"
[ -x "$repo_root/node_modules/.bin/tsc" ] ||
	log_die 96 "tsc missing from the npm dev toolchain" path="$repo_root/node_modules"

log_info "tsc (checkJs, strict, incl. noUncheckedIndexedAccess)"
exec "$repo_root/node_modules/.bin/tsc" -p "$repo_root/tsconfig.json"
