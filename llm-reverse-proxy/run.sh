#!/bin/sh
# run.sh — multipurpose llama-swap launcher (container hosts AND Termux),
# merged from the former run.sh (container sandbox) and run-termux.sh (native
# Termux orchestrator).  One file, profile-detected at runtime.  The
# native-vs-sandboxed split is a real *backend* difference (container image
# vs. native binary) — not an env-loading one, which is already unified via
# the shared load_secrets (lib/workload-runtime.sh).
#
#   container (_workload=container): podman/docker, image + GPU passthrough +
#                                   HF-cache mounts, via the declarative
#                                   sandbox API.
#   native     (Termux):            build the android/arm64 binary if missing,
#                                   then exec run-native.sh (the native serve
#                                   leaf).
#
# Port model: the instance publishes LAN port ${HOST_PORT:-8080}; the world
# reaches it through the tailscale FQDN reverse proxy (normal https port),
# which forwards to 8080.  The legacy local-inference port 18080 is
# DEPRECATED — nothing listens on it; peers still pointing at localhost:18080
# must move to 8080.
#
# Env overrides:
#   GENERATE    1 = regenerate config.d first (./generate.sh)
#   BACKGROUND  1 = native path: nohup + pid file in $RUN_DIR
#   LISTEN      native listen addr (default :8080; honoured by run-native.sh)
#   HOST_PORT   container published port (default 8080)
#   LLAMA_SWAP_IMAGE / LLAMA_SWAP_BIN   container image / native binary path
#   RUN_DIR     pid-file/snapshot dir (native; default ${TMPDIR:-$PREFIX/tmp})

set -eu
# shellcheck disable=SC1091
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/run'
export LOG_TOOL

case "${PREFIX:-}" in
	*/com.termux/*) _termux=1 ;;
	*) _termux=0 ;;
esac

script_dir="$(cd "$(dirname "$0")" && pwd)"
config_d="$script_dir/config.d"
RUN_DIR="${RUN_DIR:-${TMPDIR:-${PREFIX:+$PREFIX/tmp}}}"
RUN_DIR="${RUN_DIR:-/tmp}"
HOST_PORT="${HOST_PORT:-8080}"
LISTEN="${LISTEN:-:8080}"
export LISTEN

[ -d "$config_d" ] ||
	log_die 94 "config.d not found — generate it first with ./generate.sh" dir="$config_d"

# Secrets via the shared load_secrets (see ../lib/workload-runtime.sh): ONE in-memory
# vault round-trip, loaded here so the workload_env allowlist (container path)
# or the native process environment (native path) picks the values straight out
# of the loaded environment.  Generators must have run first (./generate.sh)
# with the same helper, so their probes saw the same keys.
load_secrets
log_info "secrets source" source="${SECRETS_SOURCE:-none}"

# shellcheck disable=SC2154  # _workload is set by the sourced lib/workload-runtime.sh
if [ "$_workload" = 'workload' ]; then
	# ========================= container backend =========================
	if [ -z "${OPENCODE_API_KEY:-}" ] && [ -z "${OPENROUTER_API_KEY:-}" ] \
		&& [ -z "${CLINE_API_KEY:-}" ] && [ -z "${PEER_API_KEY:-}" ]; then
		log_warn 'no provider keys loaded — peer-cloud env refs will not resolve'
	fi

	HF_HUB_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/huggingface/hub"
	container_id='llama-swap'

	if [ -f "$config_d/10-local-llm-inference.yaml" ]; then
		image='ghcr.io/mostlygeek/llama-swap:unified-vulkan'
		local_layer=yes
	else
		image="${LLAMA_SWAP_IMAGE:-ghcr.io/mostlygeek/llama-swap:cpu}"
		local_layer=no
	fi
	log_info "serving mode" \
		mode="$([ "$local_layer" = yes ] && printf 'local-inference+peers' || printf 'peers-only')" \
		image="$image" port="$HOST_PORT"

	workload_rm "$container_id"
	workload_name     "$container_id"
	workload_image    "$image"
	workload_detach
	workload_init
	workload_publish  "$HOST_PORT" 8080
	workload_user
	if [ "$local_layer" = yes ]; then
		workload_gpu
		workload_rw "$HF_HUB_CACHE" /root/.cache/huggingface/hub
		workload_rw "$HF_HUB_CACHE" /home/ubuntu/.cache/huggingface/hub
	fi
	workload_ro       "$config_d" /etc/llama-swap/config.d
	workload_hardening
	# HF_TOKEN is only consumed by the local layer (launch-gguf.sh download
	# fallback); the provider keys are referenced by ${env.*} in
	# peer-cloud.yaml.  Values come from load_secrets above — no per-step vault
	# calls, no ambient host-env forwarding beyond this explicit allowlist.
	workload_env      HF_TOKEN
	workload_env      OPENCODE_API_KEY
	workload_env      OPENROUTER_API_KEY
	workload_env      PEER_API_KEY
	workload_env      CLINE_API_KEY
	workload_entrypoint 'llama-swap'
	workload_cmd      -config-dir /etc/llama-swap/config.d -listen 0.0.0.0:8080
	# No infisical wrapper here: the keys were loaded once via load_secrets and
	# are forwarded through the workload_env allowlist above.
	workload_run

	sleep 5
	workload_logs "$container_id" | head
elif [ "$_termux" = 1 ]; then
	# ========================= native backend ===========================
	# Termux has no usable container runtime, so serve the native
	# android/arm64 llama-swap binary.  run-native.sh owns the actual serve
	# invocation (the only way this repo runs llama-swap without a container);
	# this branch only adds what it deliberately leaves out: generate-first,
	# build-binary-if-missing, native_stop (stop previous instance + cleanup,
	# the native analogue of the container path's `workload_rm`), and
	# background/pid-file.
	BIN="${LLAMA_SWAP_BIN:-$HOME/mostlygeek/llama-swap/llama-swap}"
	mkdir -p "$RUN_DIR"

	# native_stop — stop any previous native llama-swap instance so this run
	# can take the port.  Mirrors the container path's `workload_rm
	# "$container_id"` (which removes a stale container by name before `run`).
	# Native has no container name, so we key off the pid-file the BACKGROUND
	# path writes, and additionally sweep any llama-swap process serving the
	# same config.d (covers foreground runs, which don't write a pid-file
	# until launch).  Matching on BOTH the binary path and config.d avoids
	# killing unrelated processes (e.g. a `go build -o $BIN` step).
	native_stop() {
		_pidf="$RUN_DIR/llama-swap.pid"
		if [ -f "$_pidf" ]; then
			_old="$(cat "$_pidf" 2>/dev/null || true)"
			case "$_old" in
				''|*[!0-9]*) : ;;
				*)
					if kill -0 "$_old" 2>/dev/null; then
						log_info "stopping previous instance (pid-file)" pid="$_old"
						kill "$_old" 2>/dev/null || true
						_n=0
						while kill -0 "$_old" 2>/dev/null && [ "$_n" -lt 10 ]; do
							_n=$((_n + 1)); sleep 0.5
						done
						kill -0 "$_old" 2>/dev/null && kill -9 "$_old" 2>/dev/null || true
					fi
					;;
			esac
			rm -f "$_pidf"
		fi
		if command -v pgrep >/dev/null 2>&1; then
			for _p in $(pgrep -f "$BIN" 2>/dev/null || true); do
				case "$_p" in *[!0-9]*) continue ;; esac
				[ "$_p" = "$$" ] && continue
				tr '\0' ' ' <"/proc/$_p/cmdline" 2>/dev/null | grep -qF -- "$config_d" \
					&& { log_info "stopping stray instance (cmdline match)" pid="$_p"; kill "$_p" 2>/dev/null || true; }
			done
		fi
	}
	native_stop

	if [ "${GENERATE:-0}" = 1 ]; then
		[ -n "${MODELS_DEV_JSON:-}" ] && export MODELS_DEV_JSON
		[ -n "${GFX1030:-}" ] && export GFX1030
		[ -n "${REFRESH_MODELS_DEV:-}" ] && export REFRESH_MODELS_DEV
		sh "$script_dir/generate.sh"
	fi

	if [ ! -x "$BIN" ]; then
		log_info "binary missing — building via ./build.sh" bin="$BIN"
		sh "$script_dir/build.sh" || log_die 95 "build.sh failed"
	fi

	log_info "serving via run-native.sh" path="$script_dir/run-native.sh"
	if [ "${BACKGROUND:-0}" = 1 ]; then
		nohup sh "$script_dir/run-native.sh" >/dev/null 2>&1 &
		_pid=$!
		echo "$_pid" >"$RUN_DIR/llama-swap.pid"
		log_info "serving in background; logs discarded" pid="$_pid" pidFile="$RUN_DIR/llama-swap.pid"
	else
		echo "$$" >"$RUN_DIR/llama-swap.pid"
		exec sh "$script_dir/run-native.sh"
	fi
else
	log_die 91 "no container tool (podman/docker) and not on termux — nothing to run"
fi
