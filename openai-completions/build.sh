#!/bin/sh
# shellcheck disable=SC1091
. "$(dirname "$0")/../container-tool.sh"

# Build/prepare llama-swap for THIS host, matching how it will be served:
#
#   - NOT on Termux (no /data/data/com.termux/files prefix): pull the
#     container image run.sh will use — unified-vulkan when config.d carries
#     the local GGUF layer, otherwise the lighter :cpu (LLAMA_SWAP_IMAGE
#     overrides in peers-only mode, same rule as run.sh).  The OCI workflow
#     means there is nothing to compile here.
#   - ON Termux (termux $PREFIX exists): there is no usable container
#     runtime, so build the native android/arm64 llama-swap binary into
#     ~/ls-build/llama-swap-termux (cloning ~/llama-swap if needed) for
#     run-native.sh.  GOOS=android (not linux) is required so the binary uses
#     Android's system DNS resolver instead of the missing /etc/resolv.conf.

termux_prefix=/data/data/com.termux/files

# shellcheck disable=SC2154  # _sandbox/_container_tool are set by the sourced container-tool.sh
if [ -d "$termux_prefix" ]; then
	# --- Termux: native build --------------------------------------------
	bin="${LLAMA_SWAP_BIN:-$HOME/ls-build/llama-swap-termux}"
	src="${LLAMA_SWAP_SRC:-$HOME/llama-swap}"
	[ -d "$src" ] || git clone https://github.com/mostlygeek/llama-swap.git "$src"
	mkdir -p -- "$(dirname -- "$bin")"
	CGO_ENABLED=0 GOOS=android GOARCH=arm64 GOGC=50 \
		go build -p=2 -trimpath -ldflags="-s -w" -o "$bin" "$src"
	printf "built %s — serve it with ./run-native.sh\n" "$bin"
else
	# --- container hosts: pre-pull the image run.sh will use -------------
	config_d="$SCRIPT_DIR/config.d"
	if [ -f "$config_d/10-local-llm-inference.yaml" ]; then
		image='ghcr.io/mostlygeek/llama-swap:unified-vulkan'
	else
		image="${LLAMA_SWAP_IMAGE:-ghcr.io/mostlygeek/llama-swap:cpu}"
	fi
	[ "$_sandbox" = 'container' ] || {
		>&2 printf "fatal: no container tool (podman/docker) and not on termux — nothing to build/pull\n"
		exit 91
	}
	"$_container_tool" image pull "$image"
	printf "pulled %s — serve it with ./run.sh\n" "$image"
fi
