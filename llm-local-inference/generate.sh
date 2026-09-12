#!/bin/sh
# generate.sh — (re)generate the llama-swap config in config.d/ for LOCAL
# GGUF inference. RUN THIS after a models/args change (active-b.json,
# lib/llamacpp-model-data.json, llama-swap-core.json macros) or when a host's
# capabilities changed (GPU added/removed, container backend installed).
#
# Cloud/remote peer relaying is NOT generated here (nor anywhere): it is
# served by ../llm-reverse-proxy, the raw passthrough proxy. This module
# emits only what serves local llama.cpp GGUFs.
#
# Layers emitted:
#   00-general.yaml              always  (globals + macros)
#   10-local-llm-inference.yaml  only when local inference is viable (container
#                                backend AND GPU devices), or LOCAL_INFERENCE=1
#                                to force (emits container-side paths — parity/
#                                debug only)
#   launch-gguf.sh               copied alongside 10-... (static HF-snapshot
#                                resolver; not generated)
#
# Merge contract for the fragments (llama-swap's -config-dir loader;
# docs/d018): identity-keyed maps merge additively and a duplicate key across
# files is a hard error, while `apiKeys` concatenates and macros/scalars must
# be single-defined — hence each generator owns a disjoint key set and
# 00-general.yaml is the only home of the globals.
#
# Secrets: none at generation time. This module's generation is fully offline
# (vendored tables only) and embeds NO keys — the single ${env.*} reference in
# the generated config (PEER_API_KEY, 00-general.yaml apiKeys) is resolved by
# llama-swap from ITS OWN environment at load time, which run.sh receives from
# the explicit chain (./lib/environment.sh ./run.sh). So generation needs no
# vault round-trip at all.
#
# Env overrides:
#   DRY_RUN           1 = generators do NOT replace the config.d layers —
#                       each write lands in a sibling <name>.dry-run preview
#                       for inspection (repo-wide generator standard,
#                       lib/artifact.mjs)
#   LOCAL_INFERENCE   1 = force the local-inference layer regardless of the
#                       capability gate (emits container-side paths; debug)

set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/workload-runtime.sh  # node_run, log_**
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='llm-local-inference/generate'
export LOG_TOOL

script_dir="$(cd "$(dirname "$0")" && pwd)"
config_d="$script_dir/config.d"
LOCAL_INFERENCE="${LOCAL_INFERENCE:-0}"

mkdir -p -- "$config_d"

log_info "generating config.d" dir="$config_d"
_gen_failed=''

# --- 1. general layer: always ----------------------------------------------
if ! node_run "$script_dir/generate-general.yaml.mjs"; then
	log_die 94 "general layer generation failed"
fi

# --- 2. local-inference layer: capability-gated -----------------------------
# Requires the container backend (the unified-vulkan image runs llama.cpp
# against the GPU) and at least one dedicated inference device
# (detect_gpu_devs).  LOCAL_INFERENCE=1 forces the layer regardless (it emits
# container-side /root/.cache paths — parity/debug only).
detect_gpu_devs
# shellcheck disable=SC2154  # _workload is set by the sourced lib/workload-runtime.sh
# `workload_has devices` — not a peek at an internal: the devices live in the
# JSON description, and this is the documented way to ask about them.
if [ "$LOCAL_INFERENCE" = 1 ] || { [ "$_workload" = 'workload' ] && workload_has devices; }; then
	if ! node_run "$script_dir/generate-local-llm-models.yaml.mjs"; then
		log_die 94 "local-inference layer generation failed"
	fi
	[ -f "$script_dir/launch-gguf.sh" ] &&
		cp -- "$script_dir/launch-gguf.sh" "$config_d/launch-gguf.sh"
	log_info "local-inference layer generated"
else
	rm -f -- "$config_d/10-local-llm-inference.yaml" "$config_d/launch-gguf.sh"
	log_die 94 "no container backend + GPU devices — this host cannot serve local inference (LOCAL_INFERENCE=1 forces generation for debug)"
fi

# --- verify + report --------------------------------------------------------
if [ ! -d "$config_d" ]; then
	log_die 94 "config.d not generated" dir="$config_d"
fi
log_info "config.d ready" dir="$config_d"
ls -- "$config_d"
