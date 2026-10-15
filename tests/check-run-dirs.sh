#!/bin/sh
# check-run-dirs.sh — the DIRECTORY argv that coding-agent/run.sh hands the
# container tool, asserted as argv.
#
# WHAT IT PINS: docs/d068's two-sided spelling of the mount manifest — the
# HOST side of a DIRECTORY stays canonical (`$(pwd -P)`: the dedupe and the
# `$HOME` refusal compare those forms), the CONTAINER side of a home-relative
# DIRECTORY is spelled from the home the image gives the user, and a
# non-home DIRECTORY passes through untouched. It also rides along the pieces
# that the spelling is entangled with: CWD as the implicit first DIRECTORY,
# dedupe of a symlinked and a physical spelling of the same directory, the
# `$HOME` refusal (exit 90), and the workdir being that first DIRECTORY.
#
# WHY IT EXISTS: every other gate is blind to this class of bug.
# The shellcheck binary parses the case pattern but not what `$_home` resolves to;
# lint.sh's jq gate only compiles the renderer (which formats whatever the
# launcher hands it); tests/check-workload.sh renders host==guest pairs BY
# CONSTRUCTION, so it cannot express a pair that differs. A launcher that
# spelled the guest from `pwd -P` passed all three while, on a host whose home
# sits behind a symlink (Bazzite / Fedora Atomic: `/home` -> `/var/home`),
# the folders landed outside the sandbox's `~` — mounted, yet nowhere a
# session looks for them, which is how the bug read to the operator.
#
# The fixture below IS that host: `$HOME` is a symlink to a physical home, so
# every home-relative path has two spellings, and the stub `podman` only
# prints its argv (found because the backend probe resolves through PATH,
# docs/d069) — the assertion is the argv itself.
#
# Usage: ./tests/check-run-dirs.sh              run the checks
#        RECORD=1 ./tests/check-run-dirs.sh     rewrite the expectation
#                                               (review the diff!)

set -eu

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
expect="$root/tests/expect-run-dirs.txt"

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM

# Stand-in container tool: writes one ARG[...] line per word to ARGV_OUT, so
# the launcher's own log lines cannot pollute what is compared.
mkdir -p -- "$tmp/bin"
# shellcheck disable=SC2016  # $@/$a/$ARGV_OUT must stay literal in the GENERATED file
printf '#!/bin/sh\n{ for a in "$@"; do printf "ARG[%%s]\\n" "$a"; done; } >"$ARGV_OUT"\n' >"$tmp/bin/podman"
chmod 0755 -- "$tmp/bin/podman"

# The reference-host layout: a symlinked home (so pwd -P != the spelling the
# operator typed) with one dir under it, one under that, and one outside it.
mkdir -p -- "$tmp/physical/home/project" \
	"$tmp/physical/home/Downloads/references" \
	"$tmp/physical/srv/data"
ln -s -- "$tmp/physical/home" "$tmp/home"
HOME="$tmp/home"
export HOME
USER=run-dirs-check
export USER
PATH="$tmp/bin:$PATH"
export PATH

# pi's generator artifacts (run.sh aborts without them, exit 94); everything
# else it needs it mkdir -p's itself.
mkdir -p -- "$HOME/.pi/agent"
for _f in settings.json models.json mcp.json; do
	printf '{}\n' >"$HOME/.pi/agent/$_f"
done

# env -i: the allowlist forwards only NON-EMPTY matching vars, so an ambient
# HF_TOKEN/OPENROUTER_API_KEY in the caller's environment would otherwise
# make the argv machine-dependent.
_env() {
	env -i PATH="$PATH" HOME="$HOME" USER="$USER" ARGV_OUT="$ARGV_OUT" "$@"
}

ARGV_OUT="$tmp/argv.txt"
export ARGV_OUT
# Two spellings of the same directory (symlinked + physical) to pin the
# dedupe, plus a non-home directory to pin the pass-through. CWD is implicit.
(cd "$HOME/project" && _env "$root/coding-agent/run.sh" \
	"$HOME/Downloads/references" \
	"$tmp/physical/home/Downloads/references" \
	"$tmp/physical/srv/data") \
	</dev/null >"$tmp/run1.out" 2>"$tmp/run1.err" || {
	printf 'FAIL: run.sh exited %s (the fixture is missing something)\n' "$?" >&2
	sed 's/^/  /' "$tmp/run1.out" "$tmp/run1.err" >&2
	exit 1
}

_norm() {
	sed -E -e "s|$tmp|<TMP>|g" \
		-e "s|$(id -u):$(id -g)|<UID>:<GID>|g" \
		-e 's|agentcontainer-[0-9]{17}|agentcontainer-<STAMP>|g'
}

_norm <"$ARGV_OUT" >"$tmp/argv.norm"

if [ "${RECORD:-}" = 1 ]; then
	cp -- "$tmp/argv.norm" "$expect"
	printf 'recorded %s\n' "$expect"
	exit 0
fi

[ -f "$expect" ] || {
	printf 'FAIL: no expectation at %s — RECORD=1 to create it\n' "$expect" >&2
	exit 1
}

if ! diff -u --label expected --label got "$expect" "$tmp/argv.norm"; then
	printf 'FAIL: the container argv drifted from %s\n' "$expect" >&2
	exit 1
fi

# The refusal: naming `$HOME` itself must still stop the launch (exit 90)
# rather than binding the whole home into the sandbox.
set +e
(cd "$HOME/project" && _env "$root/coding-agent/run.sh" "$HOME") \
	</dev/null >"$tmp/run2.out" 2>"$tmp/run2.err"
_refuse=$?
set -e
[ "$_refuse" -eq 90 ] || {
	printf "FAIL: \$HOME as a DIRECTORY should exit 90, got %s\n" "$_refuse" >&2
	sed 's/^/  /' "$tmp/run2.out" "$tmp/run2.err" >&2
	exit 1
}
grep -q 'refusing to expose HOME' "$tmp/run2.out" "$tmp/run2.err" || {
	printf 'FAIL: the refusal did not say why\n' >&2
	sed 's/^/  /' "$tmp/run2.out" "$tmp/run2.err" >&2
	exit 1
}

printf 'PASS check-run-dirs (%s argv words, refusal 90)\n' "$(wc -l <"$expect")"
