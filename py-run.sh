#!/bin/sh
# py-run.sh — run a python tool under the pinned uv, mirroring node-run.sh's
# shape (docs/d138: one root file owns the interpreter decision).
#
#   ./py-run.sh llm-local-inference/run.py
#   ./py-run.sh llm-local-inference/scan_cache_coverage.py --manifest ...
#
# No Termux branch (node-run.sh has one): an inference host carries the RAM
# and the GPU that Termux lacks, and this trampoline exists for the stack
# whose hosts all have them (docs/d170).
#
# WHY `--script` and not a project environment: uv materializes a project's
# environment at `<project>/.venv`, and the project a bare `uv run` discovers
# inside this tree is the repo's gate env — its .venv is gitignored but NOT
# pruned by ./lint.sh's biome leg, and the unit's own folder is not a uv
# project at all (d170 retires the per-unit pyproject). `--script` resolves
# each tool's PEP 723 block into uv's cache: the tree stays clean, the tool's
# own header is the single statement of its dependencies, and a tool copied
# out of the repo still runs alone (docs/d113).
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

# A script path is the whole contract: `--script` reads the tool's inline
# metadata, and arguments after it belong to the tool, not to uv.
case "${1:-}" in
*.py) ;;
*)
	echo "py-run.sh: usage: py-run.sh <script.py> [args...]" >&2
	exit 64
	;;
esac

cd "$repo_root"
script="$1"
shift
exec uv run --quiet --script "$script" "$@"
