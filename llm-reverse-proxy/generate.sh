#!/bin/sh
# generate.sh — emit llm-reverse-proxy.json, the routing table of the
# path-prefix cloud router (docs/d027).  RUN THIS after a provider change
# (lib/cloud-providers.mjs / the vendored models.dev catalog) or whenever
# the deployed config is missing.  Same invocation model as the other
# environments: ../coding-agent/generate.sh and ../llm-local-inference/
# generate.sh — the actual generator (generate-config.mjs) runs via node_run
# from ../lib/workload-runtime.sh, which picks the right interpreter per
# environment (system node on Termux, mise-pinned node@24 elsewhere).
#
# What it emits:
#   llm-reverse-proxy.json     one route per provider in the shared fact
#                              table — FULL real baseUrl (byte-for-byte
#                              passthrough, no keys) plus the loopback
#                              llama-swap local-peer route.
#
# Secrets: none at generation time — the proxy HOLDS no keys; requests must
# already carry valid provider credentials (forwarded untouched).  No
# vault round-trip, ever.  Generation is fully offline: it reads the
# vendored fact table (the models.dev drift check never blocks output).
#
# Env overrides (full reference in generate-config.mjs):
#   LIB_DIR              shared providers dir (default ../lib)
#   DRY_RUN              1 = do NOT replace llm-reverse-proxy.json — the
#                        generated routing table lands in
#                        llm-reverse-proxy.json.dry-run for inspection
#                        (repo-wide generator standard, lib/artifact.mjs)
#   LLAMA_SWAP_BASE_URL  loopback llama-swap upstream (default :8101)

set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/workload-runtime.sh  # node_run, log_**
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/generate'
export LOG_TOOL

script_dir="$(cd "$(dirname "$0")" && pwd)"

log_info "generating routing table" dir="$script_dir"
node_run "$script_dir/generate-config.mjs"

# --- verify + report ---------------------------------------------------------
if [ ! -f "$script_dir/llm-reverse-proxy.json" ]; then
	log_die 94 "routing table not generated" path="$script_dir/llm-reverse-proxy.json"
fi
log_info "routing table ready" path="$script_dir/llm-reverse-proxy.json"
