#!/bin/sh

set -x 

>&2 printf 'PEER_BASE_URL=%s\n' "${PEER_BASE_URL:-http://127.0.0.1:8080/v1}"

container_name="agentcontainer-$(date +'%Y%m%d%H%M%S%3N')"
tag='localhost/empjustine/coding-agent:latest'
workspace="$(pwd)"

if [ "$workspace" = "$HOME" ]; then
	>&2 printf "fatal: can't protect HOME"
	exit 90
fi

PI_CODING_AGENT_DIR="${HOME}/workspace/${container_name}/pi/agent"
mkdir -p -- "${PI_CODING_AGENT_DIR}"

cp ~/agentcontainer/coding-agent-peer/auth.json "${PI_CODING_AGENT_DIR}/auth.json"
cp ~/agentcontainer/coding-agent-peer/settings.json "${PI_CODING_AGENT_DIR}/settings.json"
jq --arg PEER_BASE_URL "${PEER_BASE_URL:-http://127.0.0.1:8080/v1}" \
   '{"providers": (with_entries(.value={"baseUrl": $PEER_BASE_URL}))}' \
   "${HOME}/agentcontainer/coding-agent/auth.json" >"${PI_CODING_AGENT_DIR}/models.json"

. "$HOME/agentcontainer/container-tool.sh"

"$_container_tool" container run -it --rm --init \
	${_userns} \
	--user "$(id -u):$(id -g)" \
	${_keep_groups} \
	-v "${workspace}:${workspace}:z${_vol_u}" --workdir "${workspace}" \
	-v "${PI_CODING_AGENT_DIR}:/home/dev/.pi/agent:Z${_vol_u}" \
	--env PI_CODING_AGENT_DIR=/home/dev/.pi/agent \
	-v "${HOME}/agentcontainer:/home/dev/agentcontainer:z,ro" \
	--network=host \
	--name "$container_name" --hostname "$container_name" \
	"$tag"
