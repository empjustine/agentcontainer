#!/bin/sh
# shellcheck disable=SC1091
. "$(dirname "$0")/../container-tool.sh"

# Multipurpose llama-swap launcher (single serving dir).  Image, GPU
# passthrough and HF cache adapt to what generate.sh put into config.d/ — the
# same "generate for this host, then launch" pattern as coding-agent/run.sh:
#
#   local layer present (10-local-llm-inference.yaml)
#     → unified-vulkan image, GPU passthrough, HF-cache mounts
#   peers-only
#     → lighter :cpu image, no GPU, no HF cache
#
# Port model (both modes): the instance publishes LAN port ${HOST_PORT:-8080}.
# The world reaches it through the tailscale FQDN reverse proxy (normal https
# port), which forwards to 8080.  The legacy local-inference port 18080 is
# DEPRECATED — the pre-squash two-instance split is gone, nothing listens on
# it, and code that still peers localhost:18080 must move to 8080.
# Secrets are injected by the Infisical wrapper in sandbox_run, never
# forwarded from the host env.

config_d="$SCRIPT_DIR/config.d"
if [ ! -d "$config_d" ]; then
	>&2 printf "fatal: config.d not found: %s\n" "$config_d"
	>&2 printf "  generate it first with ./generate.sh\n"
	exit 94
fi

HF_HUB_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/huggingface/hub"

if [ -f "$config_d/10-local-llm-inference.yaml" ]; then
	image='ghcr.io/mostlygeek/llama-swap:unified-vulkan'
	local_layer=yes
else
	image="${LLAMA_SWAP_IMAGE:-ghcr.io/mostlygeek/llama-swap:cpu}"
	local_layer=no
fi
host_port="${HOST_PORT:-8080}"
>&2 printf "serving mode: %s (image %s, LAN port %s)\n" \
	"$([ "$local_layer" = yes ] && printf 'local-inference+peers' || printf 'peers-only')" \
	"$image" "$host_port"

if ! infisical login --domain="$INFISICAL_API_URL" --log-level=info status; then
	exit 127
fi

container_id='llama-swap'
sandbox_rm "$container_id"

sandbox_name     "$container_id"
sandbox_image    "$image"
sandbox_detach
sandbox_init
sandbox_publish  "$host_port" 8080
sandbox_user
if [ "$local_layer" = yes ]; then
	sandbox_gpu
	sandbox_rw "$HF_HUB_CACHE" /root/.cache/huggingface/hub
	sandbox_rw "$HF_HUB_CACHE" /home/ubuntu/.cache/huggingface/hub
fi
sandbox_ro       "$config_d" /etc/llama-swap/config.d
sandbox_hardening
# HF_TOKEN is only consumed by the local layer (launch-gguf.sh download
# fallback); the provider keys are referenced by ${env.*} in peer-cloud.yaml.
# Unset vars are simply not exported by the infisical wrapper — no host-env
# forwarding, that would leak secrets out of the vault.
sandbox_env      HF_TOKEN
sandbox_env      OPENCODE_API_KEY
sandbox_env      OPENROUTER_API_KEY
sandbox_env      PEER_API_KEY
sandbox_entrypoint 'llama-swap'
sandbox_cmd      -config-dir /etc/llama-swap/config.d -listen 0.0.0.0:8080
sandbox_run infisical run --domain="$INFISICAL_API_URL" --projectId="$INFISICAL_PROJECT_ID" --log-level=info --env=prod --path=/inference --

sleep 5
sandbox_logs "$container_id" | head
