#!/bin/sh
# generate.sh — (re)generate the split llama-swap config in config.d/, by
# running the single-concern generators below.  RUN THIS TO REFRESH PEER
# LISTS — after adding/changing a provider in gen-lib.mjs, after a models.dev
# catalog refresh, or when a host's capabilities changed (GPU added/removed,
# container backend installed).  One file for container hosts AND Termux:
# profile-detected at runtime, merged from the former generate.sh
# (host/container) and generate-termux.sh (native/Termux).
# The native-vs-sandboxed split is a real *backend/capability* difference
# (container + GPU vs. native binary + peers-only), not an env-loading one —
# secrets are already unified via the shared load_secrets (lib/workload-runtime.sh).
#
# Peers-only hosts (Termux/a50, OCI free tier) get an EMPTY local `models`
# map: no generator here emits local entries unless the container backend AND
# a GPU device are present, so the config is cloud peers (+ a remote gfx1030
# route when one answers) and nothing else.  That is by construction — there
# is no --peers-only flag to get wrong.  Local GGUF args are emitted only by
# generate-local-llm-models.yaml.mjs on GPU-capable container hosts.
#
# Generators emit LAYERS into config.d/, and only the layers that work on the
# CURRENT host are generated/copied — a GPU-capable container host gets local
# inference + peers; everything else (incl. Termux: no container runtime, no
# /dev/kfd, no /dev/dri/renderD*) is peers-only by construction.  Stale layers
# from a previous capability set are removed so config.d/ always matches the
# host.
#
#   00-general.yaml              always  (globals + macros)
#   10-local-llm-inference.yaml  only when local inference is viable (container
#                                backend AND GPU devices), or LOCAL_INFERENCE=1
#                                to force (emits container-side paths — parity/
#                                debug only)
#   launch-gguf.sh               copied alongside 10-... (static HF-snapshot
#                                resolver; not generated)
#   peer-cloud.yaml              whenever any cloud provider answers
#   22-peer-gfx1030.yaml         only when NOT serving locally and a gfx1030
#                                instance answers the probe cascade
#                                (GFX1030=0 skips the probe)
#
# STALE-OUTPUT POLICY (config.d/ mirrors the CURRENT host, so every layer has
# an explicit rule for "its source dried up" — and the asymmetry is
# deliberate):
#   00-general.yaml        never stale (static source: llama-swap-core.json)
#   10-local-llm-inference REMOVED when the container backend or the GPU
#                          devices disappear — a local layer describes THIS
#                          host, and serving GGUFs without the hardware is a
#                          hard error at swap time
#   peer-cloud.yaml        REMOVED when no provider answers — the cloud layer
#                          describes external reachability, which is cheap to
#                          re-detect; individual provider skips stay granular
#                          so one outage never blanks the others
#   22-peer-gfx1030.yaml   KEPT when the probe cascade finds nothing — it
#                          describes a REMOTE host, so a generation-time
#                          transient (tailscale blip, instance restarting)
#                          must not drop a working route
#
# Merge contract for the fragments (llama-swap's -config-dir loader;
# docs/d018): identity-keyed maps (models/peers/...) merge additively and a
# duplicate key across files is a hard error, while `apiKeys` concatenates and
# macros/ctxWindows/scalars must be single-defined — hence each generator owns
# a disjoint key set and 00-general.yaml is the only home of the globals.
#
# Secrets via the shared load_secrets (see ../lib/workload-runtime.sh): ONE in-memory
# vault round-trip, injected into the environment — no per-generator
# `infisical run` wrappers, no --env-file and no .env.  Every stage inherits
# the loaded environment.  Missing keys are fine: key-gated peers are simply
# skipped.
#
# Env overrides:
#   REFRESH_MODELS_DEV   1 = refetch models.dev.api.json on Termux too
#                        (default 1 on container hosts, 0 on Termux)
#   MODELS_DEV_JSON      catalog path (default ../lib/models.dev.api.json — the
#                        shared vendored catalog, see docs/d023)
#   LOCAL_INFERENCE      1 = force the local-inference layer regardless of the
#                        capability gate (emits container-side paths; debug)
#   GFX1030              0 = skip the gfx1030 peer probe (default 1)
#   PEER_BASE_URL         explicit relay base for the gfx1030 probe
#   FORCE                1 = accept a smaller peer set instead of rolling back
#   RUN_DIR              snapshot dir (default ${TMPDIR:-$PREFIX/tmp}, else /tmp)

set -eu
# shellcheck source-path=SCRIPTDIR source=../lib/workload-runtime.sh  # _termux, node_run, default_run_dir, log_**
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/generate'
export LOG_TOOL

script_dir="$(cd "$(dirname "$0")" && pwd)"
config_d="$script_dir/config.d"
RUN_DIR="${RUN_DIR:-$(default_run_dir)}"
REFRESH_MODELS_DEV="${REFRESH_MODELS_DEV:-$((1 - _termux))}"
MODELS_DEV_JSON="${MODELS_DEV_JSON:-$REPO_ROOT/lib/models.dev.api.json}"
LOCAL_INFERENCE="${LOCAL_INFERENCE:-0}"
GFX1030="${GFX1030:-1}"
FORCE="${FORCE:-0}"

mkdir -p -- "$RUN_DIR" "$config_d"

# --- node ------------------------------------------------------------------
# node_run comes from lib/workload-runtime.sh (system node on Termux, mise
# node@24 elsewhere).  Termux runs the system node; the generators use the
# global fetch() and AbortSignal.timeout (Node >= 18).  The --env-file flag is
# no longer used, so the old ">= 20.6 for --env-file" floor does not apply here.
if [ "$_termux" = 1 ]; then
	if ! command -v node >/dev/null 2>&1; then
		log_die 93 "node not found (need >= 18.0 for global fetch)"
	fi
	if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
		log_die 93 "node too old (need >= 18.0 for global fetch)"
	fi
fi

# --- 0. vendored models.dev catalog (best-effort atomic refresh) ------------
# Container hosts refresh every run; Termux keeps the 4.3 MB vendored copy by
# default (REFRESH_MODELS_DEV=1 forces it).  A failed fetch keeps the last
# good catalog, so generation always proceeds (offline hosts use the vendored
# copy).
if [ "$_termux" = 0 ] || [ "${REFRESH_MODELS_DEV}" = 1 ]; then
	if [ -f "$REPO_ROOT/lib/refresh-models-dev.mjs" ]; then
		if ! node_run "$REPO_ROOT/lib/refresh-models-dev.mjs" "$MODELS_DEV_JSON"; then
			log_warn "models.dev catalog refresh failed — using vendored copy"
		fi
	else
		log_warn "lib/refresh-models-dev.mjs not found — using vendored copy"
	fi
fi

# --- secrets ---------------------------------------------------------------
# Shared load_secrets: one host-side vault round-trip, injected in memory
# (infisical — the Termux CLI build when available — or keys already in the
# caller's environment).  No .env / ENV_FILE is ever read.  Missing keys are
# fine — key-gated peers are skipped.
load_secrets
log_info "secrets source" source="${SECRETS_SOURCE:-none}"

# Complain about key names this pipeline does not read, rather than silently
# generating a config without peers.  (Universal — harmless on container hosts.)
# Note: there is intentionally NO `__`-prefix scanner here — the `__`-prefix
# key-naming convention was retired (rationale in docs/d001 §3 and
# docs/d024).  Anything in the environment starting with `__` is not a key
# this pipeline cares about and is ignored, not warned on.
_legacy="$(env | sed -n \
	's/^\(OPENCODE_ZEN_API_KEY\|OPENCODE_GO_API_KEY\)=.*/\1/p' | tr '\n' ' ')"
if [ -n "${_legacy# }" ]; then
	log_warn "ignoring legacy split opencode key(s); upstream uses a single OPENCODE_API_KEY for both the Zen and Go peers" \
		keys="${_legacy% }"
fi

# --- snapshot config.d/ for rollback (see the shrunken-peer-set rollback) ---
_snap=""
if [ -d "$config_d" ]; then
	_snap="$RUN_DIR/ls-configd.$$"
	cp -r "$config_d" "$_snap"
fi

log_info "generating config.d" dir="$config_d"
_gen_failed=''
_gen() {
	if ! node_run "$script_dir/$1"; then
		log_warn "generator failed — keeping existing config.d/" generator="$1"
		_gen_failed="$_gen_failed $1"
	fi
}

# --- 1. general layer: always ----------------------------------------------
_gen generate-general.yaml.mjs

# --- 2. local-inference layer: capability-gated -----------------------------
# Requires the container backend (the unified-vulkan image runs llama.cpp
# against the GPU) and at least one dedicated inference device
# (detect_gpu_devs).  Termux has neither, so it always lands in the peers-only
# branch.  LOCAL_INFERENCE=1 forces the layer regardless (it emits
# container-side /root/.cache paths — parity/debug only).
detect_gpu_devs
# shellcheck disable=SC2154  # _workload is set by the sourced lib/workload-runtime.sh
# `workload_has devices` — not a peek at an internal: the devices live in the
# JSON description, and this is the documented way to ask about them.
if [ "$LOCAL_INFERENCE" = 1 ] || { [ "$_workload" = 'workload' ] && workload_has devices; }; then
	_gen generate-local-llm-models.yaml.mjs
	[ -f "$script_dir/launch-gguf.sh" ] &&
		cp -- "$script_dir/launch-gguf.sh" "$config_d/launch-gguf.sh"
	local_layer=yes
else
	rm -f -- "$config_d/10-local-llm-inference.yaml" "$config_d/launch-gguf.sh"
	log_info "no container backend + GPU devices — skipping local-inference layer" \
		serving="peers-only"
fi

# --- 3. cloud peers --------------------------------------------------------
# Every provider is fetched/skipped independently; the generator writes nothing
# (and clears a stale output) when none answer.
_gen generate-peer-cloud.yaml.mjs

# --- 4. gfx1030 peer route (only when not serving locally) ------------------
# A locally-capable host would just self-route, so don't probe it there.
if [ "${local_layer:-}" = 'yes' ]; then
	rm -f -- "$config_d/22-peer-gfx1030.yaml"
elif [ "$GFX1030" = 1 ]; then
	# Probes $PEER_BASE_URL, then the bazzite tailscale URL (no localhost
	# candidates — docs/d022), and keeps the existing file when nothing
	# answers.
	if [ -z "${PEER_BASE_URL:-}" ] && [ -z "${PEER_API_KEY:-}" ]; then
		log_info "no PEER_BASE_URL or PEER_API_KEY — the gfx1030 probe can only try the tailscale candidate; set GFX1030=0 to skip"
	fi
	_gen generate-gfx1030-models.mjs
else
	log_info "GFX1030=0 — skipping the gfx1030 peer probe"
fi

# --- enforce the peer allowlist --------------------------------------------
# llama-swap can only proxy API shapes whose inference endpoints are the
# model-dispatched OpenAI-style paths (see internal/server modelPostJSONRoutes).
# Mistral qualifies for CHAT: pi's mistral-conversations dialect and Mistral's
# native wire format both POST /v1/chat/completions — the peer forwards the
# body verbatim (model-id rewrite + auth swap are shape-agnostic).  Mistral
# endpoints OUTSIDE that path (fim_completions, agents, conversations, ocr)
# are NOT proxied and intentionally so.  Hyper qualifies the same way (pi's
# openai-completions dialect POSTs /v1/chat/completions there).  Google's
# generative REST shape is path-incompatible and stays excluded.  The list is
# curated, NOT
# `Object.keys(PROVIDERS)`: a provider whose entry is added to gen-lib.mjs's
# map but is not actually proxyable here would still be dropped, so this
# gate is the single source of truth for "what we serve as a cloud peer".
if [ -f "$config_d/peer-cloud.yaml" ]; then
	node_run -e '
		const fs = require("fs");
		const f = process.argv[1];
		const ALLOWED = ["openrouter", "opencode", "opencode-go", "cline-pass", "mistral", "hyper"];
		let c = {};
		try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch { process.exit(0); }
		const dropped = Object.keys(c.peers || {}).filter((id) => !ALLOWED.includes(id));
		if (dropped.length) {
			for (const id of dropped) delete c.peers[id];
			fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
			process.stderr.write(JSON.stringify({
				ts: new Date().toISOString(), level: "warn",
				tool: "llm-reverse-proxy/generate",
				msg: "dropped non-proxyable peer(s) (llama-swap cannot proxy these API shapes)",
				peers: dropped,
			}) + "\n");
		}
	' "$config_d/peer-cloud.yaml"
fi

# --- roll back a shrunken peer set ------------------------------------------
# generate-peer-cloud.yaml.mjs removes a stale peer-cloud.yaml when nothing
# answers, so this covers the partial case (1 of N peers missing) — a transient
# reachability-probe failure should not silently shrink the config.
_count_peers() {
	node_run -e 'const fs=require("fs");
		try {
			const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
			process.stdout.write(String(Object.keys(c.peers||{}).length));
		} catch { process.stdout.write("0"); }' "$1"
}
if [ -n "$_snap" ] && [ -f "$_snap/peer-cloud.yaml" ] && [ "$FORCE" != 1 ]; then
	_new_peers="$(_count_peers "$config_d/peer-cloud.yaml")"
	_old_peers="$(_count_peers "$_snap/peer-cloud.yaml")"
	if [ "${_new_peers:-0}" -lt "${_old_peers:-0}" ]; then
		log_warn "peer set shrank (a reachability probe probably failed) — restoring the previous config.d/; re-run with FORCE=1 to accept the smaller set" \
			before="${_old_peers:-0}" after="${_new_peers:-0}"
		rm -rf "$config_d"
		mv "$_snap" "$config_d"
		_snap=""
	fi
fi
[ -n "$_snap" ] && rm -rf "$_snap"

# --- verify + report --------------------------------------------------------
if [ ! -d "$config_d" ]; then
	log_die 94 "config.d not generated" dir="$config_d"
fi
_peers="$(_count_peers "$config_d/peer-cloud.yaml")"
if [ -n "$_gen_failed" ]; then
	# Say so instead of presenting a stale config as fresh: a failed generator
	# writes nothing, so whatever config.d/ holds is from an earlier run.
	log_warn "config.d NOT regenerated — listed files may be stale" \
		failed="$_gen_failed" dir="$config_d"
else
	log_info "config.d ready" dir="$config_d" cloudPeers="${_peers:-0}"
fi
ls -- "$config_d"
