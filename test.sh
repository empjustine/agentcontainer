#!/bin/sh
# test.sh — the repo-wide test sweep (docs/d113).
#
# WHAT IT IS: the maintainer's view across the copy units, not a library any
# unit consumes. Since docs/d113 every test lives with the code it tests —
# `<unit>/tests/` — and each of those runs standalone from its own folder
# (`./node-run.sh --test <unit>/tests/*.test.mjs`, from the repo root).
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

# shellcheck source-path=SCRIPTDIR source=log.sh
. "$(dirname "$0")/log.sh"
# shellcheck source-path=SCRIPTDIR source=dev-tools.sh
. "$(dirname "$0")/dev-tools.sh"
LOG_TOOL='test'
export LOG_TOOL

root="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
cd "$root"
log_info "unit tests (node --test: every */tests/)"
"$root/node-run.sh" --test ./*/tests/*.test.mjs

# Go toolchain acquisition is dev-tools.sh's job now (docs/d139); the reason
# d123 gave for the probe still holds inside it — a mise SHIM on PATH is not
# proof of a toolchain (`go version` is), and on a sandbox host the shims are off
# PATH entirely. d139 changes one thing: a dev host ACQUIRES the pinned go
# through mise, exactly as the lint legs already did, instead of skipping until
# somebody remembers an install command (that is the d123 sentence it
# supersedes). Termux and mise-less hosts still skip loudly rather than fail the
# sweep: the suite is real, but a box with no Go cannot be asked to run it, and
# DEV_TOOLS_PROFILE=none makes the same skip an explicit choice anywhere.
log_info "estige Go suite (in-package tests, needs a go toolchain)"
if _go_bin=$(dev_tool_bin go) && _go_ver=$("$_go_bin" version 2>/dev/null); then
	log_info "go toolchain" path="$_go_bin" version="$_go_ver"
	(
		cd estige
		CGO_ENABLED=0 "$_go_bin" test ./...
	)
else
	log_warn "skipped — no working go toolchain" hint="./dev-tools.sh go (or the host package manager)"
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
