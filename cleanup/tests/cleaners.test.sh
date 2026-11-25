#!/bin/sh
# cleaners.test.sh — acceptance criteria for cleanup/DESIGN.md.
# Builds its own tree under mktemp; never touches a real work tree.
set -eu

DIR=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' 0

ROOT="$WORK/tree"
mkdir -p "$ROOT/repo-tracked/dist" "$ROOT/repo-ignored/build" "$ROOT/repo-warn/out" "$ROOT/plain/out"
printf 'source\n' >"$ROOT/repo-tracked/dist/app.js"
printf 'build/\n' >"$ROOT/repo-ignored/.gitignore"
printf 'gen\n' >"$ROOT/repo-ignored/build/app.js"
printf 'maybe-source\n' >"$ROOT/repo-warn/out/app.js"
printf 'junk\n' >"$ROOT/plain/out/app.js"
(cd "$ROOT/repo-tracked" && git init -q && git add dist/app.js)
(cd "$ROOT/repo-ignored" && git init -q && git add .gitignore)
(cd "$ROOT/repo-warn" && git init -q)

fails=0
assert_eq() { # assert_eq <description> <expected> <actual>
	if [ "$2" = "$3" ]; then
		printf 'ok   %s\n' "$1"
	else
		printf 'FAIL %s: expected [%s], got [%s]\n' "$1" "$2" "$3"
		fails=$((fails + 1))
	fi
}
count() { # count <jsonlines> <fixed pattern> — matching lines; 0 is not an error
	printf '%s\n' "$1" | grep -c -F -- "$2" || true
}
assert_count() { # assert_count <description> <expected> <jsonlines> <pattern>
	n=$(count "$3" "$4")
	assert_eq "$1" "$2" "$n"
}
assert_dir() { # assert_dir <description> <expected 0|1> <path>
	if [ -d "$3" ]; then actual=1; else actual=0; fi
	assert_eq "$1" "$2" "$actual"
}

# Dry-run classifies every candidate and removes nothing.
dry=$(sh "$DIR/clean-js-builds.sh" "$ROOT")
assert_count "I1: tracked path is skipped" 1 "$dry" '"msg":"skipped tracked path"'
assert_count "I2: no git signal is kept and warned" 1 "$dry" '"msg":"kept path without a git signal"'
assert_count "I3/I4: ignored and outside-repo paths are candidates" 2 "$dry" '"msg":"would remove"'
assert_count "dry-run emits one summary" 1 "$dry" '"msg":"cleanup summary"'
assert_dir "R3: dry-run keeps the ignored build" 1 "$ROOT/repo-ignored/build"
assert_dir "R3: dry-run keeps the outside-repo build" 1 "$ROOT/plain/out"

# --apply removes only the ignored and outside-repo candidates.
sh "$DIR/clean-js-builds.sh" --apply "$ROOT" >/dev/null
assert_dir "I1: tracked path survives --apply" 1 "$ROOT/repo-tracked/dist"
assert_dir "I2: warned path survives --apply" 1 "$ROOT/repo-warn/out"
assert_dir "I3: ignored path is removed" 0 "$ROOT/repo-ignored/build"
assert_dir "I4: outside-repo path is removed" 0 "$ROOT/plain/out"

# Re-running immediately lists zero items.
again=$(sh "$DIR/clean-js-builds.sh" "$ROOT")
assert_count "R5: idempotent re-run has zero items" 1 "$again" '"items":"0"'

# Exit statuses.
status=0
sh "$DIR/clean-js-builds.sh" "$WORK/nonexistent" >/dev/null 2>&1 || status=$?
assert_eq "R6: missing root -> exit 1" 1 "$status"
status=0
sh "$DIR/clean-js-builds.sh" --bad-option >/dev/null 2>&1 || status=$?
assert_eq "R6: unknown option -> exit 2" 2 "$status"
status=0
sh "$DIR/clean-js-builds.sh" --help >/dev/null 2>&1 || status=$?
assert_eq "R6: --help -> exit 0" 0 "$status"

# run-all.sh runs only clean-*.sh; git-gc.sh stays out.
all=$(sh "$DIR/run-all.sh" "$ROOT")
assert_count "R1: run-all includes clean-js-builds.sh" 1 "$all" '"script":"clean-js-builds.sh"'
assert_count "R1: run-all excludes git-gc.sh" 0 "$all" '"script":"git-gc.sh"'

if [ "$fails" -gt 0 ]; then
	printf '%s test(s) failed\n' "$fails"
	exit 1
fi
printf '%s\n' "all cleanup tests passed"
