#!/bin/sh
# shellcheck disable=SC1091
. "$(dirname "$0")/../container-tool.sh"

# Multipurpose llama-swap config generator (single serving dir; see docs/d018
# for the merge contract and docs/environments-and-peer-variants.md for the
# environment matrix).  This is the openai-completions analog of
# coding-agent/generate.sh: generators emit LAYERS, and only the layers that
# work on the CURRENT host are generated/copied into config.d/ — a
# GPU-capable container host gets local inference + peers, everything else is
# peers-only by construction.  Stale layers from a previous capability set are
# removed so config.d/ always matches the host.
#
#   00-general.yaml              always  (globals + macros; harmless when no
#                                         local models reference them)
#   10-local-llm-inference.yaml  only when local inference is viable:
#                                container backend (podman/docker) AND GPU
#                                devices present (/dev/kfd, /dev/dri/renderD*)
#   launch-gguf.sh               copied alongside 10-… (static HF-snapshot
#                                resolver; not generated)
#   peer-cloud.yaml              whenever any cloud provider answers (the
#                                generator itself skips providers without
#                                keys / on fetch failure)
#   22-peer-gfx1030.yaml         only when NOT serving locally, and a gfx1030
#                                instance is reachable via the probe cascade
#                                (the generator keeps the existing file when
#                                nothing answers)

script_dir="$(cd "$(dirname "$0")" && pwd)"
config_d="$script_dir/config.d"
mkdir -p -- "$config_d"

# Best-effort atomic refresh of the vendored models.dev catalog (source of
# the opencode/opencode-go peer model lists): written to a temp file,
# validated, renamed — a failed fetch never touches the last good copy, so
# generation always proceeds (offline hosts keep the vendored catalog).
if ! mise exec node@24 -- node "$script_dir/refresh-models-dev.mjs" "$script_dir/models.dev.api.json"
then
	>&2 printf "warning: models.dev catalog refresh failed; using vendored copy\n"
fi

if ! infisical login --domain="$INFISICAL_API_URL" --log-level=info status; then
	exit 127
fi

_gen() {
	mise exec node@24 -- \
	infisical run --domain="$INFISICAL_API_URL" --projectId="$INFISICAL_PROJECT_ID" --log-level=info --env=prod --path=/inference -- \
	node "$script_dir/$1" || \
		>&2 printf "warning: %s failed; using existing config.d/ if present\n" "$1"
}

# 1. general layer: always.
_gen generate-general.yaml.js

# 2. local-inference layer: capability-gated.  Requires the container backend
#    (the unified-vulkan image runs llama.cpp against the GPU) and at least
#    one dedicated inference device.  detect_gpu_devs() is container-tool.sh's
#    own detector (the same one sandbox_gpu uses).
detect_gpu_devs
# shellcheck disable=SC2154  # _sandbox/_SB_DEV are set by the sourced container-tool.sh
if [ "$_sandbox" = 'container' ] && [ -n "$_SB_DEV" ]; then
	_gen generate-local-llm-models.yaml.js
	cp -- "$script_dir/launch-gguf.sh" "$config_d/launch-gguf.sh"
	local_layer=yes
else
	rm -f -- "$config_d/10-local-llm-inference.yaml" "$config_d/launch-gguf.sh"
	>&2 printf "note: no container backend + GPU devices — skipping local-inference layer (peers-only serving)\n"
fi

# 3. cloud-peers layer: every provider is fetched/skipped independently; the
#    generator writes nothing (and clears a stale output) when none answer.
_gen generate-peer-cloud.yaml.js

# 4. gfx1030 peer route: only where local models are NOT served natively —
#    a locally-capable host would just self-route.  The generator probes
#    $PEER_BASE_URL, then the bazzite tailscale URL (the world-visible FQDN
#    funnel of the LAN :8080 instance) and keeps the existing file when no
#    instance answers.
if [ "${local_layer:-}" = 'yes' ]; then
	rm -f -- "$config_d/22-peer-gfx1030.yaml"
else
	_gen generate-gfx1030-models.mjs
fi

echo "config.d/ generated in $config_d"
