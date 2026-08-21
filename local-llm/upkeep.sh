#!/bin/sh
# HuggingFace cache upkeep shim: list, prune, pull newer revisions, verify.
# Runs upkeep.py via uv (PEP 723 — no venv/huggingface_hub install needed).
# See docs/hf-cache-upkeep.md.

set -eu

here="$(CDPATH= cd "$(dirname "$0")" && pwd)"

if ! command -v uv >/dev/null 2>&1; then
	printf 'fatal: uv not found (https://docs.astral.sh/uv/)\n' >&2
	exit 90
fi

exec uv run --quiet "$here/upkeep.py" "$@"
