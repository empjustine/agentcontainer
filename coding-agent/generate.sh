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
#     - secrets arrive as plain environment, via the explicit chain
#       (./lib/environment.sh ./generate.sh — its infisical resolution
#       prefers the Termux CLI build; no .env file is ever read)
#     - vendored models.dev catalog by default (no refetch over mobile data)
#   Everywhere else (host or inside the coding-agent container):
#     - node_run from ../lib/workload-runtime.sh (system node on Termux, mise
#       exec node@24 elsewhere — mise pinned via ../mise.toml / image config)
#     - secrets expected ALREADY IN the environment by the caller: run.sh is
#       exec'd through lib/environment.sh (the HOST-side chain — one
#       infisical round-trip outside any sandbox) and forwards the vault env
#       through the workload_env allowlist, so the in-container generators
#       never run infisical.  Manual host runs go through the same chain:
#       ./lib/environment.sh ./generate.sh
#     - models.dev catalog refreshed best-effort
#     - peer routing goes through the vault-sourced $PEER_BASE_URL (or
#       $PEER_BASE_URLS for multi-hop proxy chains — see lib/peer-probe.mjs)
#       bazzite tailscale FQDN) only — no localhost:8080 or localhost:8101
#       candidates (the
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
#   generate-local-llama-swap.mjs -> model-010-local-default.json
#       local GGUF cascade: probes the llama-swap peer candidates and emits
#       the `llama-swap` provider (pi-shaped, meta.llamaswap mirrored).
#   generate-cloud-providers.mjs -> model-012-cloud-pi-native.json
#       + model-015-cloud-cline-pass.json + model-016-cloud-hyper.json
#       + model-017-cloud-inferx.json (docs/d037 — one table-driven generator
#       for every cloud layer)
#       override-only rows (openrouter/opencode/opencode-go/mistral/google/
#       nvidia): pi-native cloud override cascade — probes each provider's
#       OWN endpoint and emits a reroute override only when it is
#       unreachable — routing it through its peer path-route on the
#       simplified cloud router (<peerBase>/<providerId>, docs/d027; includes
#       google, whose native generative-ai dialect the path-forwarding proxy
#       carries byte-for-byte).
#       full rows (cline-pass/hyper/inferx): derived from the vendored
#       models.dev.api.json (with catwalk fallback); full provider blocks (pi
#       has no native cline-pass/hyper), per-provider real-or-peer path-route
#       cascade decides the route (same key in both modes — the proxy
#       forwards credentials untouched, docs/d027).
#   merge-models-json.mjs      -> models.json
#   generate-opencode.jsonc.mjs -> opencode config (OPENCODE_CFG_DIR/opencode.json,
#       or <this dir>/opencode.jsonc for manual host runs; skipped on Termux)
#   helpers (called by this script, not generators):
#       check-node-version.mjs — Termux node floor gate (pre-staging: it is
#           read from SCRIPT_DIR, and needs no scratch dir because it writes
#           nothing)
#       count-providers.mjs / list-providers.mjs — inspect the generated
#           models.json; each documents itself
#
# Outputs are installed into $AGENT_DIR (models.json + settings.json, backup
# kept as .bak-<ts>) — there is no separate install step anymore.
#
# Usage: ./generate.sh
#
# Env overrides:
#   AGENT_DIR        install dir (default ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent})
#   DRY_RUN          1 = generators do NOT replace their artifacts (models.json
#                    layers, opencode.json, the vendored catalog refresh) —
#                    each write lands in a sibling <name>.dry-run preview
#                    (repo-wide generator standard, lib/artifact.mjs)
#   OPENCODE_CFG_DIR write opencode.json here instead of this dir (Termux: unset
#                    skips the opencode stage)
#   SKIP_GEN         1 = install the committed <this dir>/models.json instead of
#                    generating (no network at all). ORTHOGONAL to DRY_RUN:
#                    SKIP_GEN chooses the artifact SOURCE (committed snapshot,
#                    generators do not run); DRY_RUN suppresses the artifact
#                    WRITE (generators run, computed output lands in .dry-run
#                    previews). SKIP_GEN=1 short-circuits before DRY_RUN could
#                    matter.
#   RUN_DIR          scratch dir for intermediate layers (default $TMPDIR,
#                    falling back to $PREFIX/tmp on Termux, /tmp elsewhere) —
#                    this script's dir may be a read-only mount
#   MODELS_DEV_JSON  models.dev catalog (default ../lib/models.dev.api.json —
#                    the shared vendored catalog, see docs/d023)
#   MODELS_DEV_REFRESH 1 = force catalog refresh on Termux too
#   MODELS_DEV_RELAY_URL  catalog relay fallback (llm-reverse-proxy
#                    passthrough; default http://127.0.0.1:8080/models.dev/
#                    api.json, empty disables — fetch chain in docs/d027)

set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/workload-runtime.sh  # _termux, node_run, default_run_dir, log_**
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

SKIP_GEN="${SKIP_GEN:-0}"
AGENT_DIR="${AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"
RUN_DIR="${RUN_DIR:-$(default_run_dir)}"
MODELS_DEV_JSON="${MODELS_DEV_JSON:-$REPO_ROOT/lib/models.dev.api.json}"

mkdir -p "$RUN_DIR" "$AGENT_DIR"
log_info "profile" \
	profile="$([ "$_termux" = 1 ] && printf termux || printf container-host)" \
	agentDir="$AGENT_DIR" runDir="$RUN_DIR"

# --- environment: arrive from the explicit chain (lib/environment.sh); this
# script consumes plain env and never loads anything itself -------------------

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

# --- scratch dir: generators read layers from their own directory, and this
# script's dir may be a read-only mount (container ro-mount), so stage the
# generators — plus the lib/ modules they import (log.mjs, peer-probe.mjs,
# resolved via $LIB_DIR, docs/d023) — there and symlink the big inputs.
_GEN_STAGE='scratch-stage'
_scratch="$RUN_DIR/pi-models-gen.$$"
mkdir -p "$_scratch"
for _f in gen-lib.mjs generate-local-llama-swap.mjs \
	generate-cloud-providers.mjs \
	merge-models-json.mjs generate-opencode.jsonc.mjs \
	generate-default-model.mjs \
	count-providers.mjs list-providers.mjs; do
	if [ -f "$SCRIPT_DIR/$_f" ]; then
		cp "$SCRIPT_DIR/$_f" "$_scratch/$_f"
	else
		log_warn "generator missing" path="$SCRIPT_DIR/$_f"
	fi
done
# Structured logging + HTTP probing + the shared fact/shaping modules for the
# .mjs generators: they import all of these from $LIB_DIR (default ../lib
# relative to their own file — which from the scratch dir resolves somewhere
# that does not exist, so a missing copy here costs every generator instead of
# one clear line).
mkdir -p "$_scratch/lib"
for _lf in log.mjs artifact.mjs peer-probe.mjs cloud-providers.mjs pi-models.mjs hyper-facts.mjs catwalk-facts.mjs; do
	if [ -f "$REPO_ROOT/lib/$_lf" ]; then
		cp "$REPO_ROOT/lib/$_lf" "$_scratch/lib/$_lf"
	else
		log_error "lib module missing — generators cannot log or probe" \
			path="$REPO_ROOT/lib/$_lf"
	fi
done
# The hyper and catwalk facts caches ride along with their modules: staged
# into the scratch lib (writable) so in-container refreshes succeed instead
# of failing on the ro-mounted /opt/lib; both caches are consumed
# stale-tolerantly and direct-mode runs refresh them fresh.
for _fc in hyper-facts.json catwalk-facts.json; do
	if [ -f "$REPO_ROOT/lib/$_fc" ]; then
		cp "$REPO_ROOT/lib/$_fc" "$_scratch/lib/$_fc"
	fi
done
LIB_DIR="$_scratch/lib"
export LIB_DIR
[ -f "$MODELS_DEV_JSON" ] &&
	ln -s "$MODELS_DEV_JSON" "$_scratch/models.dev.api.json"

# --- settings.json: install FIRST, so it lands even if every stage fails ----
# (Moved here to ensure $_SETTINGS is defined before default model uses it)
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
		if node_run "$REPO_ROOT/lib/refresh-models-dev.mjs" "$_catalog_out"; then
			log_info "models.dev catalog refreshed" path="$_catalog_out"
		else
			log_warn "models.dev catalog refresh failed; using vendored copy" \
				path="$MODELS_DEV_JSON"
		fi
	fi

	log_info "generating models.json (direct-vs-peer path-route cascades + models.dev)"
	if [ -f "$_scratch/generate-local-llama-swap.mjs" ]; then
		node_run "$_scratch/generate-local-llama-swap.mjs" \
			"$_scratch/model-010-local-default.json" ||
			log_warn "generate-local-llama-swap.mjs failed — layer omitted"
	fi
	# Cloud layers (docs/d037 unified generator — override-only AND full rows):
	# probes each pi-native provider's own endpoint (reroute only when
	# unreachable) and derives the full alternative provider blocks from the
	# vendored models.dev.api.json.  Writes the shared pi-native override layer
	# next to itself (the scratch dir): model-012-cloud-pi-native.json, plus
	# one layer file per full row: model-015-cloud-cline-pass.json,
	# model-016-cloud-hyper.json and model-017-cloud-inferx.json.
	if [ -f "$_scratch/generate-cloud-providers.mjs" ]; then
		node_run "$_scratch/generate-cloud-providers.mjs" ||
			log_warn "generate-cloud-providers.mjs failed — layers omitted"
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

# --- default model: return the operator's hardcoded defaultProvider/
# defaultModel from the settings source, as is (docs/d036 — the former
# models.json-probing picker selected unreachable-at-request-time providers;
# the default is an OPERATOR DECISION, not a probed fact).  Independent of
# the models.json stage; best-effort like every other stage. ---------------
_GEN_STAGE='default-model'
if [ "$SKIP_GEN" = 1 ]; then
	log_info "SKIP_GEN: skipping default model configuration"
elif [ -f "$_scratch/generate-default-model.mjs" ]; then
	# Point the generator at the settings file this script just installed (the
	# single source of the hardcoded pair — the scratch copy never carries it).
	PI_SETTINGS="$_SETTINGS"
	export PI_SETTINGS
	if node_run "$_scratch/generate-default-model.mjs" "$_scratch/default-model.json" &&
		[ -s "$_scratch/default-model.json" ]; then
			_default_model_json="$_scratch/default-model.json"
			_default_settings="$_scratch/settings-with-default.json"
			node_run -e "
				const fs = require('fs');
				const settings = JSON.parse(fs.readFileSync('$_SETTINGS', 'utf-8'));
				const defaultModel = JSON.parse(fs.readFileSync('$_default_model_json', 'utf-8'));
				if (defaultModel.defaultProvider) settings.defaultProvider = defaultModel.defaultProvider;
				if (defaultModel.defaultModel) settings.defaultModel = defaultModel.defaultModel;
				fs.writeFileSync('$_default_settings', JSON.stringify(settings, null, 2) + '\\n');
			"
			if [ -f "$_default_settings" ]; then
				cp "$_default_settings" "$_SETTINGS"
				log_info "settings.json updated with default model config" \
					path="$_SETTINGS"
			fi
	else
		log_warn "generate-default-model.mjs failed or empty overlay"
	fi
else
	log_warn "generate-default-model.mjs not staged"
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

log_info "done" agentDir="$AGENT_DIR"
