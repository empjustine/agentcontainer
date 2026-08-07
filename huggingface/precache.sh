#!/bin/sh

# Pre-cache model files via the huggingface downloader container.
#
# This populates models-local/ inside the HF cache tree so llama-server
# can use --model (fast) instead of --hf-repo (slow metadata resolution).
# Called by openai-completions/run.sh before config generation; can also
# be run standalone:
#
#   precache.sh [models-data.json]
#
# models-data.json defaults to
#   ${HOME}/agentcontainer/openai-completions/llamacpp-model-data.json

hf_dir="$(cd "$(dirname "$0")" && pwd)"

HF_HOME="${XDG_CACHE_HOME:-${HOME}/.cache}/huggingface"
HF_HUB_CACHE="${HF_HOME}/hub"
LLAMA_CACHE="${HF_HOME}/hub"
mkdir -p -- "$LLAMA_CACHE"

if [ -x /usr/bin/podman ]; then
	_container_tool='podman'
	_build_pull='--pull=newer'
elif [ -x /usr/bin/docker ]; then
	_container_tool='docker'
	_build_pull='--pull'
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi

_models_data="${1:-${HOME}/agentcontainer/openai-completions/llamacpp-model-data.json}"

_hf_image='localhost/huggingface-downloader:latest'
if [ -f "$hf_dir/Containerfile" ]; then
	>&2 printf "==> Building %s from %s...\n" "$_hf_image" "$hf_dir"
	$_container_tool build $_build_pull -t "$_hf_image" "$hf_dir" >/dev/null
	>&2 printf "==> Pre-caching models via %s...\n" "$_hf_image"
	$_container_tool run --rm \
		--volume "${HF_HUB_CACHE}:/root/.cache/huggingface/hub:z" \
		--volume "${_models_data}:/data/models.json:ro" \
		"$_hf_image" \
		/data/models.json 2>&1 | while IFS= read -r line; do
			>&2 printf "  %s\n" "$line"
		done
else
	>&2 printf "  (huggingface/Containerfile not found; models will be fetched by llama-server at startup)\n"
fi
