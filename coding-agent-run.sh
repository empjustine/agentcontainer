#!/bin/sh

container_name="agentcontainer-$(date +'%Y%m%d%H%M%S%3N')"
tag='localhost/empjustine/coding-agent:latest'
workspace="$(pwd)"

if [ "$workspace" = "$HOME" ]; then
	>&2 printf "fatal: can't protect HOME"
	exit 90
fi

DOWNLOAD="$(xdg-user-dir DOWNLOAD)"
if [ -n "$DOWNLOAD" ]; then
	references="${DOWNLOAD}"
else
	references="${HOME}/Downloads"
fi

if [ -x /usr/bin/podman ]; then
	_container_tool='podman'
elif [ -x /usr/bin/docker ]; then
	_container_tool='docker'
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi

mkdir -p -- "${HOME}/workspace/${container_name}/pi/agent" "$references"

~/agentcontainer/-coding-agent-models.sh >"${HOME}/workspace/${container_name}/pi/agent/models.json"
echo '{"retry":{"enabled":true,"maxRetries":9,"baseDelayMs":10000}}' >"${HOME}/workspace/${container_name}/pi/agent/settings.json"

"$_container_tool" container run -it --rm --init \
	-v "${references}/github:/references/github:z,ro" \
	-v "${references}/kiwix:/references/kiwix:z,ro" \
	-v "${workspace}:/workspace:z" --workdir /workspace \
	-v "${HOME}/workspace/${container_name}/pi:/root/.pi:Z" \
	--network=host \
	--name "$container_name" --hostname "$container_name" \
	--detach \
	"$tag"

"$_container_tool" container exec -it "$container_name" mkdir -p /root/.pi/agent

echo "$_container_tool" container exec -it "$container_name" mise use --global npm:@earendil-works/pi-coding-agent@latest npm:little-coder@latest

# vibe --agent auto-approve
echo LITTLE_CODER_PERMISSION_MODE=accept-all little-coder
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-cloud.env" -it "$container_name" bash
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-llamacpp.env" -it "$container_name" bash
