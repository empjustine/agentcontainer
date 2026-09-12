#!/bin/sh
# Native-tool provisioning for hosts without official release binaries or
# package coverage (Termux/Android primarily).  Installs the Infisical CLI and
# the two tools the rest of the tree needs that Termux can only get from `pkg`
# (nodejs, jq).
#
# THE CLI — `go install` (upstream ships a main.go at the repo root on main):
#
#   go install github.com/Infisical/cli@main
#
# which drops the binary into $GOBIN/$GOPATH/bin/infisical (on GOFLAGS/GOPATH
# defaults: $HOME/go/bin).  No clone, no checkout refresh, no local build
# state — this replaced the former clone-into-~/Infisical/cli + `go build .`
# maintenance (git pull chore, diverged-checkout resets).  Run this once,
# then `infisical login`; the environment chain (lib/environment.sh) and
# every secret consumer in the tree work unchanged.
#
# --- ANDROID EXCEPTION: the checkout build (kept, automatic fallback) ------
# `go install` FAILS at LINK time on Android/arm64 with Go >= 1.23:
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
# android/arm64, ~1 GB RAM: `go build -p=1 -mod=mod -ldflags="..." .` of a
# checkout produces the working binary.  So on Termux the script falls back
# to the old checkout build automatically when `go install` fails:
#
#   clone https://github.com/Infisical/cli.git ->  ~/Infisical/cli
#   go build -ldflags="-checklinkname=0 …" .    ->  ~/Infisical/cli/infisical
#
# The checkout is kept aligned with upstream (git pull --ff-only on every
# run; a failed pull is a warning — the existing checkout is still used).
#
# CONSUMPTION: lib/environment.sh (the explicit chain every secret consumer
# is exec'd through) resolves the binary in this order: $INFISICAL_BIN ›
# ~/Infisical/cli/infisical (the checkout build below) › PATH › mise.  The
# chain is deliberately passive: it only consumes whatever binary this script
# produced, never builds anything itself, and dies with instructions pointing
# back at this script when no binary is found.
#
# Idempotent: does nothing when a binary is already resolvable
# (FORCE=1 to (re)build anyway).
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
#   nodejs -> node   the .mjs generators (llm-local-inference/generate.sh,
#                    coding-agent/generate.sh) run under the SYSTEM node on
#                    Termux — there is no mise to pin one.
#   jq               lib/workload-runtime.sh's workload description API is jq-backed
#                    (lib/workload-*.jq); llm-local-inference/generate.sh calls
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

# --- 1. the CLI: go install (checkout build as the Android fallback) -------
if [ -x "$bin" ] && [ "${FORCE:-0}" != 1 ]; then
	log_info "infisical binary present — nothing to build" bin="$bin"
	exit 0
fi

command -v go >/dev/null 2>&1 || log_die 96 \
	"go toolchain not found (on Termux: pkg install golang)"

# Primary path: `go install` — upstream ships main.go at the repo root, so
# this needs NO clone and NO local build state (see the header).  The binary
# lands in GOBIN/GOPATH bin ($HOME/go/bin by default).
log_info "go install infisical CLI (primary path)"
if go install github.com/Infisical/cli@main; then
	_installed="${GOBIN:-$(go env GOPATH 2>/dev/null)/bin}/infisical"
	if [ -x "$_installed" ]; then
		log_info "installed infisical CLI" path="$_installed" how="go install github.com/Infisical/cli@main"
		exit 0
	fi
	log_warn "go install reported success but the binary is not at the expected path" path="$_installed"
else
	log_warn "go install failed — falling back to the checkout build (the Android -checklinkname=0 path; see the header)"
fi

# Fallback (Android-only in practice): the clone + flags build.  Idempotent
# clone/refresh; a diverged checkout is a warning, not a fatal (delete
# ~/Infisical/cli and re-run for a fresh one).
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

# Flags — see "ANDROID EXCEPTION" in this file's header:
#   -checklinkname=0  THE fix: re-enables anet's linkname to net.zoneCache,
#                     which Go >= 1.23 rejects on Android (the only platform
#                     this source build is needed for in this tree)
#   -s -w             strip debug info -> less linker RAM on ~1 GB devices
#   -p=1 / GOGC=50    cap parallelism / GC pressure -> avoid OOM
#   -mod=mod          tolerate go.mod drift after an upstream pull
log_info "building infisical CLI (checkout fallback)" src="$src" bin="$bin"
GOGC=50 go build -C "$src" -p=1 -mod=mod \
	-ldflags="-checklinkname=0 -s -w" -o "$bin" .
chmod 0755 "$bin"
log_info "built infisical CLI" bin="$bin" branch="$branch"