#!/bin/sh

# container_image='ghcr.io/mostlygeek/llama-swap:unified-rocm'
container_image='ghcr.io/mostlygeek/llama-swap:unified-vulkan'
container_id='llama-swap-container'
stop_time='30'

HF_HOME="${XDG_CACHE_HOME:-${HOME}/.cache}/huggingface"
HF_HUB_CACHE="${HF_HOME}/hub"
LLAMA_CACHE="${HF_HOME}/hub"

if [ -x /usr/bin/podman ]; then
	_container_tool='podman'
elif [ -x /usr/bin/docker ]; then
	_container_tool='docker'
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi

mkdir -p -- "$LLAMA_CACHE"

if podman container exists "$container_id"; then
	podman container stop --time="$stop_time" "$container_id"
	podman container rm "$container_id"
fi

# /app/config.yaml
# /etc/llama-swap/config/config.yaml
podman container run \
	--name="$container_id" \
	--init \
	--pull=newer \
	--stop-timeout="${stop_time}" \
	--publish 8080:8080/tcp \
	--detach \
	--env-file ~/agentcontainer/-openai-completions.env \
	--device /dev/dri/renderD128:/dev/dri/renderD128:rw \
	--device /dev/kfd:/dev/kfd:rw \
	--group-add keep-groups \
	--volume "${HOME}/agentcontainer/-openai-completions-config.yaml:/etc/llama-swap/config/config.yaml:z,U" \
	--volume "${HF_HUB_CACHE}:/root/.cache/huggingface/hub:z,U" \
	--cap-drop=all \
	--privileged=false \
	--security-opt no-new-privileges \
	"$container_image"
