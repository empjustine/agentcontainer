#!/bin/sh
# build.sh — prepare llama-swap for THIS host (container hosts only): pre-pull
# the unified-vulkan image that run.sh will use.  The OCI workflow means there
# is nothing to compile.  Idempotent by design: a repeat run is a cheap no-op
# image pull (or a satisfied cache hit).
#
# Cloud/remote peer relaying is served by ../llm-reverse-proxy; this module
# only ever serves local GGUF inference, so only the GPU-capable image is
# pulled — no :cpu peers-only variant, no Termux native cross-build.

# shellcheck disable=SC1091
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='llm-local-inference/build'
export LOG_TOOL

set -eu

# shellcheck disable=SC2154  # _workload/_workload_tool are set by the sourced lib/workload-runtime.sh
[ "$_workload" = 'workload' ] || {
	log_die 91 "no container tool (podman/docker) — local inference requires the container backend"
}

image="${LLAMA_SWAP_IMAGE:-ghcr.io/mostlygeek/llama-swap:unified-vulkan}"
"$_workload_tool" image pull "$image"
log_info "pulled image; serve it with ./run.sh" image="$image"
