#!/bin/sh
# farm-lock.sh — ONE home for the farm mutation lock: its path, its wait
# policy (bounded, visible, accounted) and the advisory-lock wrapper
# (d099's maintenance surface, the cross-process half).
# Sourced by the mutating entries (git/-forge-mirror.sh, git/maintain.sh)
# and by git/tests/git-farm-lock.test.mjs, which pins the path rule.
#
# WHY the lock exists: a session-driven mutation (d099's upsert_repo /
# compact_repo) and a hand-run ./git/maintain.sh sweep must never fetch or
# repack the same farm concurrently — a second disk-filling repack beside the
# first is the clown-car failure d099 refuses by construction. flock(1) is
# the whole mechanism; in-process serialization (the future MCP server's
# mutex) is the other half and deliberately not duplicated here.
#
# WHAT it guards is the maintenance step, not the tool that contains it
# (docs/d166), and every wait on it is bounded, announced and accounted: an
# entry blocked on a mutex with no output is indistinguishable from a hang,
# which is the complaint the loop below answers.
#
# The lock file lives in the per-user runtime dir, NOT in the farm: d099's
# verification requires a read-only session to leave the farm byte-identical,
# and a status/lock file inside the farm would itself be a write.

# Echo the farm mutation lock path. XDG_RUNTIME_DIR is already per-user; the
# /tmp fallback needs the uid because /tmp is shared.
farm_mutation_lock_path() {
	if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
		printf '%s/agentcontainer-farm-mutation.lock' "$XDG_RUNTIME_DIR"
	else
		printf '%s/agentcontainer-farm-mutation-%s.lock' "${TMPDIR:-/tmp}" "$(id -u)"
	fi
}

# How long a mutation waits when its entry states no policy of its own
# (seconds): long enough to ride out a hiccup, short enough that a busy entry
# never reads as a hang (docs/d166). Deliberately NOT exported — an inherited
# value must survive this line, and the align path's queue default is a
# node-side policy this shell must not flatten (forge-mirror.mjs resolves
# FG_FARM_MUTATION_LOCK_TIMEOUT_S, or --lock-timeout, and passes it down).
FG_FARM_MUTATION_LOCK_TIMEOUT_S=${FG_FARM_MUTATION_LOCK_TIMEOUT_S:-10}

# The holder's self-description beside the lock: printed as two lines (where
# the lock is, who says they hold it) and left raw in $_flock_held_by for the
# acquisition line that reports the hold-back afterwards. Rough on purpose —
# a holder that wrote nothing is reported as not recorded rather than guessed
# at (docs/d166). Hence the shared _flock_ prefix: sh has no local, and every
# reader of this variable is the wrapper below.
farm_lock_describe() {
	printf '  lock:    %s\n' "$1" >&2
	if [ -r "$1.status" ]; then
		_flock_held_by=$(cat "$1.status")
	else
		_flock_held_by='not recorded (the holder described itself nowhere)'
	fi
	printf '  holder:  %s\n' "$_flock_held_by" >&2
}

# The one action that ends a stuck wait, keyed to what the status file (and
# the pid inside it) actually supports: a live holder pid can be killed, a
# missing one leaves the lock's own probe as the only way in, and a dead pid
# means the description lags the truth.
farm_lock_unlock_hint() {
	if [ ! -r "$1.status" ]; then
		printf '  stuck:   nothing to name — ./node-run.sh git/farm-tool.mjs maintenance_status reads the holder from the lock itself, and the kernel drops the lock when that process exits.\n' >&2
		return 0
	fi
	_flock_pid=$(cat "$1.status" |
		sed -n 's/.*"pid" *: *\([0-9][0-9]*\).*/\1/p')
	if [ -z "$_flock_pid" ]; then
		printf '  stuck:   the status line names no pid — ./node-run.sh git/farm-tool.mjs maintenance_status is the way in.\n' >&2
	elif kill -0 "$_flock_pid" 2>/dev/null; then
		printf '  stuck:   the lock releases when pid %s exits — kill %s to end this wait now.\n' \
			"$_flock_pid" "$_flock_pid" >&2
	else
		printf '  stale:   pid %s is gone, so the status line lags the truth — the live holder described itself nowhere.\n' "$_flock_pid" >&2
	fi
}

# with_farm_mutation_lock CMD [ARG...] — run CMD while holding the farm-wide
# advisory lock; the exit status is CMD's.
#
# The wait is bounded by FG_FARM_MUTATION_LOCK_TIMEOUT_S (0 = no deadline),
# polls once a second so the hold-back can be reported, and gives up with
# 75 (EX_TEMPFAIL): the mutation is safe to retry later. Lines appear only
# for a caller that actually waited: what held the lock before it, how many
# seconds it was held back, and — at the give-up — how to end the wait or
# lengthen it (docs/d166).
#
# The lock is taken on an fd of THIS process (flock's fd mode), NOT via
# `flock LOCKFILE CMD...`: fd mode keeps the lock owned by the caller, so no
# supervising flock process sits between the caller and its command's exit
# status, and the kernel drops the lock the moment the holder dies — the
# property that makes a killed repack safe to retry. The callers' command is a
# real executable since d138 (the repo-root node-run.sh), so exec mode would
# work too; the fd is still the half with fewer moving parts.
#
# flock is missing → warn and run unlocked: a degraded lock beats refusing
# every mutation on a host without util-linux, and the warning keeps the
# degradation visible.
with_farm_mutation_lock() {
	_flock_lock=$(farm_mutation_lock_path)
	if ! command -v flock >/dev/null 2>&1; then
		printf 'Warning: flock(1) not found — running WITHOUT the farm mutation lock\n' >&2
		if "$@"; then _flock_rc=0; else _flock_rc=$?; fi
		return "$_flock_rc"
	fi
	# A garbage timeout would otherwise surface as flock's own failure mode —
	# an exit status reading "the command failed" instead of "the wait is
	# misconfigured". 64 is EX_USAGE, the argv-error code the entries share.
	case "$FG_FARM_MUTATION_LOCK_TIMEOUT_S" in
	''|*[!0-9]*)
		printf 'farm mutation lock: FG_FARM_MUTATION_LOCK_TIMEOUT_S must be a whole number of seconds (got %s)\n' \
			"$FG_FARM_MUTATION_LOCK_TIMEOUT_S" >&2
		return 64
		;;
	esac
	# FD 9 is the conventional internal-use descriptor; the redirect opens
	# the lock file without spawning anything.
	exec 9>"$_flock_lock"
	_flock_started=$(date +%s)
	_flock_timeout=$FG_FARM_MUTATION_LOCK_TIMEOUT_S
	_flock_deadline=0
	if [ "$_flock_timeout" -gt 0 ]; then
		_flock_deadline=$((_flock_started + _flock_timeout))
	fi
	_flock_waited=0
	_flock_held_by=''
	if ! flock -n 9; then
		printf 'farm mutation lock busy — waiting up to %ss (0 = no deadline) for: %s\n' \
			"$_flock_timeout" "$*" >&2
		farm_lock_describe "$_flock_lock"
		_flock_next_beat=30
		while ! flock -w 1 9; do
			_flock_now=$(date +%s)
			_flock_waited=$((_flock_now - _flock_started))
			if [ "$_flock_deadline" -gt 0 ] && [ "$_flock_now" -ge "$_flock_deadline" ]; then
				printf 'farm mutation lock busy after %ss — giving up (exit 75, safe to retry): %s\n' \
					"$_flock_waited" "$*" >&2
				farm_lock_describe "$_flock_lock"
				farm_lock_unlock_hint "$_flock_lock"
				printf '  extend:  pass --lock-timeout SECONDS to this entry, or set FG_FARM_MUTATION_LOCK_TIMEOUT_S=SECONDS; 0 waits indefinitely.\n' >&2
				return 75 # EX_TEMPFAIL
			fi
			if [ "$_flock_waited" -ge "$_flock_next_beat" ]; then
				printf 'still waiting for the farm mutation lock — %ss held back so far\n' \
					"$_flock_waited" >&2
				_flock_next_beat=$((_flock_waited + 30))
			fi
		done
		printf 'farm mutation lock acquired after %ss (held back by: %s)\n' \
			"$_flock_waited" "$_flock_held_by" >&2
	fi
	# A signal must not take the shell down while a step is in flight: node
	# answers the FIRST signal by finishing that step (docs/d164), and the lock
	# has to outlive the work it guards. POSIX runs a trap after the foreground
	# command completes, so this keeps the holder alive until exactly the
	# boundary the stop waits for; a second signal still reaches node, which is
	# the half that aborts. The guard starts HERE, not before the wait: blocked
	# on the lock, nothing is in flight and nothing is held, so a signal must
	# do what it normally does — end the wait at once.
	trap 'printf "%s\\n" "signal received — the step in flight finishes before this shell exits (docs/d164)" >&2' INT TERM
	# The holder describes itself only when the slot is free — a queued
	# farm-tool verb wrote its line first, and "who am I queued behind" answers
	# a waiter better than the holder's own name. It is removed on the way out
	# either way: the slot describes the lock, so a leftover line is a lie the
	# next reader would believe (docs/d166).
	_flock_wrote_status=0
	if [ ! -e "$_flock_lock.status" ]; then
		# Each value lands inside one JSON string: a quote, a backslash or a
		# control character would break the line for whoever reads it next.
		if printf '{"tool":"%s","pid":%s,"started":"%s","detail":"%s"}\n' \
			"$(printf '%s' "${0##*/}" | tr -d '"\\\000-\037')" \
			"$$" \
			"$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
			"$(printf '%s' "$*" | tr -d '"\\\000-\037')" \
			>"$_flock_lock.status.tmp"; then
			mv "$_flock_lock.status.tmp" "$_flock_lock.status"
			_flock_wrote_status=1
		fi
	fi
	# The guarded command runs inside an if-condition so errexit suspends for
	# exactly these lines: the status slot must clear on a FAILED command too,
	# and `set -e` in the caller would exit at "$@" and strand the
	# description (docs/d166).
	if "$@"; then _flock_rc=0; else _flock_rc=$?; fi
	flock -u 9
	if [ "$_flock_wrote_status" = 1 ]; then
		rm -f "$_flock_lock.status"
	fi
	# Back to the caller with the lock released: the signal guard belonged to
	# the held phase, and a caller that keeps running gets its default
	# dispositions back rather than a trap that outlives the work it guarded.
	trap - INT TERM
	return "$_flock_rc"
}
