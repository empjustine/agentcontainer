#!/bin/sh

set -xe

BUILD_DATE="$(date +'%Y%m%d')"
containerfile="${HOME}/agentcontainer/huggingface/Containerfile"
context="$(dirname "$containerfile")"
latest_tag="localhost/empjustine/huggingface-hub:latest"
tag="localhost/empjustine/huggingface-hub:${BUILD_DATE}"

if [ ! -f "$containerfile" ]; then
	>&2 printf "fatal: containerfile not found: %s\n" "$containerfile"
	exit 92
fi

if [ -x /usr/bin/podman ]; then
	podman image build --pull --build-arg "BUILD_DATE=${BUILD_DATE}" --tag "$tag" --tag "$latest_tag" -f "$containerfile" "$context"
elif [ -x /usr/bin/docker ]; then
	docker buildx build --pull --build-arg "BUILD_DATE=${BUILD_DATE}" --tag "$tag" --tag "$latest_tag" -f "$containerfile" "$context"
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi
