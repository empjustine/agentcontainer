#!/bin/sh

# Accept an optional PATH argument.  When given, pi processes that path
# instead of dropping to an interactive shell.
target_path="${1:-}"
shift 2>/dev/null || true

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

echo '{"retry":{"enabled":true,"maxRetries":9,"baseDelayMs":10000,"provider":{"timeoutMs":600000}},"editorPaddingX":0,"outputPad":0,"showCacheMissNotices":true,"terminal":{"showTerminalProgress":false}}' >"${HOME}/workspace/${container_name}/pi/agent/settings.json"
mise exec node@24 -- node --env-file ~/agentcontainer/coding-agent/.env "${HOME}/agentcontainer/provider-models/generate-pi-models.js" >"${HOME}/workspace/${container_name}/pi/agent/models.json"

"$_container_tool" container run -it --rm --init \
	-v "${references}/github:/references/github:z,ro" \
	-v "${references}/kiwix:/references/kiwix:z,ro" \
	-v "${workspace}:/workspace:z" --workdir /workspace \
	-v "${HOME}/workspace/${container_name}/pi:/root/.pi:Z" \
	-v "${HOME}/agentcontainer:/agentcontainer:ro" \
	--network=host \
	--name "$container_name" --hostname "$container_name" \
	--env-file ~/agentcontainer/coding-agent/.env \
	"$tag" \
	bash
