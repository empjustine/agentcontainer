#!/bin/sh

set -xe

tag='localhost/empjustine/coding-agent:latest'
containerfile="${HOME}/agentcontainer/-coding-agent.Containerfile"

if [ -x /usr/bin/podman ]; then
	_container_tool='podman'
elif [ -x /usr/bin/docker ]; then
	_container_tool='docker'
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi

"$_container_tool" image build --pull=newer --tag "$tag" - <"$containerfile"
