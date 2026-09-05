#!/bin/sh
# build.sh — prepare llama-swap for THIS host, matching how it will be served.
# Dual mode, detected from the environment (not a flag):
#
#   - ON Termux (termux $PREFIX exists): there is no usable container
#     runtime, so build the native android/arm64 llama-swap binary into
#     ~/mostlygeek/llama-swap/llama-swap (same ~/<org>/<repo> +
#     in-checkout-binary convention as infisical via the repo's root
#     ./build.sh).  The checkout is refreshed from upstream on every run
#     (clone if absent, git pull --ff-only otherwise) and the build skips
#     when the binary exists (FORCE=1 to rebuild after a pull).  GOOS=android
#     (not linux) is required so the binary uses Android's system DNS
#     resolver instead of the missing /etc/resolv.conf.  Serve the result
#     with ./run-native.sh.
#   - NOT on Termux (no /data/data/com.termux/files prefix): pull the
#     container image run.sh will use — unified-vulkan when config.d carries
#     the local GGUF layer, otherwise the lighter :cpu (LLAMA_SWAP_IMAGE
#     overrides in peers-only mode, same rule as run.sh).  The OCI workflow
#     means there is nothing to compile here.  Serve the result with ./run.sh.
#
# Idempotent by design: repeat runs are cheap no-ops (skip-if-present on the
# binary, otherwise a no-op image pull), which is what makes run.sh's
# "binary missing -> build.sh" flow safe to leave in place.
#
# Env overrides: LLAMA_SWAP_SRC / LLAMA_SWAP_BIN / LLAMA_SWAP_BRANCH /
# LLAMA_SWAP_IMAGE / FORCE.  Termux needs the go toolchain:
# `pkg install golang`.

# shellcheck disable=SC1091
. "$(dirname "$0")/../container-tool.sh"
LOG_TOOL='openai-completions/build'
export LOG_TOOL

set -eu

termux_prefix=/data/data/com.termux/files

# shellcheck disable=SC2154  # _sandbox/_container_tool are set by the sourced container-tool.sh
if [ -d "$termux_prefix" ]; then
	# --- Termux: native build --------------------------------------------
	src="${LLAMA_SWAP_SRC:-$HOME/mostlygeek/llama-swap}"
	bin="${LLAMA_SWAP_BIN:-$src/llama-swap}"
	branch="${LLAMA_SWAP_BRANCH:-main}"
	# Checkout: clone if absent, otherwise refresh from upstream so the build
	# (and any FORCE=1 rebuild) matches upstream.  A failed pull is a warning,
	# not fatal — the existing checkout is still used.
	if [ -e "$src" ]; then
		if [ -d "$src/.git" ]; then
			log_info "refreshing checkout" src="$src" branch="$branch"
			git -C "$src" pull --ff-only origin "$branch" || \
				log_warn "pull failed — building the existing checkout" src="$src"
			# --ff-only refuses a diverged checkout: that is the one case this
			# script cannot fix itself — `rm -rf "$src"` and re-run for a fresh
			# shallow clone.
		else
			log_warn "checkout dir is not a git clone — skipping pull" src="$src"
		fi
	else
		log_info "cloning" src="$src"
		mkdir -p -- "$(dirname -- "$src")"
		git clone --depth=1 --branch "$branch" \
			https://github.com/mostlygeek/llama-swap.git "$src"
	fi
	if [ -x "$bin" ] && [ "${FORCE:-0}" != 1 ]; then
		log_info "llama-swap binary present — nothing to build" bin="$bin"
		exit 0
	fi
	command -v go >/dev/null 2>&1 ||
		log_die 96 "go toolchain not found (on Termux: pkg install golang)"
	mkdir -p -- "$(dirname -- "$bin")"
	# GOOS=android (NOT linux) is critical on Termux: an android-targeted
	# binary uses Android's system DNS resolver instead of the missing
	# /etc/resolv.conf.  A linux-targeted binary falls back to localhost:53,
	# which fails here.  GOGC=50 / -p=2 cap memory on ~1 GB devices; -s -w
	# strips debug info (less linker RAM).
	CGO_ENABLED=0 GOOS=android GOARCH=arm64 GOGC=50 \
		go build -p=2 -trimpath -ldflags="-s -w" -o "$bin" "$src"
	log_info "built native llama-swap; serve it with ./run-native.sh" bin="$bin"
else
	# --- container hosts: pre-pull the image run.sh will use -------------
	config_d="$SCRIPT_DIR/config.d"
	if [ -f "$config_d/10-local-llm-inference.yaml" ]; then
		image='ghcr.io/mostlygeek/llama-swap:unified-vulkan'
	else
		image="${LLAMA_SWAP_IMAGE:-ghcr.io/mostlygeek/llama-swap:cpu}"
	fi
	[ "$_sandbox" = 'container' ] || {
		log_die 91 "no container tool (podman/docker) and not on termux — nothing to build/pull"
	}
	"$_container_tool" image pull "$image"
	log_info "pulled image; serve it with ./run.sh" image="$image"
fi
