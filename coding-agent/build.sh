#!/bin/sh

set -xe

BUILD_DATE="$(date +'%Y%m%d')"
containerfile="${HOME}/agentcontainer/coding-agent/Containerfile"
latest_tag="localhost/empjustine/coding-agent:latest"
tag="localhost/empjustine/coding-agent:${BUILD_DATE}"

if [ -x /usr/bin/podman ]; then
	podman image build --pull --build-arg "BUILD_DATE=$(date +'%Y%m%d')" --tag "$tag" --tag "$latest_tag" - <"$containerfile"
elif [ -x /usr/bin/docker ]; then
	docker buildx build --pull --build-arg "BUILD_DATE=$(date +'%Y%m%d')" --tag "$tag" --tag "$latest_tag" - <"$containerfile"
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi
