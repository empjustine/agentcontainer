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
# Usage: ./check-types.sh [path]   (default: repo root)

set -eu

# shellcheck disable=SC1091
. "$(dirname "$0")/log.sh"
# shellcheck disable=SC1091
. "$(dirname "$0")/npm-tools.sh"
LOG_TOOL='check-types'
export LOG_TOOL

repo_root=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root="${1:-$repo_root}"
cd "$root"

npm_tools_ensure "$repo_root"
[ -x "$repo_root/node_modules/.bin/tsc" ] ||
	log_die 96 "tsc missing from the npm dev toolchain" path="$repo_root/node_modules"

log_info "tsc (checkJs, strict, incl. noUncheckedIndexedAccess)"
exec "$repo_root/node_modules/.bin/tsc" -p tsconfig.json
