#!/bin/sh
# maintain.sh — interpreter shim: run the repo-pinned node on the mirror
# maintenance. Usage lives in maintain-mirrors.mjs (--help) and
# non-bare-issues.md. No secrets and no container runtime are involved.
#
# The flock wrap is d099's maintenance surface: a hand-run sweep must queue
# behind an agent-driven compact_repo (and vice versa) so the farm never has
# two repacks or a fetch-beside-repack in flight — see farm-lock.sh.
set -eu
unit=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=${unit%/*}
# shellcheck source-path=SCRIPTDIR source=farm-lock.sh
. "$unit/farm-lock.sh"

# --lock-timeout is parsed HERE, before farm-lock.sh ever sees argv: the wait
# happens in this shell, so a flag meant for it must not reach
# maintain-mirrors.mjs's parser (docs/d166). The loop rebuilds "$@" from the
# kept words — the for-list is expanded once, before the first iteration, so
# emptying "$@" inside cannot cut the iteration short.
_flock_timeout=''
_skip=''
_drained=''
for _arg in "$@"; do
	if [ -z "$_drained" ]; then
		set --
		_drained=1
	fi
	if [ -n "$_skip" ]; then
		# the word after --lock-timeout is its value, not an argv word
		_flock_timeout=$_arg
		_skip=''
		continue
	fi
	case "$_arg" in
	--lock-timeout)
		_skip=1
		;;
	*)
		set -- "$@" "$_arg"
		;;
	esac
done
if [ -n "$_skip" ]; then
	printf 'maintain.sh: --lock-timeout needs a value — a whole number of seconds (0 = wait indefinitely)\n' >&2
	exit 64
fi
# The flag's value is validated here, not left to farm-lock.sh: that check
# can only name the environment variable, and this entry was given a flag.
if [ -n "$_flock_timeout" ]; then
	case "$_flock_timeout" in
	*[!0-9]*)
		printf 'maintain.sh: --lock-timeout must be a whole number of seconds (got %s)\n' \
			"$_flock_timeout" >&2
		exit 64
		;;
	esac
	FG_FARM_MUTATION_LOCK_TIMEOUT_S=$_flock_timeout
fi

with_farm_mutation_lock "$repo/node-run.sh" "$unit/maintain-mirrors.mjs" "$@"
