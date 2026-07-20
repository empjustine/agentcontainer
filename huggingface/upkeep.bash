#!/bin/sh

# Caller for the HuggingFace model-cache upkeep tool.
# Mirrors the container-tool detection / cache-mount pattern used by
# coding-agent/run.sh and openai-completions/run.sh.

tag='localhost/empjustine/huggingface-hub:latest'

HF_HOME="${XDG_CACHE_HOME:-${HOME}/.cache}/huggingface"
HF_HUB_CACHE="${HF_HOME}/hub"
XET_CACHE_PATH="${HF_HOME}/xet"

if [ -x /usr/bin/podman ]; then
	_container_tool='podman'
	_volume_rw_suffix=':z,U'
elif [ -x /usr/bin/docker ]; then
	_container_tool='docker'
	_volume_rw_suffix=''
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi

# The image is built locally (not pulled from a registry), so build it if missing.
if ! "$_container_tool" image exists "$tag" 2>/dev/null; then
	>&2 printf "image %s not found, building...\n" "$tag"
	if [ -x "${HOME}/agentcontainer/huggingface/build.sh" ]; then
		"${HOME}/agentcontainer/huggingface/build.sh"
	else
		>&2 printf "fatal: build script not found: %s\n" "${HOME}/agentcontainer/huggingface/build.sh"
		exit 93
	fi
fi

mkdir -p -- "$HF_HUB_CACHE" "$XET_CACHE_PATH"

# Build run arguments.
set -- \
	--rm --init \
	--volume "${HF_HUB_CACHE}:/root/.cache/huggingface/hub${_volume_rw_suffix}" \
	--volume "${XET_CACHE_PATH}:/root/.cache/huggingface/xet${_volume_rw_suffix}" \
	--env HF_HUB_CACHE=/root/.cache/huggingface/hub \
	--env XET_CACHE_PATH=/root/.cache/huggingface/xet

# Forward the host HF token for gated models, if set.
[ -n "$HF_TOKEN" ] && set -- "$@" --env "HF_TOKEN=${HF_TOKEN}"

"$_container_tool" container run "$@" "$tag"
