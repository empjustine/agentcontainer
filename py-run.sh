#!/bin/sh
# py-run.sh — run a python tool under the pinned uv, mirroring node-run.sh's
# shape (docs/d138: one root file owns the interpreter decision).
#
#   ./py-run.sh llm-local-inference/run.py
#   ./py-run.sh llm-local-inference/upkeep.py --prune
#
# No Termux branch (node-run.sh has one): an inference host carries the RAM
# and the GPU that Termux lacks, and this trampoline exists for the stack
# whose hosts all have them (docs/d170 Decision 7).
#
# WHY a wrapper and not `uv run` shebangs: one root file owns the interpreter
# decision, so a missing uv is one loud death, not a per-file ENOEXEC.
#
# Secrets: callers reach this through the explicit chain
# (./environment.sh ./py-run.sh <script> — the ONE infisical round-trip); this
# file loads nothing itself.
set -eu

repo_root="$(CDPATH='' cd "$(dirname "$0")" && pwd)"

if ! command -v uv >/dev/null 2>&1; then
	echo "py-run.sh: uv not found (https://docs.astral.sh/uv/)" >&2
	exit 90
fi

cd "$repo_root"

# The unit's pyproject owns the dependency floor (d170 Decision 8), so the
# project is taken from the SCRIPT's directory — the caller may stand anywhere
# and the repo root may not carry the unit's deps.
case "$1" in
*/*.py)
	uv_dir="$(CDPATH='' cd "$(dirname "$1")" && pwd)"
	exec uv run --quiet --project "$uv_dir" "$@"
	;;
*)
	exec uv run --quiet "$@"
	;;
esac
