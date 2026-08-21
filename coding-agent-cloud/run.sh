#!/bin/sh

set -x

container_name="agentcontainer-$(date +'%Y%m%d%H%M%S%3N')"
tag='localhost/empjustine/coding-agent:latest'
workspace="$(pwd)"

if [ "$workspace" = "$HOME" ]; then
	>&2 printf "fatal: can't protect HOME"
	exit 90
fi

#references="$(xdg-user-dir DOWNLOAD)/references"
references="${HOME}/Downloads/references"

. "$HOME/agentcontainer/container-tool.sh"

HF_HOME="${XDG_CACHE_HOME:-${HOME}/.cache}/huggingface"
HF_HUB_CACHE="${HF_HOME}/hub"
PI_CODING_AGENT_DIR="${HOME}/workspace/${container_name}/pi/agent"
mkdir -p -- "${PI_CODING_AGENT_DIR}" "$references"

cp "${HOME}/agentcontainer/coding-agent/settings.json" "${PI_CODING_AGENT_DIR}/settings.json"
cp "${HOME}/agentcontainer/coding-agent/auth.json" "${PI_CODING_AGENT_DIR}/auth.json"

"$_container_tool" container run -it --rm --init \
	${_userns} \
	--user "$(id -u):$(id -g)" \
	${_keep_groups} \
	--env PI_CODING_AGENT_DIR=/home/dev/.pi/agent \
	-v "${PI_CODING_AGENT_DIR}:/home/dev/.pi/agent:Z${_vol_u}" \
	-v "${references}:${references}:z,ro${_vol_u}" \
	-v "${HF_HUB_CACHE}:/home/dev/.cache/huggingface/hub:z${_vol_u}" \
	-v "${workspace}:${workspace}:z${_vol_u}" \
	--workdir "${workspace}" \
	--network=host --name "$container_name" --hostname "$container_name" \
	"$tag" \
	bash
