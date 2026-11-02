#!/bin/sh
# lib/npm-run.sh — run this folder's package.json script under the pinned node.
#
# WHY a lib and not `npm run`: npm is itself a node program, so letting PATH
# supply it would run the work under whatever node that npm's shebang picks —
# the pin in lib/node-run.sh would cover the shell, not the script. Reading the
# script body out of package.json and running it directly keeps ONE interpreter
# decision (node-run.sh) and puts no `npm` on an entrypoint's path at all.
#
# The pin has to reach the CHILD: a script body is a command line
# (`node ./build.mjs`), so the pinned interpreter's directory leads PATH for the
# run (docs/d074's NODE_USE_ENV_PROXY rides along for the same reason — a
# generator behind a proxy needs node's native handling).
#
# Sourced BEFORE it is used, and the folder is the CALLER's (a function cannot
# locate a sourced file: $0 is the caller's script, the same convention
# lib/node-run.sh uses for its own dir):
#
#   . "$(dirname "$0")/lib/node-run.sh"
#   . "$(dirname "$0")/lib/npm-run.sh"
#   npm_run build "$@"
#
# WHY the cd: the body's paths are relative to the folder that declares them
# (`node ./build.mjs`), and the caller may stand anywhere — `./coding-agent/
# build.sh` from the repo root would otherwise run the ROOT package's scripts
# or fail to find the file it names.
npm_run() {
	_npm_script=${1:-}
	[ -n "$_npm_script" ] || {
		printf 'npm-run.sh: usage: npm_run <script> [args...]\n' >&2
		return 2
	}
	shift
	command -v node_run >/dev/null 2>&1 || {
		printf 'npm-run.sh: source lib/node-run.sh before lib/npm-run.sh\n' >&2
		return 1
	}
	_npm_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd) || return 1
	[ -f "$_npm_dir/package.json" ] || {
		printf 'npm-run.sh: no package.json beside the caller (%s) — call npm_run from the unit shim\n' \
			"$_npm_dir" >&2
		return 1
	}
	# --input-type is explicit: the package.json says "type": "module", which
	# would otherwise make -e evaluate as ESM and leave `require` undefined.
	# shellcheck disable=SC2016  # the program is a single-quoted argument on purpose
	_npm_body=$(node_run --input-type=commonjs -e '
		const { scripts } = require(process.argv[1]);
		const body = scripts?.[process.argv[2]];
		if (!body) {
			console.error(`npm-run.sh: no script "${process.argv[2]}" in ${process.argv[1]}`);
			process.exit(1);
		}
		process.stdout.write(body);
	' "$_npm_dir/package.json" "$_npm_script") || return 1
	(
		cd "$_npm_dir" || exit 1
		PATH=$(node_run -p 'process.stdout.write(require("path").dirname(process.execPath))'):$PATH
		NODE_USE_ENV_PROXY=1
		export PATH NODE_USE_ENV_PROXY
		exec sh -c "$_npm_body \"\$@\"" npm_run "$@"
	)
}
