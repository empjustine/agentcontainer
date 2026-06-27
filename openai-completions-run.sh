#!/bin/sh

# container_image='ghcr.io/mostlygeek/llama-swap:rocm'
container_image='ghcr.io/mostlygeek/llama-swap:unified-vulkan'
container_id='llama-swap-container'

HF_HOME="${XDG_CACHE_HOME:-${HOME}/.cache}/huggingface"
HF_HUB_CACHE="${HF_HOME}/hub"
LLAMA_CACHE="${HF_HOME}/hub"

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

mkdir -p -- "$LLAMA_CACHE"

"$_container_tool" container stop "$_timeout" "$container_id"
"$_container_tool" container rm "$container_id"

#	--device /dev/dri/renderD128:/dev/dri/renderD128:rw \
#	--device /dev/kfd:/dev/kfd:rw
#	--group-add keep-groups \
# /app/config.yaml
# /etc/llama-swap/config/config.yaml
"$_container_tool" container run \
	--name="$container_id" \
	--init \
	"$_pull_mode" \
	--detach \
	--publish 8080:8080/tcp \
	--env-file ~/agentcontainer/-openai-completions.env \
	--device /dev/dri/renderD128:/dev/dri/renderD128:rw \
	--device /dev/kfd:/dev/kfd:rw \
	--group-add keep-groups \
	--volume "${HOME}/agentcontainer/-openai-completions-config.yaml:/app/config.yaml${_volume_rw_suffix}" \
	--volume "${HOME}/agentcontainer/-openai-completions-config.yaml:/etc/llama-swap/config/config.yaml${_volume_rw_suffix}" \
	--volume "${HF_HUB_CACHE}:/root/.cache/huggingface/hub${_volume_rw_suffix}" \
	--cap-drop=all \
	--privileged=false \
	--security-opt no-new-privileges \
	"$container_image"

"$_container_tool" logs "$container_id" | head
