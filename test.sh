#!/bin/sh
# test.sh — the repo-wide test sweep (docs/d113).
#
# WHAT IT IS: the maintainer's view across the copy units, not a library any
# unit consumes. Since docs/d113 every test lives with the code it tests —
# `<unit>/tests/` — and each of those runs standalone from its own folder
# (`. ./<unit>/lib/node-run.sh && node_run --test <unit>/tests/*.test.mjs`).
# This script exists for the one thing a single unit cannot do: run them all at
# once, in every folder, and report one verdict. It owns no test of its own —
# the last one (docs/d050's committed-manifest guard) moved to
# coding-agent/tests/ when d108 left it with a single unit to check.
#
# The globs are the contract: a new `*/tests/*.test.mjs` or `*/tests/*.sh` is
# picked up without editing this file, so a unit cannot add a test that the
# sweep silently skips.
#
# estige is the one exception to "tests are files the globs can see": its suite
# is Go and in-package (`estige/*_test.go`), so it is run explicitly below. That
# leg used to be missing entirely — the egress parser's refusal cases were red
# on `go test ./...` while the sweep stayed green, which is how a broken test sat
# in the tree unnoticed.
#
# Usage: ./test.sh   (from any directory)

set -eu

# shellcheck disable=SC1091  # repo-root operator files, resolved from $0
. "$(dirname "$0")/log.sh"
LOG_TOOL='test'
export LOG_TOOL

root="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
cd "$root"
# shellcheck disable=SC1091  # repo-pinned interpreter selection (node_run)
. ./node-run.sh

log_info "unit tests (node --test: every */tests/)"
node_run --test ./*/tests/*.test.mjs

# Go toolchain detection follows estige/lib/go-build.mjs, and for the same
# reason: on a sandbox/toolbox host the mise shims are off PATH, while a shim
# being *present* is not proof of a toolchain (`go version` is the only proof).
# `mise where` is the third probe and a deliberate one: it answers only for an
# ALREADY-installed toolchain, so a host that never had go skips instead of
# pulling one down mid-sweep. A host with no go skips this leg loudly rather
# than failing the sweep — the suite is real, but a laptop with no Go cannot be
# asked to run it.
log_info "estige Go suite (in-package tests, needs a go toolchain)"
if command -v mise >/dev/null 2>&1; then
	if _goroot=$(mise where go 2>/dev/null); then
		PATH="$_goroot/bin:$PATH"
	fi
fi
if [ "${HOME:-}" != "" ] && [ -d "$HOME/.local/share/mise/shims" ]; then
	PATH="$HOME/.local/share/mise/shims:$PATH"
fi
export PATH
if command -v go >/dev/null 2>&1 && go version >/dev/null 2>&1; then
	(
		cd estige
		CGO_ENABLED=0 go test ./...
	)
else
	log_warn "skipped — no working go toolchain" hint="mise install go@1.27"
fi

# The sweep owns no test of its own and no unit has to ship a shell one: a
# folder that moved its checks into *.test.mjs leaves this glob unmatched, and
# an unmatched glob is a literal path, not a test — skip it rather than dying.
log_info "shell checks (every */tests/*.sh, if any)"
for t in ./*/tests/*.sh; do
	[ -e "$t" ] || continue
	log_info "run" script="$t"
	sh "$t"
done

log_info "test sweep passed"
