#!/bin/sh
# clean-python.sh — remove Python byte-code and tool caches under a root.
# Caches inside venvs belong to the venv itself; node_modules is never source.
set -eu
DIR=$(dirname "$0")
# shellcheck source-path=SCRIPTDIR/lib source=cleanup.sh
. "$DIR/lib/cleanup.sh"

usage() {
	cat <<EOF
usage: clean-python.sh [--apply] [root]
  remove __pycache__, *.pyc/*.pyo, .pytest_cache, .ruff_cache and .mypy_cache
  outside venvs and node_modules. Default: dry-run.
EOF
}

init_cleanup "python caches" "$@"

find "$ROOT" \
	\( -name .git -o -name node_modules -o -name '.venv*' -o -name venv \
	-o -name .virtualenv -o -name site-packages \) -prune -o \
	\( -name __pycache__ -o -name .pytest_cache -o -name .ruff_cache \
	-o -name .mypy_cache \) -type d -print -prune -o \
	\( -name '*.pyc' -o -name '*.pyo' \) -type f -print \
	>"$TMPF" 2>/dev/null || true

each_candidate
report
