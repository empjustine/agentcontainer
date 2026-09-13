#!/bin/sh
# build.sh — build llm-reverse-proxy for how THIS host will run it, llama-swap
# style (dual mode, detected from the environment — not a flag):
#
#   - Termux (termux $PREFIX): no container runtime, so build the native
#     android/arm64 binary.  GOOS=android (NOT linux) is required: an
#     android-targeted binary uses Android's system DNS resolver instead of
#     the missing /etc/resolv.conf — a linux binary falls back to
#     localhost:53, which fails there.  Output: ./llm-reverse-proxy-android;
#     serve with ./run.sh (native branch).  Needs the go toolchain:
#     `pkg install golang`.
#   - Container host: build ONLY the OCI image ./run.sh uses — a MULTI-STAGE
#     Containerfile (golang builder → distroless/static runtime, which ships
#     the CA bundle the proxy's upstream TLS verification requires), so the
#     compile happens INSIDE the image build and this host needs NO go
#     toolchain, just podman/docker.  The host binary ./smoke-test.sh needs is
#     built by smoke-test.sh itself (only when go is available).
#   - Neither (bare host, no container tool): the host binary only — needs go.
#
# Idempotent: the image and the android binary are skipped when already
# present (FORCE=1 rebuilds both).
#
# Env overrides: IMAGE_TAG / FORCE / GOFLAGS.

# shellcheck disable=SC1091
. "$(dirname "$0")/../lib/workload-runtime.sh"
LOG_TOOL='llm-reverse-proxy/build'
export LOG_TOOL

set -eu

script_dir="$SCRIPT_DIR"
cd "$script_dir"

# go from PATH, or the mise shims (sandbox/toolbox hosts without a login
# shell). Only the NATIVE compile branches require it — the container image
# branch compiles inside the multi-stage Containerfile and never touches a
# host toolchain (see the header).
#
# A `command -v go` hit is NOT proof of a toolchain: mise installs (or
# activates) a `go` shim even when NO go version is set, the shim answers
# every PATH lookup, and only fails once invoked — "mise ERROR No version is
# set for shim: go" — which under `set -e` would kill this script mid-build
# (observed on the rootless-podman bazzite host). So probe the toolchain
# itself: only a `go version` that actually executes counts as ready. A
# mise-managed host that wants the host binary can provision one with
# `mise use -g go@1.27` (the Containerfile's builder version).
_go_ready() {
	command -v go >/dev/null 2>&1 ||
		export PATH="$HOME/.local/share/mise/shims:$PATH"
	command -v go >/dev/null 2>&1 || return 1
	go version >/dev/null 2>&1
}

# shellcheck disable=SC2154  # _termux/_workload/_workload_tool from the sourced lib
if [ "$_termux" = 1 ]; then
	# --- Termux: native android/arm64 binary --------------------------------
	_go_ready || log_die 96 "no working go toolchain (on Termux: pkg install golang)"
	if [ -x llm-reverse-proxy-android ] && [ "${FORCE:-0}" != 1 ]; then
		log_info "android binary present — nothing to build" path="$script_dir/llm-reverse-proxy-android"
	else
		# GOOS=android, NOT linux: see header.  GOGC/-p cap memory on ~1 GB
		# devices; CGO stays off so no NDK is needed.
		CGO_ENABLED=0 GOOS=android GOARCH=arm64 GOGC=50 \
			go build -p=2 -trimpath -ldflags='-s -w' -o llm-reverse-proxy-android .
		log_info "built native android binary; serve it with ./run.sh" path="$script_dir/llm-reverse-proxy-android"
	fi
elif [ "$_workload" = 'workload' ]; then
	# --- container host: OCI image (multi-stage — NO host go needed) --------
	image="${IMAGE_TAG:-localhost/llm-reverse-proxy:latest}"
	if "$_workload_tool" image inspect "$image" >/dev/null 2>&1 &&
		[ "${FORCE:-0}" != 1 ]; then
		log_info "image present — nothing to build" image="$image"
	else
		"$_workload_tool" build -f "$script_dir/Containerfile" -t "$image" "$script_dir"
		log_info "built image; serve it with ./run.sh" image="$image"
	fi
else
	# --- bare host, no container tool: the host binary is the product -------
	_go_ready || log_die 96 "no working go toolchain (it compiles the host binary — the only thing this host can serve; mise hosts: mise use -g go@1.27)"
	CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o llm-reverse-proxy .
	log_info "built host binary; serve it directly: ./llm-reverse-proxy -config llm-reverse-proxy.json" path="$script_dir/llm-reverse-proxy"
fi
