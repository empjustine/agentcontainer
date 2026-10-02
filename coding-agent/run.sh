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
# never an implicit regeneration. The generator tree is deliberately NOT
# mounted (docs/d056): an in-container session cannot regenerate.
#
# ARGV: [DIRECTORY [DIRECTORY...]]
#   Each DIRECTORY is a host directory exposed INSIDE the container at its own
#   path, read-write. CWD is the implicit first DIRECTORY, so extra arguments
#   ADD mounts without restating the workdir; the first directory is also the
#   container workdir. `./run.sh ~/Downloads/references` is the whole
#   replacement for the retired CODING_AGENT_REFERENCES toggle (docs/d043,
#   docs/d056): the costly z,U relabel walk is paid only for a launch that
#   names the mirror. A DIRECTORY resolving to $HOME is refused — HOME is host
#   state and credentials, not a workspace. Termux has no mount boundary, so
#   there the directories are already visible and only the first (workdir)
#   changes anything.
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
#     - mount the committed opencode.jsonc and the generated host config only;
#       the ro generator tree that used to allow in-container regeneration is
#       gone (docs/d056), leaving just lib/log.sh for the launch chain
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

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # loaded for log_* (and lib/workload-runtime.sh below)
. "$SCRIPT_DIR/../lib/log.sh"
LOG_TOOL='coding-agent/run'
export LOG_TOOL

# --- directories: CWD implicit, extra args append ---------------------------
# Positional parameters are the directory list from here on: resolve every
# entry to an absolute path, refuse $HOME, and dedupe while preserving order.
# CWD is prepended, so it is simply the first list entry — there is no
# separate workspace argument (docs/d056).
_home="$(cd "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")"
_refuse_home() {
	[ "$1" != "$_home" ] ||
		log_die 90 "refusing to expose HOME as a DIRECTORY" dir="$1"
}

set -- "$(pwd -P)" "$@"
_dir_total=$#
_dir_processed=0
_dir_kept=0
while [ "$_dir_processed" -lt "$_dir_total" ]; do
	_dir_processed=$((_dir_processed + 1))
	_arg="$1"
	shift
	[ -d "$_arg" ] || log_die 90 "DIRECTORY is not a directory" dir="$_arg"
	_resolved="$(cd "$_arg" && pwd -P)" ||
		log_die 90 "cannot resolve DIRECTORY" dir="$_arg"
	_refuse_home "$_resolved"
	# The already-kept resolved entries are the LAST $_dir_kept positional
	# parameters; the first $#-$_dir_kept are unprocessed arguments. Only the
	# kept tail is a valid source for a duplicate (an unprocessed match is a
	# later first occurrence, which must survive).
	_dir_dup=0
	_dir_index=0
	for _seen in "$@"; do
		_dir_index=$((_dir_index + 1))
		[ "$_dir_index" -gt "$(($# - _dir_kept))" ] || continue
		if [ "$_seen" = "$_resolved" ]; then
			_dir_dup=1
			break
		fi
	done
	if [ "$_dir_dup" = 0 ]; then
		set -- "$@" "$_resolved"
		_dir_kept=$((_dir_kept + 1))
	fi
done
workdir="$1"

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

	log_info "launching pi" workspace="$workdir" agentDir="$PI_CODING_AGENT_DIR"
	cd "$workdir"
	exec pi
fi

# -------------------------- container branch --------------------------------
# shellcheck disable=SC1091
. "$SCRIPT_DIR/../lib/workload-runtime.sh"

USER="${USER:-$(id -un)}"
export USER

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

# The only lib/ file the sandbox needs at runtime is the launch chain's logger
# (the generator tree mount is gone with docs/d056). The generator writes the
# artifacts above on the host; the container consumes them.
workload_ro "$REPO_ROOT/lib/log.sh" '/opt/lib/log.sh'

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
# read the same files — idempotent.
OPENCODE_CONFIG_DIR="/home/${USER}/.config/opencode"
CLINE_DIR="/home/${USER}/.cline"
CLINE_DATA_DIR="/home/${USER}/.cline/data"
THINKRAIL_DATA_DIR="/home/${USER}/.thinkrail"
export PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR OPENCODE_CONFIG_DIR CLINE_DIR CLINE_DATA_DIR THINKRAIL_DATA_DIR

# NO generation here (docs/d041, docs/d056): the host agent dir is mounted
# as-is and regeneration happens on the host via ./generate.sh.
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
# The DIRECTORY arguments are the mount manifest (CWD first, extras appended);
# each is exposed at its own host path, rw, and the first is the workdir. This
# is where ~/Downloads/references rides now — the former
# CODING_AGENT_REFERENCES toggle is gone (docs/d056). Beware the cost the
# toggle used to hide: every mount carries podman's z,U (lib/workload-render.jq),
# which RECURSIVELY relabels+idmaps the source on each launch — ~39 s for that
# 1.66M-file mirror.
for _dir in "$@"; do
	workload_rw "$_dir" "$_dir"
done
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
workload_workdir  "$workdir"
# Secrets! The host-side loader (lib/environment.sh — run.sh is exec'd through
# it) put the vault keys in THIS shell's environment; the allowlist below
# forwards them into the sandbox like the llm-local-inference run path (only
# non-empty values are forwarded). PEER_BASE_URL / PEERS_ONLY are deliberately
# absent: only the generator consumed them, and the generator does not run in
# here (docs/d056).
workload_env_allowlist CLINE_API_KEY MISTRAL_API_KEY PEER_API_KEY \
	OPENROUTER_API_KEY OPENCODE_API_KEY HYPER_API_KEY INFERX_API_KEY \
	HF_TOKEN GEMINI_API_KEY NVIDIA_API_KEY
workload_cmd      /bin/sh /opt/agentcontainer-launch.sh
# Everything above this line is host-side argv assembly (jq + filesystem); the
# next call is where podman creates the container — mount relabel, userns
# setup and image probes all happen there with no output until the container's
# own launch.sh logs. This line brackets that gap for the log reader.
log_info "starting container" container="$container_name"
workload_run
