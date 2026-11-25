#!/bin/sh
# clean-js-builds.sh — remove JS/TS build and cache output under a root.
# dist/build/out are generic names and can be source in some repositories;
# the git guards are the reason this script is safe with a dry-run default.
set -eu
DIR=$(dirname "$0")
# shellcheck source-path=SCRIPTDIR/lib source=cleanup.sh
. "$DIR/lib/cleanup.sh"

usage() {
	cat <<EOF
usage: clean-js-builds.sh [--apply] [root]
  remove dist, build, out, .next, .nuxt, .output, .svelte-kit, .angular,
  .vite, .turbo, .cache, .parcel-cache, .swc, *.tsbuildinfo and .eslintcache.
  Default: dry-run; tracked paths are skipped.
EOF
}

init_cleanup "JS/TS build output" "$@"

find "$ROOT" \
	\( -name .git -o -name node_modules -o -name '.venv*' -o -name venv \
	-o -name site-packages \) -prune -o \
	\( -name dist -o -name build -o -name out -o -name .next -o -name .nuxt \
	-o -name .output -o -name .svelte-kit -o -name .angular -o -name .vite \
	-o -name .turbo -o -name .cache -o -name .parcel-cache -o -name .swc \) \
	-type d -print -prune -o \
	\( -name '*.tsbuildinfo' -o -name .eslintcache \) -type f -print \
	>"$TMPF" 2>/dev/null || true

each_candidate
report
