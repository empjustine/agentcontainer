#!/bin/sh

HF_HOME="${XDG_CACHE_HOME:-${HOME}/.cache}/huggingface"
HF_HUB_CACHE="${HF_HOME}/hub"
LLAMA_CACHE="${HF_HOME}/hub"

container_image='ghcr.io/mostlygeek/llama-swap:unified-vulkan'
container_id='llama-swap-container'

. "$HOME/agentcontainer/container-tool.sh"

script_dir="$(cd "$(dirname "$0")" && pwd)"

"$_container_tool" container rm -f "$container_id"

set -- \
	--name="$container_id" \
	--init \
	--detach \
	--publish 8080:8080/tcp \
	--env-file "${script_dir}/.env"

for _node in /dev/kfd /dev/dri/renderD*; do
	[ -e "$_node" ] && set -- "$@" --device "$_node:$_node:rw"
done

set -- "$@" ${_userns} --user "$(id -u):$(id -g)" ${_keep_groups}

set -- "$@" \
	--volume "${script_dir}/config.d:/etc/llama-swap/config.d:z${_vol_u},ro" \
	--volume "${HF_HUB_CACHE}:/root/.cache/huggingface/hub:z${_vol_u}" \
	--volume "${HF_HUB_CACHE}:/home/ubuntu/.cache/huggingface/hub:z${_vol_u}" \
	--cap-drop=all \
	--security-opt no-new-privileges \
	--entrypoint llama-swap \
	"$container_image" \
	-config-dir /etc/llama-swap/config.d -listen 0.0.0.0:8080

"$_container_tool" container run "$@"

sleep 5

"$_container_tool" logs "$container_id" | head
