#!/data/data/com.termux/files/usr/bin/sh
# run-native.sh — the Termux / a50 (no-container) serve leaf.
#
# WHY A SEPARATE PATH: a phone/router under Termux cannot run the
# containerized llama-swap at all — there is no usable podman/docker for the
# amd64 container image, and no local llama.cpp inference is possible.  So
# this variant serves a NATIVE Android/arm64 llama-swap build (see build.sh)
# over a PEERS-ONLY config.d/: cloud providers proxied through llama-swap,
# never a local `models` section.
#
#   | Mode                | Local models             | Cloud peers | Used by                   |
#   |---------------------|--------------------------|-------------|---------------------------|
#   | peers-only (always) | ✗ (empty `models` map)   | ✓           | termux/a50, OCI free tier |
#
# Peers-only is BY CONSTRUCTION, not a flag: generate.sh detects no container
# backend and no GPU here, so the local-inference layer (the only thing that
# could emit `models`) is never generated — and a stale
# 10-local-llm-inference.yaml is removed if capabilities were lost.
#
# Complements run.sh (the containerized multipurpose instance): same
# config.d/, just executed by the native binary instead of a container.
# Prerequisites: build.sh first (the native binary), generate.sh first
# (config.d/) — both are checked below with actionable errors.
#
# This bare serve path replaced the retired PRoot sandbox: PRoot was dropped
# as a backend because ptrace path translation is not isolation (no kernel
# namespaces, no cgroups, no real root, no GPU passthrough, no read-only
# binds), and the native binary it wrapped talks to the network directly
# anyway.  Hosts needing stronger-than-container isolation: see
# docs/d020-libvirt-qemu-sandbox.md (assessed, not implemented).
#
# SECRETS: the native binary resolves the ${env.*} references in config.d/
# from its own process environment, so everything it needs must be exported
# before the exec below.  That comes from the shared load_secrets
# (lib/workload-runtime.sh): infisical first — on Termux via the
# ~/Infisical/cli/infisical build produced by the repo's root ./build.sh.
# No .env / ENV_FILE is ever read — that file-based fallback was removed.
# Environments that already exported the keys are left untouched (load_secrets
# short-circuits).  .env.example documents the key names (documentation only).
#
# ENV (serving config — provider keys are documented in gen-lib.mjs):
#   LISTEN            listen address (default :8080)
#   LLAMA_SWAP_BIN    native binary path (default
#                     $HOME/mostlygeek/llama-swap/llama-swap, i.e. what
#                     build.sh produces)
#
# NOT CONFIGURABLE: the build output, the source checkout and the config.d/
# location are fixed conventions derived from each script's own directory.
#
# Client auth is whatever 00-general.yaml's `apiKeys` references — today
# ${env.PEER_API_KEY} (see llama-swap-core.json); an unset ${env.*} aborts
# llama-swap's config load, so it must be exported here too.

script_dir="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # loads log.sh + load_secrets
. "$script_dir/../lib/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/run-native'
export LOG_TOOL
config_d="$script_dir/config.d"

load_secrets
log_info "secrets source" source="${SECRETS_SOURCE:-none}"

ip addr show dev wlan0 2>/dev/null || true

bin="${LLAMA_SWAP_BIN:-$HOME/mostlygeek/llama-swap/llama-swap}"
[ -d "$config_d" ] ||
	log_die 94 "config.d not found — generate it first with ./generate.sh" dir="$config_d"
[ -x "$bin" ] ||
	log_die 95 "llama-swap binary missing — run ./build.sh first" bin="$bin"
log_info "serving natively" configDir="$config_d" listen="${LISTEN:-:8080}" bin="$bin"
exec "$bin" -config-dir "$config_d" -listen "${LISTEN:-:8080}"
