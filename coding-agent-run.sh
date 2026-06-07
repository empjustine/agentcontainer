#!/bin/sh

workspace="$(pwd)"

if [ "$workspace" = "$HOME" ]; then
	>&2 printf "fatal: can't protect HOME"
	exit 90
fi

if [ -x /usr/bin/podman ]; then
	_container_tool='podman'
elif [ -x /usr/bin/docker ]; then
	_container_tool='docker'
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi

tag='localhost/empjustine/coding-agent:latest'
if ! "$_container_tool" image exists "$tag"; then
	>&2 printf "fatal: can't find container image"
	exit 92
fi

container_name="agentcontainer-$(date +'%Y-%m-%dT%H-%M-%S-%3N')"

mkdir -p -- "${HOME}/workspace/${container_name}/pi" "${HOME}/workspace/${container_name}/vibe"

cid="$("$_container_tool" container run -it --rm \
	-v "${workspace}:/workspace:z" \
	-v "${HOME}/workspace/${container_name}/pi:/root/.pi:Z" \
	-v "${HOME}/workspace/${container_name}/vibe:/root/.vibe:Z" \
	--network=host \
	--hostname "$container_name" \
	--workdir /workspace \
	--env-file ~/agentcontainer/-coding-agent.env \
	--detach \
	"$tag")"

"$_container_tool" container exec -it "$cid" mkdir -p /root/.pi/agent
~/agentcontainer/-openai-completions-models.sh | "$_container_tool" container exec -it "$cid" tee /root/.pi/agent/models.json

echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-llamacpp.env" -it "$cid" LITTLE_CODER_PERMISSION_MODE=accept-all little-coder
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-llamacpp.env" -it "$cid" pi
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-mistral.env" -it "$cid" vibe --agent auto-approve
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-opencode.env" -it "$cid" pi
echo "$_container_tool" container exec --env-file "~/agentcontainer/-coding-agent-api-openrouter.env" -it "$cid" pi

"$_container_tool" container attach "$cid"
