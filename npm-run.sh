#!/bin/sh
# npm-run.sh — run one unit's package.json script with the repo-pinned node.
#
# WHY a wrapper at all: the units declare their entrypoints as npm scripts
# (docs/d113: a folder is a copy unit that works alone), but invoking `npm`
# would pick whatever node npm's own shebang resolves — defeating the pin in
# node-run.sh and, on Termux, landing npm's node on top of the packaged one.
# This file keeps the ONE interpreter decision (node-run.sh) and runs the
# script's command line directly, so `npm` is never on the path of a repo
# entrypoint.
#
#   . ./npm-run.sh
#   npm_run pi-hyper generate            # -> node ./generate.mjs, from that folder
#
# Sourcing it from the repo root also pulls in node-run.sh, so `npm_run` is
# usable in one line; a call site that already sourced node-run.sh keeps its
# own copy (the pin is defined in exactly one place either way).
#   npm_run pi-opencode test -- --test-reporter=spec   # extra words are appended
#
# The unit's own package.json is the source of the command line: a second table
# of entrypoints here would be one more thing to drift (docs/d024). A missing
# script name is a caller bug, not a runtime state, so it dies loudly.
#
# WHY the helper lives at the repo root when coding-agent/lib/npm-run.sh is the
# same file: that unit works alone and must not reach up a level (docs/d113), so
# it ships its own copy beside the build.sh/generate.sh that source it. The pi
# extension family ships no shell at all — its folders are loaded by the pi host
# — so the copy it uses is this one, owned by the sweep (docs/d118). The logic is
# duplicated on purpose; the alternative is a shell file in a folder that has no
# shell.
#
# WHY the inner command runs under a PATH prefix instead of node_run directly:
# a script body is a command line (`node ./generate.mjs`), so the pin has to
# reach the `node` it names. NODE_USE_ENV_PROXY is exported for the same
# reason — a generator behind a proxy needs docs/d074's native proxy handling,
# and node_run can only set it per-invocation for the calls it makes itself.
# Sourced at load time, not inside npm_run: npm_run cds into the unit first, so
# a relative source there would resolve against the wrong directory.
if ! command -v node_run >/dev/null 2>&1 && [ -f ./node-run.sh ]; then
	# shellcheck source=node-run.sh
	. ./node-run.sh
fi

npm_run() {
	[ "$#" -ge 2 ] || _npm_run_die "usage: npm_run <unit-dir> <script> [args...]"
	command -v node_run >/dev/null 2>&1 ||
		_npm_run_die "npm_run: node_run is not defined — source ./node-run.sh first (or . ./npm-run.sh from the repo root)"
	unit=$1
	script=$2
	shift 2
	[ -d "$unit" ] || _npm_run_die "npm_run: no such unit: $unit"
	[ -f "$unit/package.json" ] || _npm_run_die "npm_run: no package.json in $unit"

	(
		cd "$unit" || exit 1
		# --input-type is explicit: the unit's own package.json says
		# "type": "module", which would otherwise make -e evaluate as ESM and
		# leave `require` undefined.
		# String concatenation, not template literals: shellcheck reads `${...}`
		# inside a single-quoted block as a shell expansion it should warn about
		# (SC2016), and the gate runs at -S info.
		command=$(node_run --input-type=commonjs -e '
			const { scripts } = require(process.argv[1]);
			const body = scripts && scripts[process.argv[2]];
			if (!body) {
				console.error("npm_run: " + process.argv[1] + " has no script \"" + process.argv[2] + "\"");
				process.exit(1);
			}
			process.stdout.write(body);
		' "$PWD/package.json" "$script") || exit 1
		NODE_USE_ENV_PROXY=1
		export NODE_USE_ENV_PROXY
		PATH=$(node_run -p 'process.stdout.write(require("path").dirname(process.execPath))'):$PATH
		export PATH
		# shellcheck disable=SC2086 # the script body IS a command line
		exec sh -c "$command \"\$@\"" npm_run "$@"
	)
}

_npm_run_die() {
	printf '%s\n' "$1" >&2
	exit 2
}
