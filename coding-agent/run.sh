#!/bin/sh
# `run.sh` — unified coding-agent launcher (container hosts AND Termux).
#
# Merges the former run.sh (container sandbox) and run-termux.sh (native pi).
# The container branch loads secrets ONCE on the HOST (load_secrets — one
# cached `infisical secrets --output=dotenv`) and forwards the vault keys
# through the workload_env allowlist; the spawn chain inside the container is
# plain generate.sh + interactive bash with no infisical at all (the host
# login state is NOT staged into the sandbox).
#
#   container branch (podman/docker, via ../lib/workload-runtime.sh):
#     - stage a per-run sandbox dir (agent + opencode config/data)
#     - ro-mount the generator scripts and a generated launch chain
#     - host-side load_secrets → workload_env forward of the vault keys;
#       in-container load_secrets short-circuits via SECRETS_ASSUME=1 (the
#       "emergency not-infisical loader", defined in lib/workload-runtime.sh)
#     - generate.sh then interactive bash; pi resolves "$VAR" refs in
#       models.json from the forwarded environment
#   Termux branch (PREFIX under /data/data/com.termux):
#     - no container, no mise; secrets via the shared load_secrets — the
#       Termux build of the infisical CLI ($HOME/Infisical/cli/infisical) is
#       tried first, and keys already exported into the environment are used
#       as-is; no .env file is ever read
#       (the CLI builds on Android with -checklinkname=0; see the repo root
#       ./build.sh, which is what produces it)
#     - GENERATE=1 ./run.sh regenerates first via ./generate.sh
#     - exec pi directly
#
# Env overrides:
#   AGENT_DIR        Termux agent dir (default $HOME/.pi/agent; exported as
#                    PI_CODING_AGENT_DIR, which pi reads instead of ~/.pi/agent)
#   GENERATE         Termux: 1 = run ./generate.sh first
#   PEER_BASE_URL    relay, printed for confirmation only (consumed by the
#                    generator, not by pi)
#   SKIP_GEN / MODELS_DEV_REFRESH
#                    forwarded into the container for the in-container
#                    generate.sh (set them in the host env before running)

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
	AGENT_DIR="${AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"

	if [ "${GENERATE:-0}" = 1 ]; then
		AGENT_DIR="$AGENT_DIR" \
			sh "$SCRIPT_DIR/generate.sh"
	fi

	# models.json carries "$VAR" references that pi resolves from its own
	# environment at request time, so the secrets must be exported here.
	# load_secrets: infisical via the Termux CLI build when available; keys
	# already in the environment short-circuit it.  No .env file is ever read.
	# shellcheck disable=SC1091  # loaded for load_secrets
	. "$SCRIPT_DIR/../lib/workload-runtime.sh"
	load_secrets
	log_info "secrets source" source="${SECRETS_SOURCE:-none}"

	mkdir -p "$AGENT_DIR"
	PI_CODING_AGENT_DIR="$AGENT_DIR"
	export PI_CODING_AGENT_DIR
	if [ ! -f "$AGENT_DIR/models.json" ]; then
		log_warn "no models.json in agent dir — run with GENERATE=1" \
			agentDir="$AGENT_DIR"
	fi
	[ -n "${PEER_BASE_URL:-}" ] &&
		log_info "PEER_BASE_URL" value="$PEER_BASE_URL"

	log_info "launching pi" workspace="$workspace" agentDir="$AGENT_DIR"
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

# Secrets are NOT staged into the sandbox anymore: the host loads them once
# via load_secrets (one cached `infisical secrets --output=dotenv`; see
# ../lib/workload-runtime.sh) and the vault keys are forwarded through the
# workload_env allowlist below, so no infisical runs inside the container and
# the host's ~/.infisical login state never leaves the host.
#
# Fallback base: if the in-container generation fails entirely, the agent
# still starts with the last committed config (generate.sh overwrites on
# success; the 0-provider guard keeps these when the cascade comes up empty).
cp "$SCRIPT_DIR/settings.json" "$agent_dir/settings.json"
[ -f "$SCRIPT_DIR/models.json" ] &&
	cp "$SCRIPT_DIR/models.json" "$agent_dir/models.json"
[ -f "$SCRIPT_DIR/opencode.jsonc" ] &&
	cp "$SCRIPT_DIR/opencode.jsonc" "$opencode_cfg_dir/opencode.json"

# Generator scripts + every other input generate.sh reads, read-only (never
# mount the whole dir: it also carries host-local, untracked files).  Inside the
# container
# lib/workload-runtime.sh derives SCRIPT_DIR from $0, which stays
# /opt/coding-agent/generate.sh — so SCRIPT_DIR is /opt/coding-agent and
# REPO_ROOT is /opt.  Anything missing from this list aborts the in-container
# generate.sh on first read (settings.json used to be missing: it died at the
# settings cp before ANY generation stage ran, leaving the staged fallback
# config in place and a bare `cp: cannot stat …` as the only clue).
_gen_target='/opt/coding-agent'
for _f in generate.sh generate-local-llama-swap.mjs \
	generate-cloud-pi-native-providers.mjs \
	generate-cloud-alternative-providers.mjs \
	merge-models-json.mjs generate-opencode.jsonc.mjs \
	check-node-version.mjs count-providers.mjs list-providers.mjs \
	settings.json; do
	workload_ro "$SCRIPT_DIR/$_f" "$_gen_target/$_f"
done
# Committed fallbacks generate.sh installs when the cascade comes up empty or
# SKIP_GEN=1 (ro_if: optional by definition).
workload_ro_if "$SCRIPT_DIR/models.json" "$_gen_target/models.json"
workload_ro_if "$SCRIPT_DIR/opencode.jsonc" "$_gen_target/opencode.jsonc"
workload_ro "$REPO_ROOT/lib/workload-runtime.sh" '/opt/lib/workload-runtime.sh'
workload_ro "$REPO_ROOT/lib/log.sh" '/opt/lib/log.sh'
# Shared lib/ modules the generators and lib/refresh-models-dev.mjs import
# (docs/d023, docs/d024): generate.sh stages log.mjs + peer-probe.mjs + the
# provider-fact table + the pi shaping module into its scratch dir via
# $LIB_DIR; refresh-models-dev.mjs runs from /opt/lib and imports its sibling
# log.mjs — all must be mounted.
workload_ro "$REPO_ROOT/lib/log.mjs" '/opt/lib/log.mjs'
workload_ro "$REPO_ROOT/lib/peer-probe.mjs" '/opt/lib/peer-probe.mjs'
workload_ro "$REPO_ROOT/lib/cloud-providers.mjs" '/opt/lib/cloud-providers.mjs'
workload_ro "$REPO_ROOT/lib/pi-models.mjs" '/opt/lib/pi-models.mjs'
workload_ro "$REPO_ROOT/lib/refresh-models-dev.mjs" '/opt/lib/refresh-models-dev.mjs'
# The shared vendored models.dev catalog (read-only in here; generate.sh's
# best-effort refresh falls back to a scratch copy when it is not writable).
workload_ro "$REPO_ROOT/lib/models.dev.api.json" '/opt/lib/models.dev.api.json'

# In-container launch chain: generated shell with no infisical — the host
# forwards the vault env through the workload_env allowlist instead.
cat >"$workload_stage/launch.sh" <<EOF
#!/bin/sh
# Generated by coding-agent/run.sh — in-container launch chain.
# Secrets arrive via the workload_env allowlist (host-side infisical via
# load_secrets).  SECRETS_ASSUME=1 short-circuts the shared loader — the
# "emergency not-infisical loader", defined in lib/workload-runtime.sh — so the
# sandbox never runs infisical.
# shellcheck disable=SC1091
. /opt/lib/log.sh
LOG_TOOL='coding-agent/launch'
SECRETS_ASSUME=1
export SECRETS_ASSUME
AGENT_DIR="/home/${USER}/.pi/agent"
OPENCODE_CFG_DIR="/home/${USER}/.config/opencode"
CLINE_DIR="/home/${USER}/.cline"
CLINE_DATA_DIR="/home/${USER}/.cline/data"
THINKRAIL_DATA_DIR="/home/${USER}/.thinkrail"
export AGENT_DIR OPENCODE_CFG_DIR CLINE_DIR CLINE_DATA_DIR THINKRAIL_DATA_DIR

# Run generate.sh with its stderr BOTH streamed (a slow probe cascade must
# not look like a hang) and teed to a log, so a failure can be reported with
# the upstream error instead of "something went wrong".  The rc file works
# around /bin/sh having no PIPESTATUS/pipefail: a pipeline's status is its
# last command (tee), not generate.sh.
_gen_log="\${TMPDIR:-/tmp}/pi-generate.\$\$.log"
_gen_rc_file="\$_gen_log.rc"
{ { "$_gen_target/generate.sh" 2>&1 >&3 3>&-; echo \$? >"\$_gen_rc_file"; } | \
	tee "\$_gen_log" >&2; } 3>&1
_gen_rc="\$(cat "\$_gen_rc_file")"
rm -f -- "\$_gen_rc_file"
if [ "\$_gen_rc" = 0 ]; then
	log_info "generate.sh completed" log="\$_gen_log"
else
	# Quote the failure verbatim: the last line generate.sh wrote — its own
	# structured abort line (see the EXIT trap there), or, failing that, the
	# raw tool error that killed it — is the actionable part.
	_gen_last="\$(grep -v '^[[:space:]]*\$' "\$_gen_log" | tail -n 1)"
	log_error "in-container generate.sh failed — using staged fallback config" \
		exit="\$_gen_rc" error="\$_gen_last" log="\$_gen_log"
fi
log_info "launching interactive bash" agentDir="\$AGENT_DIR"
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
workload_ro_if    "$HOME/Downloads/references" "$HOME/Downloads/references"
#workload_ro_if    "$HF_HUB_CACHE" /home/${USER}/.cache/huggingface/hub
workload_rw       "$agent_dir" "/home/${USER}/.pi/agent"
workload_rw       "$HF_HUB_CACHE" "/home/${USER}/.cache/huggingface/hub"
workload_rw       "$opencode_cfg_dir" "/home/${USER}/.config/opencode"
workload_rw       "$opencode_data_dir" "/home/${USER}/.local/share/opencode"
workload_rw       "$cline_dir" "/home/${USER}/.cline"
workload_rw       "$thinkrail_dir" "/home/${USER}/.thinkrail"
workload_rw       "$workspace" "$workspace"
workload_workdir  "$workspace"
# Secrets! Host-side load_secrets (one cached infisical export) provides the
# vault keys; the allowlist below forwards them into the sandbox like the
# llm-reverse-proxy run path.  Only non-empty values are forwarded (a bare
# `--env NAME` with an unset host var would inject an empty value).
load_secrets
log_info "secrets source" source="${SECRETS_SOURCE:-none}"
for _key in CLINE_API_KEY MISTRAL_API_KEY PEER_API_KEY OPENROUTER_API_KEY \
	OPENCODE_API_KEY HF_TOKEN GEMINI_API_KEY PEER_BASE_URL; do
	_value="$(printenv "$_key" 2>/dev/null || true)"
	[ -n "$_value" ] && workload_env "$_key"
done
# Forwarded only when set in the host env (unset vars are not exported).
workload_env      SKIP_GEN
workload_env      MODELS_DEV_REFRESH
workload_cmd      /bin/sh /opt/agentcontainer-launch.sh
workload_run