#!/bin/sh
# `run.sh` — coding-agent launcher: ALWAYS the container sandbox (docs/d059).
# A host with no podman/docker has no sandbox to launch, so there is nothing
# here to fall back to — run pi itself under the same chain instead:
#   ./lib/environment.sh pi
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
# USER ISSUE. This launcher serves the generator's installed config — the
# host agent dir and the host opencode config dir, both mounted as-is —
# refreshed by ./generate.sh or the root ./generate.sh, which forward the
# vault env themselves. A missing pi artifact is a loud failure pointing at
# the generator, never an implicit regeneration; a missing opencode overlay
# is a TOLERATED partial config (docs/d065 — opencode runs on its
# built-ins). The generator tree is deliberately NOT mounted (docs/d056): an
# in-container session cannot regenerate.
#
# ARGV: [DIRECTORY [DIRECTORY...]]
#   Each DIRECTORY is a host directory exposed INSIDE the container at its own
#   path, read-write — a home-relative path at the CONTAINER's home spelling
#   (docs/d068), because a host home may sit behind a symlink. CWD is the
#   implicit first DIRECTORY, so extra arguments ADD mounts without
#   restating the workdir; the first directory is also the container
#   workdir. `./run.sh ~/Downloads/references` is the whole replacement for
#   the retired CODING_AGENT_REFERENCES toggle (docs/d043,
#   docs/d056): the costly z,U relabel walk is paid only for a launch that
#   names the mirror. A DIRECTORY resolving to $HOME is refused — HOME is host
#   state and credentials, not a workspace.
#
#   The launch (podman/docker required, via ../lib/workload-runtime.sh):
#     - rw-mount the HOST agent dir (PI_CODING_AGENT_DIR) directly — no per-run
#       config copy, so the generator's install target, the host pi, and the
#       sandboxed pi are one directory
#     - stage the pi session store (PI_CODING_AGENT_SESSION_DIR) under the
#       per-run host stage's pi/ — sessions are per-run audit state (docs/d026),
#       kept out of the shared config dir and off the host's own ~/.pi
#     - stage a per-run sandbox dir for the harness state that stays audit
#       trail, not config (opencode's data dir: logs + sessions; cline;
#       thinkrail)
#     - NO repo file rides along (docs/d067): the launch chain is
#       self-contained (env pins + exec bash) and logs nothing, so the
#       generator-tree mount (docs/d056) and the last lib/log.sh logger mount
#       are both gone
#     - the host HF cache is NOT mounted (docs/d066): the old binding was
#       unconditional and unguarded, and its relabel cost scaled with the
#       model store. A run that wants it names it as a DIRECTORY
#     - forward the (already-loaded) vault env through the workload_env
#       allowlist; the spawn chain inside the container is plain interactive
#       bash with no infisical at all
#
# There is deliberately no second (host-native) branch: without podman/docker
# run.sh refuses BEFORE staging anything and names the sandbox-free path above.
#
# Env overrides:
#   PI_CODING_AGENT_DIR  pi's agent/config dir (default $HOME/.pi/agent) —
#                    also the var pi itself reads, so the generator's install
#                    target and pi's config source are the same path by
#                    construction. run.sh mounts THIS HOST DIR
#                    rw, so config/skills persist across runs (docs/d054)
#   PI_CODING_AGENT_SESSION_DIR  pinned to the per-run stage by run.sh — NOT
#                    read from the host env, so a host pi that has it set can
#                    never make the sandbox share (merge into) the host's own
#                    session store. The name is still pi's own var, exported
#                    inside the container (docs/d054; diode target docs/d026)
#   OPENCODE_CONFIG_DIR  opencode's config dir (default
#                    ${XDG_CONFIG_HOME:-$HOME/.config}/opencode) — upstream's
#                    own knob, the generator's install target, and the var
#                    opencode reads inside the container. run.sh mounts THIS
#                    HOST DIR rw, so the generated overlay persists across
#                    runs (docs/d065); a missing opencode.json there is a
#                    tolerated partial config, not an abort

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
# Container-side spelling of a DIRECTORY (docs/d068). WHY the two sides are
# spelled differently: a host home can sit behind a symlink (Bazzite / Fedora
# Atomic: /home -> /var/home), so pwd -P spells every home-relative path
# /var/home/... while the image gives the user /home/$USER as ~. Mounting at
# the canonical path would park the directory exactly where a session does NOT
# look for it — and it would be the only mount in this file not spelled
# /home/$USER.
guest_path() {
	case $1 in
	"$_home"/*) printf '/home/%s%s' "$USER" "${1#"$_home"}" ;;
	*) printf '%s' "$1" ;;
	esac
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

# ------------------------- sandbox (the only path) ---------------------------
# shellcheck disable=SC1091
. "$SCRIPT_DIR/../lib/workload-runtime.sh"

# No backend, no staging: `_workload` is decided when the file above is
# sourced, whereas workload_run's own check would fire only AFTER the stage
# dir, launch chain and mount manifest were assembled. Refusing here leaves a
# backend-less host with nothing half-built and points it at the sandbox-free
# run path (docs/d059).
# shellcheck disable=SC2154  # assigned by workload-runtime.sh, whose $SCRIPT_DIR
# path shellcheck cannot resolve (the source line is SC1091-disabled for the
# same reason)
[ "$_workload" = 'workload' ] ||
	log_die 91 "no workload backend available (need podman or docker) — no sandbox here; run pi directly: ./lib/environment.sh pi"

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
# pi's agent-dir split, extended to opencode's CONFIG (docs/d065): the
# host's real config dir (the env override a host opencode also reads, else
# the XDG default) is mounted permanent RW — the generator's install target,
# the host opencode and the sandboxed opencode are one directory. opencode
# has no session-dir knob, so its DATA dir (auth.json + log/ + project/
# session storage — the long-term logs/sessions persistence) stays on the
# per-run stage: audit state (docs/d026), kept off the host's own
# ~/.local/share/opencode.
opencode_cfg_dir="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
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
# d070 §5: the installed file must be ROUTE-form — a provider URL carrying a
# fact-table upstream means pi would talk to upstream directly, bypassing
# the proxy this fleet routes through (docs/d063). generate verified this at
# install; re-check at launch because the agent dir is host state a stale or
# hand-edited copy can sit in, and the fix is always the same: regenerate.
# shellcheck source-path=SCRIPTDIR source=../lib/node-run.sh
. "$SCRIPT_DIR/../lib/node-run.sh"
if ! node_run "$SCRIPT_DIR/check-routed-artifacts.mjs" --installed "$agent_dir/models.json" >/dev/null; then
	log_die 94 "installed models.json carries canonical provider URLs — run ./generate.sh (docs/d070)" agentDir="$agent_dir"
fi
# mcp.json is required even though pi runs without it: "every environment has
# the committed servers" is the check's whole value, and the documented opt-out
# is `"enabled": false` on the entry (docs/d061), not a deleted file.
[ -f "$agent_dir/mcp.json" ] ||
	log_die 94 "no mcp.json in the agent dir — run ./generate.sh first (or the root ./generate.sh)" agentDir="$agent_dir"
# PARTIAL opencode config is ACCEPTED at launch (deliberately unlike pi's
# missing-artifact exit 94): opencode runs fine on its built-in providers, so
# a missing installed overlay only costs the provider reroute — warn and launch.
# SKIP_GEN (the committed-artifact install path) is retired with d070 §6: the
# overlay is a generate-time artifact, and regeneration is the only fix.
[ -f "$opencode_cfg_dir/opencode.json" ] ||
	log_warn "no opencode.json in the host config dir — opencode launches on built-in (partial) config; run ./generate.sh to install" \
		configDir="$opencode_cfg_dir"

# Nothing from the repo tree is mounted (docs/d067). The launch chain below
# is self-contained, and its one in-container log line is gone: the host-side
# "starting container" line is the launch marker, because attestation from
# inside the sandbox was worth less than the repo-tree bind it cost. The
# generator writes the artifacts above on the host; the container consumes
# them.

# In-container launch chain: generated shell with no infisical — the host
# (lib/environment.sh, outside the sandbox) forwards the vault env through
# the workload_env allowlist instead.
cat >"$workload_stage/launch.sh" <<EOF
#!/bin/sh
# Generated by coding-agent/run.sh — in-container launch chain.
# The environment is ALREADY correct here: run.sh's host-side loader
# (lib/environment.sh) ran before the sandbox was built, and run.sh forwarded
# the vault keys through the workload_env allowlist.  No loader runs in here.
PI_CODING_AGENT_DIR="/home/${USER}/.pi/agent"
# The session store lives OUTSIDE the shared agent dir (docs/d054): it is the
# one session-shaped RW store the sandbox gets, named by pi's own env var
# (precedence: --session-dir > PI_CODING_AGENT_SESSION_DIR > settings.json).
PI_CODING_AGENT_SESSION_DIR="/home/${USER}/.pi/sessions"
# Upstream's documented custom config directory (config.mdx): loaded after
# the global config so the provider overlay overrides it. It names the HOST
# config dir run.sh mounted (docs/d065) — the same path as opencode's own
# global default, so both tiers read the same files — idempotent.
OPENCODE_CONFIG_DIR="/home/${USER}/.config/opencode"
CLINE_DIR="/home/${USER}/.cline"
CLINE_DATA_DIR="/home/${USER}/.cline/data"
THINKRAIL_DATA_DIR="/home/${USER}/.thinkrail"
export PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR OPENCODE_CONFIG_DIR CLINE_DIR CLINE_DATA_DIR THINKRAIL_DATA_DIR

# NO generation here (docs/d041, docs/d056): the host agent dir is mounted
# as-is and regeneration happens on the host via ./generate.sh. No logger
# either (docs/d067) — this chain is self-contained, and nothing from the
# repo tree is bound for it.
exec bash
EOF
chmod 0755 "$workload_stage/launch.sh"
workload_ro "$workload_stage/launch.sh" '/opt/agentcontainer-launch.sh'

log_info "staged sandbox" container="$container_name" stage="$workload_stage"

workload_name     "$container_name"
workload_image    'localhost/empjustine/coding-agent:latest'
workload_interactive
workload_init
workload_network  host
workload_user
# workload_hardening() is deliberately NOT called (docs/d067): its
# --cap-drop=all --security-opt no-new-privileges pair makes the image's
# setuid sudo dead (NOPASSWD:ALL, Containerfile), which is how the agent
# installs a system package at runtime. The other two runners are
# single-purpose servers with no escalation hatch, and both harden.
# The DIRECTORY arguments are the mount manifest (CWD first, extras appended);
# each is exposed rw at its guest_path target, and the first is the
# workdir. This is where ~/Downloads/references rides now — the former
# CODING_AGENT_REFERENCES toggle is gone (docs/d056). Beware the cost the
# toggle used to hide: every mount carries podman's z,U (lib/workload-render.jq),
# which RECURSIVELY relabels+idmaps the source on each launch — ~39 s for that
# 1.66M-file mirror.
for _dir in "$@"; do
	workload_rw "$_dir" "$(guest_path "$_dir")"
done
# The host HF cache is deliberately NOT mounted (docs/d066). The binding
# this replaces was unconditional and existence-unguarded — workload_rw
# aborts the whole launch (exit 91) when the source dir is absent — while its
# z,U walk relabels the entire model store on every launch, the exact cost the
# ARGV manifest above exists to make opt-in. The image ships its own empty,
# ephemeral ~/.cache/huggingface/hub (Containerfile), so `hf` still works
# in-container; a launch that wants the warm host cache names it as a
# DIRECTORY argument — it lands at ~/.cache/huggingface/hub in the sandbox
# (docs/d068), the very path hf reads by default, so no in-container
# HF_HUB_CACHE override is needed to use it.
# pi's two env vars ARE the mount manifest (docs/d054): the host agent dir
# carries config/skills, and the per-run session stage carries the session
# JSONL the sandbox emits (the state docs/d026 wants to diode-ise).
workload_rw       "$agent_dir" "/home/${USER}/.pi/agent"
workload_rw       "$session_dir" "/home/${USER}/.pi/sessions"
# opencode's config dir joins the pi agent dir as a host-backed permanent
# mount (docs/d065); its data dir stays on the per-run stage (the
# long-term logs/sessions audit trail, docs/d026).
workload_rw       "$opencode_cfg_dir" "/home/${USER}/.config/opencode"
workload_rw       "$opencode_data_dir" "/home/${USER}/.local/share/opencode"
workload_rw       "$cline_dir" "/home/${USER}/.cline"
workload_rw       "$thinkrail_dir" "/home/${USER}/.thinkrail"
workload_workdir  "$(guest_path "$workdir")"
# Secrets! The host-side loader (lib/environment.sh — run.sh is exec'd through
# it) put the vault keys in THIS shell's environment; the allowlist below
# forwards them into the sandbox like the llm-local-inference run path (only
# non-empty values are forwarded). REVERSE_PROXY_BASE_URLS is deliberately
# absent: only the generator consumes it (generation and the install-time
# route substitution refuse without it, docs/d063/d070), and the generator
# does not run in here (docs/d056). PEERS_ONLY is retired with the
# direct-first cascade (docs/d063).
#
# This list is a FOURTH place a provider's key env name has to appear (the
# catalog `env`, lib/cloud-providers.mjs's apiKeyEnv, the pi generator spec's
# envKey, and here) — docs/d032 F6. The omission mode is silent and looks like
# a vault problem: an empty host var is dropped by workload_env_allowlist, so
# a key that IS in infisical never reaches the sandbox, and the generated
# models.json's "$<KEY>" reference resolves to nothing inside the container.
# Add the name here whenever a provider row lands in the fact table.
#
# The proxy vars are routing, not secrets (docs/d074): forwarded so the image's
# NODE_USE_ENV_PROXY=1 has something to honor — node's native fetch/http proxy
# support reads HTTP(S)_PROXY / NO_PROXY (upper- and lowercase) at startup.
workload_env_allowlist CLINE_API_KEY MISTRAL_API_KEY REVERSE_PROXY_API_KEY \
	OPENROUTER_API_KEY OPENCODE_API_KEY HYPER_API_KEY INFERX_API_KEY \
	VERBOO_API_KEY HF_TOKEN GEMINI_API_KEY NVIDIA_API_KEY \
	HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
workload_cmd      /bin/sh /opt/agentcontainer-launch.sh
# Everything above this line is host-side argv assembly (jq + filesystem); the
# next call is where podman creates the container — mount relabel, userns
# setup and image probes all happen there. Nothing logs from inside any more
# (docs/d067), so this line IS the launch marker: the next thing on the
# terminal is the sandbox's own bash prompt.
log_info "starting container" container="$container_name"
workload_run
