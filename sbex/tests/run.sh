#!/bin/sh
# run.sh — this unit's leg of the repo test sweep. test.sh globs
# `./*/tests/*.sh`, so the hook needs no edit to the sweep to be picked up.
#
# WHY a loud skip rather than a failure: the sweep runs on hosts that carry no
# JDK (the same posture as estige's Go leg, docs/d123) — a Java suite that
# cannot run is reported, not silently passed, and not a reason to go red.
#
# WHY the toolchain is acquired through dev-tools.sh and not probed on PATH: a
# mise-only host puts a version-less SHIM on PATH, so `java -version` fails and
# this leg skipped on every dev host that HAD the JDK — the same defect d123
# fixed for the Go leg, still live here while sbex/lint.mjs already acquired its
# two binaries (docs/d139). The sweep passes no paths, so the resolution has to
# happen inside this script: ask the one pin table, then hand mvn a JAVA_HOME
# the surefire fork can boot.
#
# WHY mvn may touch the network here: the first run resolves dependencies; the
# sweep's offline contract (docs/d122) is about committed caches of subject
# data, and the Go suite in the same sweep resolves modules the same way.

set -eu

cd "$(dirname "$0")/.."

# shellcheck source-path=SCRIPTDIR/../.. source=log.sh
. ../log.sh
# shellcheck source-path=SCRIPTDIR/../.. source=dev-tools.sh
. ../dev-tools.sh
LOG_TOOL='sbex-tests'
export LOG_TOOL

if ! _java=$(dev_tool_bin java) || ! _mvn=$(dev_tool_bin maven mvn); then
	echo "sbex tests: skipped — no working java/maven toolchain (./dev-tools.sh java maven)" >&2
	exit 0
fi
JAVA_HOME=$(dirname "$(dirname "$_java")")
export JAVA_HOME

exec "$_mvn" -B -ntp test
