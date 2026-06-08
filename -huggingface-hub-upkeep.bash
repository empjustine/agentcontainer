#!/bin/bash

set -xe

tag='localhost/empjustine/huggingface-hub:latest'

HF_HOME="${XDG_CACHE_HOME:-${HOME}/.cache}/huggingface"
HF_HUB_CACHE="${HF_HOME}/hub"

# podman run --rm -it --volume "${HF_HOME:-${XDG_CACHE_HOME:-${HOME}/.cache}/huggingface}:/root/.cache/huggingface:z,U" localhost/empjustine/huggingface-hub:latest sh

_hf() {
	podman run --rm -i --volume "${HF_HOME}:/root/.cache/huggingface:z,U" "$tag" hf "$@"
}

_hf cache ls --format json | jq -r '.[] | select(.repo_type=="model") | .repo_id'

_hf cache prune

for REPO_ID in "${HF_HUB_CACHE}/"*; do
	transformed="$(basename "$REPO_ID")"  # Remove the "$HF_HUB_CACHE" prefix
	transformed="${transformed#models--}" # Remove the 'models--' prefix
	transformed="${transformed//--/\/}"   # Replace '--' with '/'
	_hf cache verify --type model --fail-on-extra-files --format json "$transformed"
done
