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
# Secrets (HF_TOKEN etc.) are loaded once via ../lib/workload-runtime.sh's
# load_secrets (infisical, or keys already in the environment — no .env file
# is read) — never fatal; gated/private repos simply skip auth when no token
# is available.
# See docs/hf-cache-upkeep.md. The GGUF size-estimation tools (layer cards,
# active params, VRAM fits) are archived in OLD/gguf-size-estimation/;
# their replacement is gdevenyi/huggingface-estimate (see
# docs/gguf-vram-fit-estimates.md).
#
# Usage: ./run-all.sh [step ...]        # subset by script name, default all

set -eu

here="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # loads log.sh + load_secrets
. "$here/../lib/workload-runtime.sh"
LOG_TOOL='local-llm/run-all'
export LOG_TOOL
cd "$here"
load_secrets
log_info "secrets source" source="${SECRETS_SOURCE:-none}"

if ! command -v uv >/dev/null 2>&1; then
	log_die 90 "uv not found (https://docs.astral.sh/uv/)"
fi

run_uv() {
	step="$1"
	log_info "step start" step="$step"
	uv run --quiet "$step" || {
		_rc=$?
		log_die "$_rc" "step failed" step="$step"
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
		log_info "step start" step="$step"
		./"$step" || {
			_rc=$?
			log_die "$_rc" "step failed" step="$step"
		}
		;;
	*)
		log_die 64 "unknown step" step="$step"
		;;
	esac
done

log_info "all done"
