#!/bin/sh

# container_image='ghcr.io/mostlygeek/llama-swap:rocm'
container_image='ghcr.io/mostlygeek/llama-swap:unified-vulkan'
container_id='llama-swap-container'

HF_HOME="${XDG_CACHE_HOME:-${HOME}/.cache}/huggingface"
HF_HUB_CACHE="${HF_HOME}/hub"
LLAMA_CACHE="${HF_HOME}/hub"
mkdir -p -- "$LLAMA_CACHE"

if [ -x /usr/bin/podman ]; then
	_container_tool='podman'
	_timeout='--time=30'
	_pull_mode='--pull=newer'
	_volume_rw_suffix=':z,U'
elif [ -x /usr/bin/docker ]; then
	_container_tool='docker'
	_timeout='--timeout=30'
	_pull_mode='--pull=always'
	_volume_rw_suffix=''
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi

# Pre-flight checks
_config_file="${HOME}/agentcontainer/openai-completions/config.yaml"
_env_file="${HOME}/agentcontainer/openai-completions/.env"
_generator="${HOME}/agentcontainer/coding-agent/provider-models/generate-pi-models.js"
_models_data="${HOME}/agentcontainer/openai-completions/llamacpp-model-data.json"

if [ ! -f "$_env_file" ]; then
	>&2 printf "fatal: env file not found: %s\n" "$_env_file"
	>&2 printf "  Copy from %s.example and fill in values.\n" "$_env_file"
	exit 92
fi
if [ ! -f "$_generator" ]; then
	>&2 printf "fatal: generator script not found: %s\n" "$_generator"
	exit 92
fi

# Pre-cache model files via the huggingface downloader container
# (build + run, in huggingface/precache.sh).  Populates models-local/
# inside the HF cache tree so llama-server can use --model (fast) instead
# of --hf-repo (slow metadata resolution).  Runs from a partial checkout
# skip silently — llama-server then fetches models at startup.
_precache="$(cd "$(dirname "$0")/.." && pwd)/huggingface/precache.sh"
if [ -x "$_precache" ]; then
	"$_precache" "$_models_data"
else
	>&2 printf "  (huggingface/precache.sh not found; models will be fetched by llama-server at startup)\n"
fi

# Generate llama-swap config from canonical model data + cloud providers.
>&2 printf "==> Generating llama-swap config...\n"
mise exec node@24 -- node --env-file "$_env_file" "$_generator" \
	--llama-swap-config "$_config_file" >/dev/null || {
	>&2 printf "warning: config generation failed; using existing config if present\n"
}

"$_container_tool" container stop "$_timeout" "$container_id"
"$_container_tool" container rm "$container_id"

# Build container run arguments
set -- \
	--name="$container_id" \
	--init \
	"$_pull_mode" \
	--detach \
	--publish 8080:8080/tcp \
	--env-file "$_env_file"

# Add GPU devices if available on the host
[ -e /dev/dri/renderD128 ] && set -- "$@" --device /dev/dri/renderD128:/dev/dri/renderD128:rw
[ -e /dev/kfd ]            && set -- "$@" --device /dev/kfd:/dev/kfd:rw

# keep-groups is Podman-only (rootless user namespace mapping)
[ "$_container_tool" = podman ] && set -- "$@" --group-add keep-groups

set -- "$@" \
	--volume "${HOME}/agentcontainer/openai-completions/config.yaml:/app/config.yaml${_volume_rw_suffix}" \
	--volume "${HOME}/agentcontainer/openai-completions/config.yaml:/etc/llama-swap/config/config.yaml${_volume_rw_suffix}" \
	--volume "${HF_HUB_CACHE}:/root/.cache/huggingface/hub${_volume_rw_suffix}" \
	--cap-drop=all \
	--security-opt no-new-privileges \
	"$container_image"

"$_container_tool" container run "$@"

"$_container_tool" logs "$container_id" | head
