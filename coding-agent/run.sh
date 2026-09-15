#!/bin/sh
# `run.sh` — unified coding-agent launcher (container hosts AND Termux).
#
# The environment is loaded EXPLICITLY, before this script runs:
#
#   ./lib/environment.sh ./coding-agent/run.sh
#
# That chain (lib/environment.sh — the ONE infisical round-trip, on the host,
# outside any sandbox) injects the vault into plain environment variables;
# this script consumes env only — it never loads, fetches or caches secrets
# itself, and the host login state never leaves the host.
#
# RUNNERS NEVER BUILD OR GENERATE (docs/d041): stale/missing generation is a
# USER ISSUE. This launcher stages the COMMITTED config (settings.json,
# models.json, opencode.jsonc — refreshed by ./generate.sh or the root
# ./generate.sh, which forward the vault env themselves) and serves it; a
# missing artifact is a loud failure pointing at the generator, never an
# implicit regeneration.
#
#   container branch (podman/docker, via ../lib/workload-runtime.sh):
#     - stage a per-run sandbox dir (agent + opencode config/data)
#     - ro-mount the committed config AND the generator tree (an in-container
#       session can still regenerate manually via the /opt/coding-agent
#       generate.sh shim — the runner itself never invokes it)
#     - forward the (already-loaded) vault env through the workload_env
#       allowlist; the spawn chain inside the container is plain interactive
#       bash with no infisical at all
#   Termux branch (PREFIX under /data/data/com.termux):
#     - no container, no mise; the same explicit chain supplies the env
#     - exec pi directly against $PI_CODING_AGENT_DIR (the generator's install
#       target — same var, so they can't diverge)
#
# Env overrides:
#   PI_CODING_AGENT_DIR  Termux agent dir (default $HOME/.pi/agent) — also the
#                    var pi itself reads, so the generator's install target
#                    and pi's config source are the same path by construction
#   PEER_BASE_URL    relay — vault-sourced via the lib/environment.sh chain
#                    (consumed by the GENERATOR, never read by pi itself)
#   CODING_AGENT_REFERENCES  1 = also ro-mount ~/Downloads/references (the
#                    optional upstream-reference mirror). OFF by default: the
#                    tree is ~1.6M files, and podman's z,U mount options walk
#                    and relabel ALL of it on every launch — tens of seconds of
#                    silent startup cost for a non-canonical convenience cache.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # loaded for log_* (and lib/workload-runtime.sh below)
. "$SCRIPT_DIR/../lib/log.sh"
LOG_TOOL='coding-agent/run'
export LOG_TOOL

# --- workspace: optional first argument -------------------------------------
workspace="$(pwd)"
if [ "${1:-}" != "" ] && [ -d "$1" ]; then
	workspace="$(cd "$1" && pwd)"
	shift
fi

case "${PREFIX:-}" in
	*/com.termux/*) _termux=1 ;;
	*) _termux=0 ;;
esac

if [ "$_termux" = 1 ]; then
	# ----------------------------- Termux -----------------------------------
	# pi's own env var, honoured directly: the generator (same var) and pi
	# always target the same dir. The old AGENT_DIR alias was a second name
	# for this that could silently disagree with what pi reads.
	PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
	export PI_CODING_AGENT_DIR

	# models.json carries "$VAR" references that pi resolves from its own
	# environment at request time, so the secrets must be in this shell's env.
	# They arrive via the explicit chain (./lib/environment.sh ./run.sh) —
	# this script consumes plain env and never loads anything itself. No .env
	# file is ever read; a missing var stays missing (pi/generators skip).
	:

	mkdir -p "$PI_CODING_AGENT_DIR"
	# Runners never generate (docs/d041): a missing artifact is a user issue,
	# not something to fix implicitly.
	[ -f "$PI_CODING_AGENT_DIR/models.json" ] ||
		log_die 94 "no models.json in agent dir — run ./generate.sh first" \
			agentDir="$PI_CODING_AGENT_DIR"
	[ -n "${PEER_BASE_URL:-}" ] &&
		log_info "PEER_BASE_URL" value="$PEER_BASE_URL"

	log_info "launching pi" workspace="$workspace" agentDir="$PI_CODING_AGENT_DIR"
	cd "$workspace"
	exec pi "$@"
fi

# -------------------------- container branch --------------------------------
# shellcheck disable=SC1091
. "$SCRIPT_DIR/../lib/workload-runtime.sh"

USER="${USER:-$(id -un)}"
export USER

if [ "$workspace" = "$HOME" ]; then
	log_die 90 "refusing to run from HOME (workspace must not be HOME)"
fi

container_name="agentcontainer-$(date +'%Y%m%d%H%M%S%3N')"
workload_stage="$HOME/workspace/$container_name"
agent_dir="$workload_stage/pi/agent"
opencode_cfg_dir="$workload_stage/opencode/config"
opencode_data_dir="$workload_stage/opencode/data"
cline_dir="$workload_stage/cline"
thinkrail_dir="$workload_stage/thinkrail"

mkdir -p -- "$agent_dir" "$opencode_cfg_dir" "$opencode_data_dir" "$cline_dir" \
	"$thinkrail_dir"

# Secrets are NOT staged into the sandbox: the host loads them ONCE via the
# explicit chain (./lib/environment.sh ./run.sh — the one infisical
# round-trip, outside the sandbox) and the resulting plain environment is
# forwarded through the workload_env allowlist below, so no infisical runs
# inside the container and the host's ~/.infisical login state never leaves
# the host.
#
# The committed config IS the runtime config (docs/d041): the generator tree
# (below) is mounted read-only for MANUAL in-container regeneration, but the
# runner never invokes it. Missing committed artifacts are a user issue —
# loud failure pointing at the generator, never an implicit regeneration.
[ -f "$SCRIPT_DIR/settings.json" ] ||
	log_die 94 "settings.json missing — the committed config is the runtime config; run ./generate.sh first" path="$SCRIPT_DIR/settings.json"
[ -f "$SCRIPT_DIR/models.json" ] ||
	log_die 94 "models.json missing — run ./generate.sh first (or the root ./generate.sh)" path="$SCRIPT_DIR/models.json"
cp "$SCRIPT_DIR/settings.json" "$agent_dir/settings.json"
cp "$SCRIPT_DIR/models.json" "$agent_dir/models.json"
[ -f "$SCRIPT_DIR/opencode.jsonc" ] &&
	cp "$SCRIPT_DIR/opencode.jsonc" "$opencode_cfg_dir/opencode.json"

# Generator tree, read-only (never mount the whole dir: it also carries
# host-local, untracked files). Mounted for MANUAL in-container regeneration
# via the generate.sh shim (the runner itself never invokes it — docs/d041):
# generate.mjs stages the module list below from this ro-mount into its
# scratch dir, so every module it spawns must be in this list. The generators
# are now ONE PER CODING AGENT (generate-pi-coding-agent.mjs and
# generate-opencode.mjs) — the former per-stage pi generators were merged
# into the pi one, so this list must not reintroduce them.
# check-node-version stays unmounted — the version gate is Termux-only and
# runs from the repo dir, and the orchestrator counts providers inline now
# (the former count-providers/list-providers helpers were pruned with their
# shell caller — docs/d041).
_gen_target='/opt/coding-agent'
for _f in generate.sh generate.mjs gen-lib.mjs \
	generate-pi-coding-agent.mjs generate-opencode.mjs \
	settings.json; do
	workload_ro "$SCRIPT_DIR/$_f" "$_gen_target/$_f"
done
# Committed fallbacks generate.sh installs when the cascade comes up empty or
# SKIP_GEN=1 (ro_if: optional by definition).
workload_ro_if "$SCRIPT_DIR/models.json" "$_gen_target/models.json"
workload_ro_if "$SCRIPT_DIR/opencode.jsonc" "$_gen_target/opencode.jsonc"
workload_ro "$REPO_ROOT/lib/workload-runtime.sh" '/opt/lib/workload-runtime.sh'
workload_ro "$REPO_ROOT/lib/log.sh" '/opt/lib/log.sh'
# node-run.sh: the generate.sh shim sources it to resolve the pinned node
# (docs/d041) — required for manual in-container regeneration.
workload_ro "$REPO_ROOT/lib/node-run.sh" '/opt/lib/node-run.sh'
# Shared lib/ modules the generators import (docs/d023, docs/d024, d039):
# generate.sh stages log.mjs + artifact.mjs + cloud-providers.mjs into its
# scratch dir via $LIB_DIR — all must be mounted (artifact.mjs missing here
# once cost every generator an ERR_MODULE_NOT_FOUND in-container: the
# staging loop found nothing to copy, so each generator died and only the
# committed fallbacks survived).
workload_ro "$REPO_ROOT/lib/log.mjs" '/opt/lib/log.mjs'
workload_ro "$REPO_ROOT/lib/artifact.mjs" '/opt/lib/artifact.mjs'
workload_ro "$REPO_ROOT/lib/cloud-providers.mjs" '/opt/lib/cloud-providers.mjs'
# The single-consumer helper modules (docs/d039) live in coding-agent/ and
# ride the generator staging list into _gen_target.
workload_ro "$SCRIPT_DIR/peer-probe.mjs" "$_gen_target/peer-probe.mjs"
workload_ro "$SCRIPT_DIR/hyper-facts.mjs" "$_gen_target/hyper-facts.mjs"
workload_ro "$SCRIPT_DIR/catwalk-facts.mjs" "$_gen_target/catwalk-facts.mjs"
workload_ro "$SCRIPT_DIR/refresh-models-dev.mjs" "$_gen_target/refresh-models-dev.mjs"
# The shared vendored models.dev catalog (read-only in here; generate.sh's
# best-effort refresh falls back to a scratch copy when it is not writable).
workload_ro "$REPO_ROOT/lib/models.dev.api.json" '/opt/lib/models.dev.api.json'
# The hyper facts cache is its module's next-door neighbour (single consumer,
# docs/d039): ro here, staged writable by generate.sh's scratch loop.
workload_ro_if "$SCRIPT_DIR/hyper-facts.json" "$_gen_target/hyper-facts.json"
# The shared catwalk fallback catalog gets the same scratch-copy treatment as
# the hyper facts cache: ro here (the proxy generator reads it too, so it
# stays in lib/), staged writable by generate.sh.
workload_ro_if "$REPO_ROOT/lib/catwalk-facts.json" '/opt/lib/catwalk-facts.json'

# In-container launch chain: generated shell with no infisical — the host
# (lib/environment.sh, outside the sandbox) forwards the vault env through
# the workload_env allowlist instead.
cat >"$workload_stage/launch.sh" <<EOF
#!/bin/sh
# Generated by coding-agent/run.sh — in-container launch chain.
# The environment is ALREADY correct here: run.sh's host-side loader
# (lib/environment.sh) ran before the sandbox was built, and run.sh forwarded
# the vault keys through the workload_env allowlist.  No loader runs in here.
# shellcheck disable=SC1091
. /opt/lib/log.sh
LOG_TOOL='coding-agent/launch'
PI_CODING_AGENT_DIR="/home/${USER}/.pi/agent"
# Upstream's documented custom config directory (config.mdx): loaded after
# the global config so the peer overlay overrides it. The mounted config dir
# happens to be the same path as opencode's global default, so both tiers
# read the same files — idempotent, and the generate.sh shim targets the
# mount through this exact var.
OPENCODE_CONFIG_DIR="/home/${USER}/.config/opencode"
CLINE_DIR="/home/${USER}/.cline"
CLINE_DATA_DIR="/home/${USER}/.cline/data"
THINKRAIL_DATA_DIR="/home/${USER}/.thinkrail"
export PI_CODING_AGENT_DIR OPENCODE_CONFIG_DIR CLINE_DIR CLINE_DATA_DIR THINKRAIL_DATA_DIR

# NO generation here (docs/d041): the staged committed config is what pi
# starts with; an in-container session can regenerate manually via the
# /opt/coding-agent/generate.sh shim.
log_info "staged committed config; regenerate manually with /opt/coding-agent/generate.sh if needed" \
	agentDir="\$PI_CODING_AGENT_DIR"
log_info "launching interactive bash" agentDir="\$PI_CODING_AGENT_DIR"
exec bash
EOF
chmod 0755 "$workload_stage/launch.sh"
workload_ro "$workload_stage/launch.sh" '/opt/agentcontainer-launch.sh'

log_info "staged sandbox" container="$container_name" stage="$workload_stage"

HF_HUB_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/huggingface/hub"

workload_name     "$container_name"
workload_image    'localhost/empjustine/coding-agent:latest'
workload_interactive
workload_init
workload_network  host
workload_user
# Optional local mirror of upstream reference repos (read-only convenience
# cache; NOT canonical — the upstream repos are the source of truth).
#
# OFF BY DEFAULT (CODING_AGENT_REFERENCES=1 to enable): on a populated host
# this tree is hundreds of GB / >1M files, and every podman mount carries the
# `z,U` options (lib/workload-render.jq), which RECURSIVELY relabel+idmap the
# source on EACH launch. That walk is the single largest startup cost in this
# script — measuring ~39 s for a 1.66M-file mirror while the rest of the
# mounts (HF cache 823 files, workspace ~hundreds) are noise. The cache is not
# needed to run pi; enable it only for a session that reads the mirror.
if [ "${CODING_AGENT_REFERENCES:-0}" = 1 ]; then
	workload_ro_if "$HOME/Downloads/references" "$HOME/Downloads/references"
fi
#workload_ro_if    "$HF_HUB_CACHE" /home/${USER}/.cache/huggingface/hub
workload_rw       "$agent_dir" "/home/${USER}/.pi/agent"
workload_rw       "$HF_HUB_CACHE" "/home/${USER}/.cache/huggingface/hub"
workload_rw       "$opencode_cfg_dir" "/home/${USER}/.config/opencode"
workload_rw       "$opencode_data_dir" "/home/${USER}/.local/share/opencode"
workload_rw       "$cline_dir" "/home/${USER}/.cline"
workload_rw       "$thinkrail_dir" "/home/${USER}/.thinkrail"
workload_rw       "$workspace" "$workspace"
workload_workdir  "$workspace"
# Secrets! The host-side loader (lib/environment.sh — run.sh is exec'd through
# it) put the vault keys in THIS shell's environment; the allowlist below
# forwards them into the sandbox like the llm-local-inference run path (only
# non-empty values are forwarded).
workload_env_allowlist CLINE_API_KEY MISTRAL_API_KEY PEER_API_KEY \
	OPENROUTER_API_KEY OPENCODE_API_KEY HYPER_API_KEY INFERX_API_KEY \
	HF_TOKEN GEMINI_API_KEY NVIDIA_API_KEY PEER_BASE_URL
workload_cmd      /bin/sh /opt/agentcontainer-launch.sh
# Everything above this line is host-side argv assembly (jq + filesystem); the
# next call is where podman creates the container — mount relabel, userns
# setup and image probes all happen there with no output until the container's
# own launch.sh logs. This line brackets that gap for the log reader.
log_info "starting container" container="$container_name"
workload_run