#!/bin/sh
# npm-run.sh — run a unit's package.json script under the pinned node.
#
#   exec "$repo/npm-run.sh" "$unit" generate --check
#   ./npm-run.sh pi-hyper generate
#
# One copy, at the repo root (docs/d138), like node-run.sh beside it: the
# delegation is the same fact for every unit, so a per-unit copy would be a
# fork waiting to happen.
#
# WHY the unit folder is an ARGUMENT and not "dirname $0": this file is executed,
# so $0 is this file and the CALLER's directory is not recoverable from the
# shell. Passing it is also the honest contract — the folder that declares the
# script is the input, not a guess.
#
# WHY a wrapper at all and not "npm run": npm is itself a node program, so
# letting PATH supply it would run the work under whatever node that npm's
# shebang picks — the pin in node-run.sh would cover the shell, not the script.
# Reading the script body out of package.json and running it directly keeps ONE
# interpreter decision (node-run.sh) and puts no npm on an entrypoint's path.
#
# The pin has to reach the CHILD: a script body is a command line
# ("node ./build.mjs"), so the pinned interpreter's directory leads PATH for the
# run (docs/d074's NODE_USE_ENV_PROXY rides along for the same reason — a
# generator behind a proxy needs node's native handling).
#
# WHY the cd: the body's paths are relative to the folder that declares them
# ("node ./build.mjs"), and the caller may stand anywhere.
set -eu

node_run=$(CDPATH='' cd "$(dirname "$0")" && pwd)/node-run.sh

die() { printf 'npm-run.sh: %s\n' "$*" >&2; exit 64; }

[ "$#" -ge 2 ] || die 'usage: npm-run.sh <unit-dir> <script> [args...]'
npm_unit=$1
npm_script=$2
shift 2

[ -f "$npm_unit/package.json" ] ||
	die "no package.json in $npm_unit — pass the unit folder that declares the script"
npm_unit=$(CDPATH='' cd "$npm_unit" && pwd)

# --input-type is explicit: a unit's package.json says "type": "module", which
# would otherwise make -e evaluate as ESM and leave require undefined.
# shellcheck disable=SC2016  # the program is a single-quoted argument on purpose
npm_body=$("$node_run" --input-type=commonjs -e '
	const { scripts } = require(process.argv[1]);
	const body = scripts?.[process.argv[2]];
	if (!body) {
		console.error("npm-run.sh: no script " + process.argv[2] + " in " + process.argv[1]);
		process.exit(1);
	}
	process.stdout.write(body);
' "$npm_unit/package.json" "$npm_script")

cd "$npm_unit"

PATH=$("$node_run" -p 'process.stdout.write(require("path").dirname(process.execPath))'):$PATH
export PATH NODE_USE_ENV_PROXY=1
exec sh -c "$npm_body \"\$@\"" npm-run "$@"
