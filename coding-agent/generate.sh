#!/bin/sh
# generate.sh — unified pi config generator (container hosts AND Termux).
#
# Merges the former generate.sh (host/container: mise + Infisical-wrapped
# stages, artifacts into the repo dir) and generate-termux.sh (system node,
# vault secrets, straight into the agent dir).  The split is now a *profile*,
# detected at runtime, not a pair of scripts:
#
#   Termux (PREFIX under /data/data/com.termux):
#     - system node (>= 22.19, checked) — no mise
#     - secrets via load_secrets: the Termux build of the infisical CLI
#       ($HOME/Infisical/cli/infisical — built with -checklinkname=0 by the
#       repo root ./build.sh) is used when available; keys already exported
#       into the environment are used as-is (no .env file is ever read)
#     - vendored models.dev catalog by default (no refetch over mobile data)
#     - localhost:18080 / localhost:8080 relay overrides dropped by default
#       (LOCAL_INFERENCE / SELF_RELAY = 0)
#   Everywhere else (host or inside the coding-agent container):
#     - `mise x node@24 -- node` (mise pinned via ../mise.toml / image config)
#     - secrets expected ALREADY INJECTED by the caller: run.sh loads them on
#       the HOST (load_secrets — one cached infisical export) and forwards
#       them through the workload_env allowlist, so the in-container
#       generators never run infisical.  Manual host runs just call
#       load_secrets below.
#     - models.dev catalog refreshed best-effort
#     - relay overrides kept by default (LOCAL_INFERENCE / SELF_RELAY = 1)
#
# Logging: structured JSON on stderr (LOG_FORMAT=logfmt to switch; see
# lib/log.sh) — stdout is never used for logs.  Every failure is a structured
# line: dead ends that are expected to happen are `warn` (best-effort stages),
# and a run killed by `set -e` additionally emits `generate.sh aborted` with the
# stage and exit code (EXIT trap below), so the caller can quote the real cause
# instead of "generate.sh failed".
#
# Stages (each non-fatal on its own; the layered models.json contract these
# feed is documented in merge-models-json.mjs):
#   generate-models.json.mjs  -> model-010-local-default.json
#       peer-router cascade: probes each provider's OWN endpoint and emits an
#       override only when it is unreachable ("swap only baseUrl").
#   generate-cline-pass.mjs   -> model-015-cloud-cline-pass.json
#       derived from the vendored models.dev.api.json; no network, no secrets.
#   merge-models-json.mjs      -> models.json
#   generate-opencode.jsonc.mjs -> opencode config (OPENCODE_CFG_DIR/opencode.json,
#       or <this dir>/opencode.jsonc for manual host runs; skipped on Termux)
#   helpers (called by this script, not generators):
#       check-node-version.mjs — Termux node floor gate (pre-staging: it is
#           read from SCRIPT_DIR, and needs no scratch dir because it writes
#           nothing)
#       filter-relays.mjs / count-providers.mjs / list-providers.mjs — inspect
#           and rewrite the generated models.json; each documents itself
#
# Outputs are installed into $AGENT_DIR (models.json + settings.json, backup
# kept as .bak-<ts>) — there is no separate install step anymore.
#
# Usage: ./generate.sh
#
# Env overrides:
#   AGENT_DIR        install dir (default ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent})
#   OPENCODE_CFG_DIR write opencode.json here instead of this dir (Termux: unset
#                    skips the opencode stage)
#   SKIP_GEN         1 = install the committed <this dir>/models.json instead of
#                    generating (no network at all)
#   RUN_DIR          scratch dir for intermediate layers (default $TMPDIR,
#                    falling back to $PREFIX/tmp on Termux, /tmp elsewhere) —
#                    this script's dir may be a read-only mount
#   MODELS_DEV_JSON  models.dev catalog (default <this dir>/models.dev.api.json)
#   MODELS_DEV_REFRESH 1 = force catalog refresh on Termux too
#   LOCAL_INFERENCE  1 = keep providers relayed at localhost:18080
#                      (default: 1, 0 on Termux)
#   SELF_RELAY       1 = keep providers relayed at localhost:8080
#                      (default: 1, 0 on Termux — on a peers-only host that
#                      probe is a self-hit and the override would be pointless)

set -eu
# shellcheck disable=SC1091
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='coding-agent/generate'
export LOG_TOOL

# --- structured abort reporting -------------------------------------------
# A command that dies under `set -e` (missing input, EROFS write, typo) would
# otherwise end the run with only its own raw stderr — e.g. `cp: cannot stat
# …: No such file or directory` — which the caller can only summarize as
# "generate.sh failed".  Track the current stage and log the abort as a
# structured line naming it, so the failure is machine-readable AND quotable:
# coding-agent/run.sh's in-container launch chain tees this stream and puts its
# last line into its own error field.  Deliberate exits go through _die() so
# log_die's specific message is not followed by a vaguer one.
_GEN_STAGE='startup'
_GEN_EXPECTED_EXIT=0
_die() {
	_GEN_EXPECTED_EXIT=1
	log_die "$@"
}
_gen_abort() {
	_gen_rc=$?
	if [ "$_GEN_EXPECTED_EXIT" = 1 ] || [ "$_gen_rc" = 0 ]; then
		return 0
	fi
	log_error "generate.sh aborted — later stages did not run" \
		stage="$_GEN_STAGE" exit="$_gen_rc"
}
trap _gen_abort EXIT

case "${PREFIX:-}" in
	*/com.termux/*) _termux=1 ;;
	*) _termux=0 ;;
esac

SKIP_GEN="${SKIP_GEN:-0}"
AGENT_DIR="${AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"
RUN_DIR="${RUN_DIR:-$([ "$_termux" = 1 ] && printf '%s' "${TMPDIR:-${PREFIX}/tmp}" || printf '%s' "${TMPDIR:-/tmp}")}"
MODELS_DEV_JSON="${MODELS_DEV_JSON:-$SCRIPT_DIR/models.dev.api.json}"
LOCAL_INFERENCE="${LOCAL_INFERENCE:-$((1 - _termux))}"
SELF_RELAY="${SELF_RELAY:-$((1 - _termux))}"

mkdir -p "$RUN_DIR" "$AGENT_DIR"
log_info "profile" \
	profile="$([ "$_termux" = 1 ] && printf termux || printf container-host)" \
	agentDir="$AGENT_DIR" runDir="$RUN_DIR"

# --- secrets (single call; see load_secrets in ../lib/workload-runtime.sh) --------
load_secrets
log_debug "secrets loaded" secrets="$SECRETS_SOURCE"

# --- node ------------------------------------------------------------------
node_run() {
	if [ "$_termux" = 1 ]; then
		node "$@"
	else
		mise x node@24 -- node "$@"
	fi
}
if [ "$_termux" = 1 ]; then
	if ! command -v node >/dev/null 2>&1; then
		_die 93 "node not found (need >= 22.19 for pi-coding-agent)"
	fi
	# Real floor is pi-coding-agent's engines (node >= 22.19.0), not 20.6 —
	# see check-node-version.mjs, which prints its own reason on stderr and
	# exits non-zero below the floor.
	if ! node "$SCRIPT_DIR/check-node-version.mjs"; then
		_die 93 "node too old (need >= 22.19 for pi-coding-agent)"
	fi
fi

# --- settings.json: install FIRST, so it lands even if every stage fails ----
_GEN_STAGE='settings-install'
_SETTINGS="$AGENT_DIR/settings.json"
if [ "$SCRIPT_DIR" != "$AGENT_DIR" ]; then
	if [ ! -f "$SCRIPT_DIR/settings.json" ]; then
		# Incomplete generator tree (in-container: a missing ro-mount — run.sh
		# must stage EVERY input this script reads from its own dir).  Reported
		# at error level because it is never expected, but non-fatal on
		# purpose: the caller's staged settings.json is already in place and
		# none of the stages below depend on this file, so aborting here would
		# cost the whole generation for a static file.
		log_error "settings.json source missing — keeping the agent dir's copy" \
			path="$SCRIPT_DIR/settings.json" agentSettings="$_SETTINGS"
	else
		if [ -f "$_SETTINGS" ]; then
			cp "$_SETTINGS" "$_SETTINGS.bak-$(date +'%Y%m%d%H%M%S')"
		fi
		cp "$SCRIPT_DIR/settings.json" "$_SETTINGS"
		log_info "settings.json installed" path="$_SETTINGS"
	fi
fi

# --- scratch dir: generators read layers from their own directory, and this
# script's dir may be a read-only mount (container ro-mount), so stage the
# generators — plus lib/log.mjs (generators import it via $LOG_LIB) — there
# and symlink the big inputs.
_GEN_STAGE='scratch-stage'
_scratch="$RUN_DIR/pi-models-gen.$$"
mkdir -p "$_scratch"
for _f in generate-models.json.mjs generate-cline-pass.mjs \
	merge-models-json.mjs generate-opencode.jsonc.mjs \
	filter-relays.mjs count-providers.mjs list-providers.mjs; do
	if [ -f "$SCRIPT_DIR/$_f" ]; then
		cp "$SCRIPT_DIR/$_f" "$_scratch/$_f"
	else
		log_warn "generator missing" path="$SCRIPT_DIR/$_f"
	fi
done
# Structured logging for the .mjs generators: they import $LOG_LIB, falling
# back to ../lib/log.mjs relative to their own file — which from the scratch
# dir resolves somewhere that does not exist, so a missing copy here costs
# every generator (three identical stack traces) instead of one clear line.
if [ -f "$REPO_ROOT/lib/log.mjs" ]; then
	cp "$REPO_ROOT/lib/log.mjs" "$_scratch/log.mjs"
	LOG_LIB="$_scratch/log.mjs"
	export LOG_LIB
else
	log_error "lib/log.mjs missing — generators cannot log structured" \
		path="$REPO_ROOT/lib/log.mjs"
fi
[ -f "$SCRIPT_DIR/00-model-base.json" ] &&
	cp "$SCRIPT_DIR/00-model-base.json" "$_scratch/00-model-base.json"
[ -f "$MODELS_DEV_JSON" ] &&
	ln -s "$MODELS_DEV_JSON" "$_scratch/models.dev.api.json"

# --- models.json -----------------------------------------------------------
_GEN_STAGE='models-json'
_models_out=""
if [ "$SKIP_GEN" = 1 ]; then
	if [ -f "$SCRIPT_DIR/models.json" ]; then
		_models_out="$SCRIPT_DIR/models.json"
		log_info "SKIP_GEN: using committed models.json" path="$_models_out"
	else
		log_warn "SKIP_GEN=1 but committed models.json missing" \
			path="$SCRIPT_DIR/models.json"
	fi
else
	# Best-effort refresh of the vendored models.dev catalog (no secrets
	# needed).  Termux keeps the vendored copy by default (4.3 MB — do not
	# refetch over mobile data); MODELS_DEV_REFRESH=1 forces it.
	if [ "$_termux" = 0 ] || [ "${MODELS_DEV_REFRESH:-0}" = 1 ]; then
		# Refresh into the scratch dir when the catalog itself is not writable
		# (container hosts: $MODELS_DEV_JSON is a read-only mount, so writing
		# there fails every single run).  The scratch entry is a symlink to the
		# vendored catalog at this point; the generator's tmp+rename replaces
		# the symlink with a regular file and never follows it, so the vendored
		# copy stays untouched either way.
		_catalog_out="$MODELS_DEV_JSON"
		if [ ! -w "$MODELS_DEV_JSON" ]; then
			_catalog_out="$_scratch/models.dev.api.json"
		fi
		if node_run "$SCRIPT_DIR/refresh-models-dev.mjs" "$_catalog_out"; then
			log_info "models.dev catalog refreshed" path="$_catalog_out"
		else
			log_warn "models.dev catalog refresh failed; using vendored copy" \
				path="$MODELS_DEV_JSON"
		fi
	fi

	log_info "generating models.json (peer-router cascade + models.dev)"
	if [ -f "$_scratch/generate-models.json.mjs" ]; then
		node_run "$_scratch/generate-models.json.mjs" \
			"$_scratch/model-010-local-default.json" ||
			log_warn "generate-models.json.mjs failed — layer omitted"
	fi
	# ClinePass layer: derived from the vendored models.dev.api.json, no
	# secrets needed.
	# NOTE: there is intentionally NO google layer here — llama-swap is an
	# openai-completions relay and cannot proxy Google's native API, so Google
	# always goes through pi's built-in google provider (GEMINI_API_KEY).
	if [ -f "$_scratch/generate-cline-pass.mjs" ] && [ -f "$_scratch/models.dev.api.json" ]; then
		node_run "$_scratch/generate-cline-pass.mjs" \
			"$_scratch/model-015-cloud-cline-pass.json" ||
			log_warn "generate-cline-pass.mjs failed — layer omitted"
	fi
	if [ -f "$_scratch/merge-models-json.mjs" ]; then
		node_run "$_scratch/merge-models-json.mjs" "$_scratch/models.json" ||
			log_warn "merge-models-json.mjs failed"
	fi

	if [ -s "$_scratch/models.json" ]; then
		_models_out="$_scratch/models.json"
	else
		log_warn "no models.json generated; falling back to committed copy" \
			path="$SCRIPT_DIR/models.json"
		[ -f "$SCRIPT_DIR/models.json" ] && _models_out="$SCRIPT_DIR/models.json"
	fi
fi

# --- drop relays that are invalid on this host -----------------------------
# generate-models.json.mjs probes localhost:18080 (deprecated local inference)
# and localhost:8080 (ourselves on a peers-only host); LOCAL_INFERENCE /
# SELF_RELAY filter the result.  Termux defaults drop both; container hosts
# keep the upstream behavior unless overridden.
if [ -n "$_models_out" ]; then
	_install_tmp="$RUN_DIR/pi-models.install.$$"
	cp "$_models_out" "$_install_tmp"
	_models_out="$_install_tmp"
	if [ "$LOCAL_INFERENCE" != 1 ] || [ "$SELF_RELAY" != 1 ]; then
		_dropped="$(node_run "$_scratch/filter-relays.mjs" \
			"$_models_out" "$LOCAL_INFERENCE" "$SELF_RELAY")"
		[ -n "$_dropped" ] &&
			log_warn "dropped non-relay provider(s)" providers="$_dropped"
	fi
fi

# --- install models.json into the agent dir --------------------------------
# An empty provider map is a VALID outcome of the cascade (every provider
# reachable directly ⇒ nothing to override); writing it would still wipe a
# working models.json, so keep what is there.
_GEN_STAGE='models-install'
if [ -n "$_models_out" ]; then
	_count="$(node_run "$_scratch/count-providers.mjs" "$_models_out")"
	if [ "${_count:-0}" -eq 0 ]; then
		log_info "0 provider overrides (all reachable directly / no peer router)" \
			action="keep" modelsJson="$AGENT_DIR/models.json"
	else
		if [ -f "$AGENT_DIR/models.json" ]; then
			cp "$AGENT_DIR/models.json" \
				"$AGENT_DIR/models.json.bak-$(date +'%Y%m%d%H%M%S')"
		fi
		cp "$_models_out" "$AGENT_DIR/models.json"
		node_run "$_scratch/list-providers.mjs" "$AGENT_DIR/models.json" |
			while IFS="$(printf '\t')" read -r _pid _pmodels _purl; do
				log_info "provider override" \
					provider="$_pid" models="$_pmodels" baseUrl="$_purl"
			done
		log_info "models.json installed" path="$AGENT_DIR/models.json" \
			providers="$_count" backup="kept alongside"
	fi
elif [ ! -f "$AGENT_DIR/models.json" ] && [ -f "$SCRIPT_DIR/models.json" ]; then
	cp "$SCRIPT_DIR/models.json" "$AGENT_DIR/models.json"
	log_info "nothing generated; installed committed models.json" \
		path="$AGENT_DIR/models.json"
fi

# --- opencode config --------------------------------------------------------
# Upstream generates the peer-mode provider overlay when asked.  In-container
# runs target the mounted config dir; manual host runs refresh this dir's
# committed opencode.jsonc; Termux skips the stage entirely (pi-only path)
# unless OPENCODE_CFG_DIR is set.
_GEN_STAGE='opencode-config'
_oc_out=""
if [ -n "${OPENCODE_CFG_DIR:-}" ]; then
	mkdir -p "$OPENCODE_CFG_DIR"
	_oc_out="$OPENCODE_CFG_DIR/opencode.json"
elif [ "$_termux" = 0 ]; then
	_oc_out="$SCRIPT_DIR/opencode.jsonc"
fi
if [ -n "$_oc_out" ] && [ -f "$_scratch/generate-opencode.jsonc.mjs" ]; then
	if ! node_run "$_scratch/generate-opencode.jsonc.mjs" "$_oc_out"; then
		log_warn "generate-opencode.jsonc.mjs failed; using existing config if present"
	fi
fi

[ -d "${_scratch:-}" ] && rm -rf "$_scratch"
[ -f "${_install_tmp:-}" ] && rm -f "${_install_tmp:-}"

log_info "done" secrets="$SECRETS_SOURCE" agentDir="$AGENT_DIR"
