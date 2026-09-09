#!/bin/sh
# Native-tool provisioning for hosts without official release binaries or
# package coverage (Termux/Android primarily).  Builds the Infisical CLI from
# source when the binary is missing, and installs the two tools the rest of the
# tree needs that Termux can only get from `pkg` (nodejs, jq).
#
# WHY SOURCE-BUILT AT ALL: the Infisical CLI has NO official Android release
# and no Termux package, so on Termux it has to be compiled here.  Run this
# once after `pkg install golang`, then `infisical login`; afterwards every
# secret consumer in the tree works unchanged (see load_secrets below).
#
# TERMUX PREREQUISITES handled by this script (see the block below): `pkg
# install nodejs` and `pkg install jq`, each gated on an -x probe of
# $PREFIX/bin/<tool>.  golang is deliberately left to the caller — it is only
# needed when the CLI actually has to be compiled, so a host that already has
# the binary should not pay for the toolchain.
#
# Same ~/<org>/<repo> + in-checkout-binary convention as the llama-swap Termux
# branch of llm-reverse-proxy/build.sh:
#
#   clone https://github.com/Infisical/cli.git ->  ~/Infisical/cli
#   go build .                                  ->  ~/Infisical/cli/infisical
#
# --- WHY THESE BUILD FLAGS (the -checklinkname=0 story) -------------------
# A plain `go build .` fails at LINK time — compilation succeeds — on
# Android/arm64 with Go >= 1.23:
#
#   link: github.com/wlynxg/anet: invalid reference to net.zoneCache
#
# Dependency chain (confirmed with `go mod why -m github.com/wlynxg/anet`):
#
#   Infisical/infisical-merge/packages/gateway
#     -> pion/turn/v4
#     -> pion/transport/v3/stdnet
#     -> wlynxg/anet v0.0.5     (indirect dep in go.mod)
#
# anet is a fork of Go's `net` package that works around Android's NETLINK
# restrictions (Go issue #40569): on Android, net.Interfaces() /
# net.InterfaceAddrs() panic with "route ip+net: netlinkrib: permission
# denied", so anet drops the netlink Bind() and enumerates via ioctl instead.
# To reuse the stdlib internals it aliases an unexported symbol:
#
#   //go:linkname zoneCache net.zoneCache
#   var zoneCache ipv6ZoneCache
#
# That line lives ONLY in anet's interface_android.go — the sole anet file
# using //go:linkname — which is why the failure is ANDROID-SPECIFIC and
# upstream's Linux CI never hits it.  Since Go 1.23 the linker rejects
# //go:linkname references to symbols that have not declared themselves
# linkable (the -checklinkname check).  Upgrading is not an option: anet's
# latest release is still v0.0.5 and no pion/transport/v3 version drops it —
# so a LINKER FLAG is the fix (the anet README documents the same flag).
#
# Verified on Termux/Android (aarch64, bionic libc, no root), Go 1.27.0
# android/arm64, ~1 GB RAM: `go build -p=1 -mod=mod -ldflags="..." .` produces
# the root infisical binary, and the same invocation with ./... (full module,
# incl. packages/gateway) exits 0.
#
# If these flags ever need to travel elsewhere: upstream's .goreleaser.yaml,
# .goreleaser-darwin.yaml and .goreleaser-windows.yaml each carry an `ldflags`
# list — an Android goreleaser run would need -checklinkname=0 added there
# too.  Upstream will not hit this on Linux CI, so don't wait for a fix.
#
# The checkout is kept aligned with upstream: every run refreshes an existing
# checkout (`git pull --ff-only origin main`) so whatever gets built matches
# upstream.  A failed pull (offline / diverged) is a warning, not a fatal —
# the existing checkout is still used.  To reset a diverged checkout, delete
# it (`rm -rf ~/Infisical/cli`) and re-run for a fresh shallow clone.
#
# CONSUMPTION: load_secrets (lib/workload-runtime.sh) looks for the binary at the
# resolved location above and every secret consumer
# (llm-reverse-proxy/generate.sh, run.sh, run-native.sh, coding-agent/…)
# inherits it from there.  load_secrets is deliberately passive: it only
# consumes whatever binary this script produced, never builds anything itself,
# and warns pointing back at this script when the binary is absent.
#
# Idempotent build: does nothing when the binary is already executable
# (FORCE=1 to rebuild after a pull).
#
# Env overrides:
#   INFISICAL_SRC   checkout dir     (default $HOME/Infisical/cli)
#   INFISICAL_BIN   output binary    (default $src/infisical)
#   INFISICAL_URL   clone source     (default https://github.com/Infisical/cli.git)
#   INFISICAL_BRANCH upstream branch (default main)
#   FORCE           1 = rebuild even when the binary exists
#   SKIP_PKG        1 = report missing node/jq but never `pkg install` them
#                       (offline hosts; the CLI build needs neither)

set -eu

# shellcheck disable=SC1091
. "$(dirname "$0")/lib/log.sh"
LOG_TOOL='build'
export LOG_TOOL

src="${INFISICAL_SRC:-$HOME/Infisical/cli}"
bin="${INFISICAL_BIN:-$src/infisical}"
url="${INFISICAL_URL:-https://github.com/Infisical/cli.git}"
branch="${INFISICAL_BRANCH:-main}"

# --- Termux prerequisites: nodejs and jq -----------------------------------
# Termux has no mise, so the two tools the rest of the tree needs that cannot
# be provisioned any other way here come from `pkg`:
#
#   nodejs -> node   the .mjs generators (llm-reverse-proxy/generate.sh,
#                    coding-agent/generate.sh) run under the SYSTEM node on
#                    Termux — there is no mise to pin one.
#   jq               lib/workload-runtime.sh's workload description API is jq-backed
#                    (lib/workload-*.jq); llm-reverse-proxy/generate.sh calls
#                    sandbox_has on every run.
#
# Probed with -x at $PREFIX/bin — the directory `pkg` installs into — so the
# test answers the question that matters here ("is the pkg-provided tool
# present?") rather than "is there one somewhere on PATH?".
#
# Non-Termux hosts are untouched: there both come from mise, and running `pkg`
# outside Termux would be wrong.
#
# SKIP_PKG=1 opts out (e.g. offline): the -x result is still reported, but a
# missing tool never blocks the CLI build — the build needs neither node nor
# jq, and an offline host may well have a checkout it can still compile.
case "${PREFIX:-}" in
	*/com.termux/*) _termux=1 ;;
	*) _termux=0 ;;
esac

# _ensure_pkg <binary> <pkg name> <why the tree needs it> — Termux only.
_ensure_pkg() {
	_need_bin="$1"; _need_pkg="$2"; _need_why="$3"
	_need_path="$PREFIX/bin/$_need_bin"
	if [ -x "$_need_path" ]; then
		log_info "prerequisite present" bin="$_need_bin" path="$_need_path"
		return 0
	fi
	log_warn "prerequisite missing" bin="$_need_bin" pkg="$_need_pkg" \
		why="$_need_why"
	if [ "${SKIP_PKG:-0}" = 1 ]; then
		log_warn "SKIP_PKG=1 — not installing (the CLI build does not need it)" \
			bin="$_need_bin"
		return 0
	fi
	command -v pkg >/dev/null 2>&1 ||
		log_die 97 "Termux pkg not found — cannot install $_need_bin" \
			bin="$_need_bin" why="$_need_why"
	log_info "installing prerequisite via pkg" bin="$_need_bin" pkg="$_need_pkg"
	pkg install -y "$_need_pkg" ||
		log_die 97 "pkg install failed" pkg="$_need_pkg" bin="$_need_bin"
	[ -x "$_need_path" ] ||
		log_die 97 "still missing after pkg install" bin="$_need_bin" \
			path="$_need_path" why="$_need_why"
	log_info "prerequisite installed" bin="$_need_bin" path="$_need_path"
}

if [ "$_termux" = 1 ]; then
	_ensure_pkg node nodejs 'the .mjs generators run under the system node here'
	_ensure_pkg jq jq 'lib/workload-runtime.sh workload_* API (lib/workload-*.jq)'
else
	log_debug "not Termux — skipping pkg provisioning (node/jq come from mise)"
fi

# --- checkout: clone if absent, otherwise refresh from upstream -----------
if [ -e "$src" ]; then
	if [ -d "$src/.git" ]; then
		log_info "refreshing checkout" src="$src" branch="$branch"
		git -C "$src" pull --ff-only origin "$branch" || \
			log_warn "pull failed — building the existing checkout" src="$src"
	else
		log_warn "checkout dir is not a git clone — skipping pull" src="$src"
	fi
else
	mkdir -p -- "$(dirname -- "$src")"
	log_info "cloning" url="$url" src="$src"
	git clone --depth=1 --branch "$branch" "$url" "$src"
fi

if [ -x "$bin" ] && [ "${FORCE:-0}" != 1 ]; then
	log_info "infisical binary present — nothing to build" bin="$bin"
	exit 0
fi

command -v go >/dev/null 2>&1 || log_die 96 \
	"go toolchain not found (on Termux: pkg install golang)"

# Flags — see "WHY THESE BUILD FLAGS" in this file's header:
#   -checklinkname=0  THE fix: re-enables anet's linkname to net.zoneCache,
#                     which Go >= 1.23 rejects on Android (the only platform
#                     this source build is needed for in this tree)
#   -s -w             strip debug info -> less linker RAM on ~1 GB devices
#   -p=1 / GOGC=50    cap parallelism / GC pressure -> avoid OOM
#   -mod=mod          tolerate go.mod drift after an upstream pull
log_info "building infisical CLI" src="$src" bin="$bin"
GOGC=50 go build -C "$src" -p=1 -mod=mod \
	-ldflags="-checklinkname=0 -s -w" -o "$bin" .
chmod 0755 "$bin"
log_info "built infisical CLI" bin="$bin" branch="$branch"