#!/bin/sh
# farm-lock.sh — ONE home for the farm mutation lock: its path and the
# advisory-lock wrapper (d099's maintenance surface, the cross-process half).
# Sourced by the two mutating entries (git/-forge-mirror.sh, git/maintain.sh)
# and by git/farm-tool-lib.sh.
#
# WHY the lock exists: a session-driven mutation (d099's upsert_repo /
# compact_repo) and a hand-run ./git/maintain.sh sweep must never fetch or
# repack the same farm concurrently — a second disk-filling repack beside the
# first is the clown-car failure d099 refuses by construction. flock(1) is
# the whole mechanism; in-process serialization (the future MCP server's
# mutex) is the other half and deliberately not duplicated here.
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

# How long a mutation waits for the mutex before giving up (seconds). Long
# because a queued repack is normal operation — but bounded, because an
# unattended CLI that waits forever is indistinguishable from a hang.
FG_FARM_MUTATION_LOCK_TIMEOUT_S=1800

# with_farm_mutation_lock CMD [ARG...] — run CMD while holding the farm-wide
# advisory lock; the exit status is CMD's.
#
# The lock is taken on an fd of THIS process (flock's fd mode), NOT via
# `flock LOCKFILE CMD...`: that mode execvp's CMD, and the callers' command is
# node_run — a shell FUNCTION from lib/node-run.sh that no exec can see
# (flock: "failed to execute node_run"). The fd mode also releases the lock
# automatically if the holder dies: the kernel drops the open file
# description with the process.
#
# flock is missing → warn and run unlocked: a degraded lock beats refusing
# every mutation on a host without util-linux, and the warning keeps the
# degradation visible.
with_farm_mutation_lock() {
	_flock_lock=$(farm_mutation_lock_path)
	if ! command -v flock >/dev/null 2>&1; then
		printf 'Warning: flock(1) not found — running WITHOUT the farm mutation lock\n' >&2
		"$@"
		return $?
	fi
	# FD 9 is the conventional internal-use descriptor; the redirect opens
	# the lock file without spawning anything.
	exec 9>"$_flock_lock"
	if flock -w "$FG_FARM_MUTATION_LOCK_TIMEOUT_S" 9; then
		"$@"
		_flock_rc=$?
		flock -u 9
		return "$_flock_rc"
	fi
	printf 'farm mutation lock busy after %ss: %s\n' \
		"$FG_FARM_MUTATION_LOCK_TIMEOUT_S" "$_flock_lock" >&2
	return 75 # EX_TEMPFAIL: the mutation is safe to retry later
}
