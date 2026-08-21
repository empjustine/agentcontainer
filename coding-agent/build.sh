#!/bin/sh

set -xe

BUILD_DATE="$(date +'%Y%m%d')"
containerfile="${HOME}/agentcontainer/coding-agent/Containerfile"
build_context="$(dirname "$containerfile")"
latest_tag="localhost/empjustine/coding-agent:latest"
tag="localhost/empjustine/coding-agent:${BUILD_DATE}"

if [ -x /usr/bin/podman ]; then
	podman image build --pull \
	--build-arg BUILD_DATE="$BUILD_DATE" \
	--build-arg UID="$(id -u)" \
	--build-arg GID="$(id -g)" \
	--tag "$tag" --tag "$latest_tag" \
	"$build_context"
elif [ -x /usr/bin/docker ]; then
	docker buildx build --pull \
	--build-arg BUILD_DATE="$BUILD_DATE" \
	--build-arg UID="$(id -u)" \
	--build-arg GID="$(id -g)" \
	--tag "$tag" --tag "$latest_tag" \
	"$build_context"
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi
