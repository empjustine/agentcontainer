#!/bin/sh

reference_volume_prefix="/mnt/c/reference"
permanent_volume_prefix="${HOME}/workspace"
container_name="agentcontainer-$(date +'%Y-%m-%dT%H-%M-%S-%3N')"

mkdir -p -- \
"${permanent_volume_prefix}/${container_name}/workspace" \
"${permanent_volume_prefix}/${container_name}/.pi" \

podman run -it --rm \
  -v "${reference_volume_prefix}:/reference:z,ro" \
  -v "${permanent_volume_prefix}/${container_name}/workspace:/workspace:Z" \
  -v "${permanent_volume_prefix}/${container_name}/.pi:/root/.pi:Z" \
  --network=host \
  --hostname "$container_name" \
  --workdir /workspace \
  --env "OPENROUTER_API_KEY=dummy" \
  --env "OPENCODE_API_KEY=dummy" \
  'localhost/agentcontainer:latest'
