#!/bin/sh
# run.sh — this unit's leg of the repo test sweep. test.sh globs
# `./*/tests/*.sh`, so the hook needs no edit to the sweep to be picked up.
#
# WHY a loud skip rather than a failure: the sweep runs on hosts that carry no
# JDK (the same posture as estige's Go leg, docs/d123) — a Java suite that
# cannot run is reported, not silently passed, and not a reason to go red.
#
# WHY mvn may touch the network here: the first run resolves dependencies; the
# sweep's offline contract (docs/d122) is about committed caches of subject
# data, and the Go suite in the same sweep resolves modules the same way.

set -eu

cd "$(dirname "$0")/.."

# EXECUTED probes, not command -v: a version manager's shim answers the
# PATH lookup and then fails at run time with "no version is set" — a check
# that only asks for the name would report a toolchain that cannot build.
if ! java -version >/dev/null 2>&1 || ! mvn -version >/dev/null 2>&1; then
	echo "sbex tests: skipped — no working java/maven toolchain on PATH" >&2
	exit 0
fi

exec mvn -B -ntp test
