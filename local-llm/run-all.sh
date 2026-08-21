#!/bin/sh
# Run the local-llm tooling pipeline in dependency order:
#
#   1. download_models.py         provision served GGUFs into the HF cache
#   2. upkeep.py                  refresh newer revisions, prune detached, verify
#   3. fetch_hf_manifests.py      refresh manifests + audit repo:quant mapping
#   4. fetch-model-cards.sh       refresh model-card mirrors
#
# Steps 1-2 are hard prerequisites for anything reading model files; steps
# 3-4 are mutually independent but ordered for a deterministic run. All
# python tools use PEP 723 inline metadata via `uv run` — no venv needed.
# See docs/hf-cache-upkeep.md. The GGUF size-estimation tools (layer cards,
# active params, VRAM fits) are archived in OLD/gguf-size-estimation/;
# their replacement is gdevenyi/huggingface-estimate (see
# docs/gguf-vram-fit-estimates.md).
#
# Usage: ./run-all.sh [step ...]        # subset by script name, default all

set -eu

here="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
cd "$here"

if ! command -v uv >/dev/null 2>&1; then
	printf 'fatal: uv not found (https://docs.astral.sh/uv/)\n' >&2
	exit 90
fi

run_uv() {
	step="$1"
	printf '\n=== %s ===\n' "$step"
	uv run --quiet "$step" || {
		printf 'fatal: %s failed\n' "$step" >&2
		exit $?
	}
}

if [ $# -eq 0 ]; then
	set -- \
		download_models.py \
		upkeep.py \
		fetch_hf_manifests.py \
		fetch-model-cards.sh
fi

for step in "$@"; do
	case "$step" in
	download_models.py | upkeep.py | fetch_hf_manifests.py)
		run_uv "$step"
		;;
	fetch-model-cards.sh)
		printf '\n=== %s ===\n' "$step"
		./"$step" || {
			printf 'fatal: %s failed\n' "$step" >&2
			exit $?
		}
		;;
	*)
		printf 'fatal: unknown step: %s\n' "$step" >&2
		exit 64
		;;
	esac
done

printf '\nall done\n'
