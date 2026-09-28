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
# USER ISSUE. This launcher serves the generator's installed config (the host
# agent dir, mounted as-is) plus the committed opencode.jsonc — refreshed by
# ./generate.sh or the root ./generate.sh, which forward the vault env
# themselves. A missing artifact is a loud failure pointing at the generator,
# never an implicit regeneration.
#
#   container branch (podman/docker, via ../lib/workload-runtime.sh):
#     - rw-mount the HOST agent dir (PI_CODING_AGENT_DIR) directly — no per-run
#       config copy, so the generator's install target, the host pi, and the
#       sandboxed pi are one directory
#     - stage the pi session store (PI_CODING_AGENT_SESSION_DIR) under the
#       per-run host stage's pi/ — sessions are per-run audit state (docs/d026),
#       kept out of the shared config dir and off the host's own ~/.pi
#     - stage a per-run sandbox dir for the OTHER harnesses (opencode/cline/
#       thinkrail), which have no equivalent host-backed split
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
#   PI_CODING_AGENT_DIR  pi's agent/config dir (default $HOME/.pi/agent) —
#                    also the var pi itself reads, so the generator's install
#                    target and pi's config source are the same path by
#                    construction. The container branch mounts THIS HOST DIR
#                    rw, so config/skills persist across runs (docs/d054)
#   PI_CODING_AGENT_SESSION_DIR  pinned to the per-run stage by run.sh — NOT
#                    read from the host env, so a host pi that has it set can
#                    never make the sandbox share (merge into) the host's own
#                    session store. The name is still pi's own var, exported
#                    inside the container (docs/d054; diode target docs/d026)
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
# pi's own env vars name its two mounts. The agent dir is the HOST's real dir
# (mounted permanent RW): the generator installs the committed config into
# PI_CODING_AGENT_DIR, and the host pi and the sandboxed pi read that same
# directory — a per-run copy only adds a drift seam and leaves config garbage
# under ~/workspace. The session store stays under the per-run stage (pi/),
# named by PI_CODING_AGENT_SESSION_DIR: pi's NEWER session handling may write
# sessions straight into that dir rather than the old nested agent/sessions
# path, so the mount exists to capture them regardless — per-run audit state
# (docs/d026), not something to merge into the host config dir (docs/d054).
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
# Fixed, never taken from PI_CODING_AGENT_SESSION_DIR: unlike the agent dir
# (whose host env the generator also reads, so target and source agree by
# construction), a host-set session dir would silently point the mount at the
# host's own session store and merge the two. The var is set only inside the
# container, where pi reads it (docs/d054).
session_dir="$workload_stage/pi/sessions"
opencode_cfg_dir="$workload_stage/opencode/config"
opencode_data_dir="$workload_stage/opencode/data"
cline_dir="$workload_stage/cline"
thinkrail_dir="$workload_stage/thinkrail"

mkdir -p -- "$agent_dir" "$session_dir" "$opencode_cfg_dir" \
	"$opencode_data_dir" "$cline_dir" "$thinkrail_dir"

# auth.json must not carry CREDENTIALS. pi resolves the "$VAR" api-key
# references in models.json from the forwarded environment, so a populated
# credential store is dead state — but the agent dir is now mounted RW, and
# shipping it into the sandbox is exactly what docs/d052 removed. pi ITSELF
# materialises an EMPTY store ("{}") on startup, so existence alone proves
# nothing — only non-empty content is a credential (verified against pi
# 0.86.0: a bare `pi --list-models` writes "{}"), and only that aborts.
if [ -e "$agent_dir/auth.json" ]; then
	_auth_content="$(tr -d '[:space:]' <"$agent_dir/auth.json")" ||
		log_die 93 "cannot read auth.json in the agent dir" authFile="$agent_dir/auth.json"
	case "$_auth_content" in
	'' | '{}' | '[]') ;; # pi's empty store — not a credential
	*)
		log_die 93 "auth.json holds credentials in the agent dir — it is retired; keys resolve from the forwarded env. Remove it." \
			agentDir="$agent_dir" authFile="$agent_dir/auth.json"
		;;
	esac
fi

# Secrets are NOT staged into the sandbox: the host loads them ONCE via the
# explicit chain (./lib/environment.sh ./run.sh — the one infisical
# round-trip, outside the sandbox) and the resulting plain environment is
# forwarded through the workload_env allowlist below, so no infisical runs
# inside the container and the host's ~/.infisical login state never leaves
# the host.
#
# The runtime config is the generator's output installed into the host agent
# dir, which the sandbox mounts directly — so the committed config is still
# the runtime config, just not re-copied per run (docs/d054 refines d041(d)).
# Missing artifacts are a user issue: loud failure pointing at the generator,
# never an implicit regeneration.
[ -f "$agent_dir/settings.json" ] ||
	log_die 94 "no settings.json in the agent dir — run ./generate.sh first" agentDir="$agent_dir"
[ -f "$agent_dir/models.json" ] ||
	log_die 94 "no models.json in the agent dir — run ./generate.sh first (or the root ./generate.sh)" agentDir="$agent_dir"
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
# The orchestrator counts providers inline now (the former
# count-providers/list-providers helpers were pruned with their shell caller
# — docs/d041).
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
# Shared lib/ modules the generators import (docs/d023, docs/d024, d039,
# d050): generate.sh stages log.mjs + artifact.mjs + canonical-json.mjs +
# cloud-providers.mjs into its scratch dir via $LIB_DIR — all must be mounted
# (artifact.mjs missing here once cost every generator an
# ERR_MODULE_NOT_FOUND in-container: the staging loop found nothing to copy,
# so each generator died and only the committed fallbacks survived;
# canonical-json.mjs — artifact.mjs's own import — repeated the same failure
# on the host). tests/lib-staging.test.mjs guards both lists.
workload_ro "$REPO_ROOT/lib/log.mjs" '/opt/lib/log.mjs'
workload_ro "$REPO_ROOT/lib/artifact.mjs" '/opt/lib/artifact.mjs'
workload_ro "$REPO_ROOT/lib/canonical-json.mjs" '/opt/lib/canonical-json.mjs'
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
# The session store lives OUTSIDE the shared agent dir (docs/d054): it is the
# one session-shaped RW store the sandbox gets, named by pi's own env var
# (precedence: --session-dir > PI_CODING_AGENT_SESSION_DIR > settings.json).
PI_CODING_AGENT_SESSION_DIR="/home/${USER}/.pi/sessions"
# Upstream's documented custom config directory (config.mdx): loaded after
# the global config so the peer overlay overrides it. The mounted config dir
# happens to be the same path as opencode's global default, so both tiers
# read the same files — idempotent, and the generate.sh shim targets the
# mount through this exact var.
OPENCODE_CONFIG_DIR="/home/${USER}/.config/opencode"
CLINE_DIR="/home/${USER}/.cline"
CLINE_DATA_DIR="/home/${USER}/.cline/data"
THINKRAIL_DATA_DIR="/home/${USER}/.thinkrail"
export PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR OPENCODE_CONFIG_DIR CLINE_DIR CLINE_DATA_DIR THINKRAIL_DATA_DIR

# NO generation here (docs/d041): the host agent dir is mounted as-is; an
# in-container session can regenerate manually via the /opt/coding-agent/
# generate.sh shim, and the result lands back in that same host dir.
log_info "host agent dir mounted; regenerate manually with /opt/coding-agent/generate.sh if needed" \
	agentDir="\$PI_CODING_AGENT_DIR"
log_info "launching interactive bash" agentDir="\$PI_CODING_AGENT_DIR"
exec bash
EOF
chmod 0755 "$workload_stage/launch.sh"
workload_ro "$workload_stage/launch.sh" '/opt/agentcontainer-launch.sh'

log_info "staged sandbox" container="$container_name" stage="$workload_stage"

HF_HUB_CACHE="${HF_HUB_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/huggingface/hub}"

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
# pi's two env vars ARE the mount manifest (docs/d054): the host agent dir
# carries config/skills, and the per-run session stage carries the session
# JSONL the sandbox emits (the state docs/d026 wants to diode-ise).
workload_rw       "$agent_dir" "/home/${USER}/.pi/agent"
workload_rw       "$session_dir" "/home/${USER}/.pi/sessions"
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
	HF_TOKEN GEMINI_API_KEY NVIDIA_API_KEY PEER_BASE_URL PEERS_ONLY
workload_cmd      /bin/sh /opt/agentcontainer-launch.sh
# Everything above this line is host-side argv assembly (jq + filesystem); the
# next call is where podman creates the container — mount relabel, userns
# setup and image probes all happen there with no output until the container's
# own launch.sh logs. This line brackets that gap for the log reader.
log_info "starting container" container="$container_name"
workload_run