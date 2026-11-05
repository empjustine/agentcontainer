#!/bin/sh
# node-run.sh — the repo-pinned node interpreter, invoked as a command.
#
# It IS the way to start a unit's node entry (docs/d138 — there are no
# per-entry shims any more):
#
#   ./node-run.sh ./coding-agent/run.mjs <args>
#   ./node-run.sh git/audit.mjs --root /mnt/farm
#
# WHY a program and not a sourced `node_run()` function (docs/d138): a function is
# invisible to `exec`, so each shim had to stay resident and carry node's status
# back, and git/farm-lock.sh had to use flock's fd mode because
# `flock LOCKFILE node_run …` cannot execvp a function. Executed, the pin also
# survives a non-shell caller (flock, an IDE task, an MCP server wrapping the
# shim) and the exit status and signals are node's own.
#
# WHY there is exactly ONE of this file (docs/d138, narrowing docs/d113): the pin
# is a single repo-wide fact, so a version bump is a one-line edit here instead
# of a copy hunt — and a unit that carried its own copy could silently drift
# (estige/build.sh had forked the function outright). The cost is accepted and
# deliberate: a folder copied OUT of this tree ships its code, not a way to run
# it — the copy unit's standalone promise covers its modules, not how they are
# started.
#
# System node on Termux (there is no mise there), `mise exec node@24` elsewhere.
# Product version floors are not enforced here: the llm-local-inference
# generators need a global fetch (node >= 18), and pi enforces its own >= 22.19
# engines at launch (the Termux pre-stage gate was retired — docs/d051).
#
# NODE_USE_ENV_PROXY=1 gives every generator run Node's native HTTP(S)_PROXY /
# NO_PROXY handling for fetch and http/https (docs/d074). The versions that
# added it are 22.21/24, so an older system node (Termux) silently ignores the
# variable rather than failing.
set -eu

# node with no arguments starts a REPL, which no caller here wants: fail as a
# usage error instead of hanging on a terminal that will never arrive.
if [ "$#" -eq 0 ]; then
	printf 'node-run.sh: usage: node-run.sh <script|flag>... [args...]\n' >&2
	exit 64
fi

# Exported rather than a command prefix: exec takes a command, so this
# process's own environment is the only place left to put it.
NODE_USE_ENV_PROXY=1
export NODE_USE_ENV_PROXY

case "${PREFIX:-}" in
*/com.termux/*) exec node "$@" ;;
*) exec mise exec node@24 -- node "$@" ;;
esac
