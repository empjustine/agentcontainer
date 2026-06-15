#!/bin/sh

container_name="agentcontainer-$(date +'%Y-%m-%dT%H-%M-%S-%3N')"
tag='localhost/empjustine/coding-agent:latest'
workspace="$(pwd)"

if [ "$workspace" = "$HOME" ]; then
	>&2 printf "fatal: can't protect HOME"
	exit 90
fi

DOWNLOAD="$(xdg-user-dir DOWNLOAD)"
if [ -n "$DOWNLOAD" ]; then
	references="${DOWNLOAD}/github"
else
	references="${HOME}/Downloads/github"
fi

if [ -x /usr/bin/podman ]; then
	_container_tool='podman'
elif [ -x /usr/bin/docker ]; then
	_container_tool='docker'
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi

mkdir -p -- "${HOME}/workspace/${container_name}/pi/agent" "${HOME}/workspace/${container_name}/vibe" "$references"

~/agentcontainer/-coding-agent-models.sh >"${HOME}/workspace/${container_name}/pi/agent/models.json"
echo '{"retry":{"enabled":true,"maxRetries":7,"baseDelayMs":10000}}' >"${HOME}/workspace/${container_name}/pi/agent/settings.json"

"$_container_tool" container run -it --rm --init \
	-v "${references}:/references:z,ro" \
	-v "${workspace}:/workspace:z" --workdir /workspace \
	-v "${HOME}/workspace/${container_name}/pi:/root/.pi:Z" \
	-v "${HOME}/workspace/${container_name}/vibe:/root/.vibe:Z" \
	--network=host \
	--name "$container_name" --hostname "$container_name" \
	--env-file ~/agentcontainer/-coding-agent.env \
	--detach \
	"$tag"

"$_container_tool" container exec -it "$container_name" mkdir -p /root/.pi/agent

echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-llamacpp.env" -it "$container_name" env LITTLE_CODER_PERMISSION_MODE=accept-all little-coder
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-llamacpp.env" -it "$container_name" pi
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-mistral.env" -it "$container_name" vibe --agent auto-approve
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-opencode.env" -it "$container_name" pi
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-openrouter.env" -it "$container_name" pi

echo "$_container_tool" container attach "$container_name"
