#!/bin/sh
# clean-venvs.sh — remove whole Python virtualenvs under a root.
# A venv is not source: pyproject/lockfiles rebuild it, and a venv from another
# Python version is a silent failure source.
set -eu
DIR=$(dirname "$0")
# shellcheck source-path=SCRIPTDIR/lib source=cleanup.sh
. "$DIR/lib/cleanup.sh"

usage() {
	cat <<EOF
usage: clean-venvs.sh [--apply] [root]
  remove virtualenvs (.venv, .venv.tmp, venv, .virtualenv, ENV).
  Default: dry-run. Recreate them with uv sync / python -m venv + pip install.
EOF
}

init_cleanup "virtualenvs" "$@"

find "$ROOT" \
	\( -name .git -o -name node_modules \) -prune -o \
	\( -name '.venv*' -o -name venv -o -name .virtualenv -o -name ENV \) \
	-type d -print -prune \
	>"$TMPF" 2>/dev/null || true

each_candidate
report
