#!/bin/sh

set -xe

BUILD_DATE="$(date +'%Y%m%d')"
containerfile="${HOME}/agentcontainer/huggingface/Containerfile"
context="$(dirname "$containerfile")"
# Tags for the date-stamped build (manual use)
tag="localhost/empjustine/huggingface-hub:${BUILD_DATE}"
latest_tag="localhost/empjustine/huggingface-hub:latest"
# Tag used by huggingface/precache.sh — kept in sync so a manual rebuild
# via this script also updates the image that precache.sh uses.
run_sh_tag="localhost/huggingface-downloader:latest"

if [ ! -f "$containerfile" ]; then
	>&2 printf "fatal: containerfile not found: %s\n" "$containerfile"
	exit 92
fi

if [ -x /usr/bin/podman ]; then
	podman image build --pull --build-arg "BUILD_DATE=${BUILD_DATE}" --tag "$tag" --tag "$latest_tag" --tag "$run_sh_tag" -f "$containerfile" "$context"
elif [ -x /usr/bin/docker ]; then
	docker buildx build --pull --build-arg "BUILD_DATE=${BUILD_DATE}" --tag "$tag" --tag "$latest_tag" --tag "$run_sh_tag" -f "$containerfile" "$context"
else
	>&2 printf "fatal: can't find container tool"
	exit 91
fi
