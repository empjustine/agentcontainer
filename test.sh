#!/bin/sh
# test.sh — the repo-wide test sweep (docs/d113).
#
# WHAT IT IS: the maintainer's view across the copy units, not a library any
# unit consumes. Since docs/d113 every test lives with the code it tests —
# `<unit>/tests/` — and each of those runs standalone from its own folder
# (`. ./<unit>/lib/node-run.sh && node_run --test <unit>/tests/*.test.mjs`).
# This script exists for the one thing a single unit cannot do: run them all,
# plus the one invariant whose subject is the WHOLE unit set
# (tests/committed-manifests.test.mjs — docs/d050's canonicity guard, which
# spans coding-agent's manifests and estige's generated estige.json).
#
# The globs are the contract: a new `*/tests/*.test.mjs` or `*/tests/*.sh` is
# picked up without editing this file, so a unit cannot add a test that the
# sweep silently skips.
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

log_info "unit tests (node --test: tests/ + every */tests/)"
node_run --test tests/*.test.mjs ./*/tests/*.test.mjs

log_info "shell checks (every */tests/*.sh)"
for t in ./*/tests/*.sh; do
	log_info "run" script="$t"
	sh "$t"
done

log_info "test sweep passed"
