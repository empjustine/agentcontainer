---
id: d166
type: module-design
status: draft
title: "d166 — the farm mutation lock guards the align and the sweep, waits ten seconds by default, and reports every wait"
parent: git
depends-on: [d099, d121, d164]
references: [d044, d045, d075, d076, d137, d138]
tags: ["git", "mirror", "lock", "flock", "maintenance", "cli"]
---

# d166 — the farm mutation lock guards the align and the sweep

**Status:** draft · the mechanism is implemented and probed against the
shipped entries (see the Verification section); a full-farm run of
`maintain.sh --lock-timeout` is the check still owed.

## Problem

`with_farm_mutation_lock` (docs/d121) wraps a whole command, and both of its
callers used it that way: `-forge-mirror.sh` held the lock across URL
validation and a first-time clone, `maintain.sh` across a sweep of every
mirror on the host (d076's one-job-per-host scheduler puts the farm's 1265
mirrors behind one process at the time of this record).

Three things followed from that shape:

- **The guard did not match the mutation.** A clone cannot race anything: no
  farm process learns its path until it exists. The align of a mirror that
  already exists can race, and it was indistinguishable from the rest, so an
  acquisition paid a queue for work with nothing to contend with.
- **The wait was silent.** `flock -w 1800` printed nothing while it
  blocked — one line after thirty minutes, and it named only the lock path.
  A caller could not tell a slow holder from a dead one, and the only route
  out was knowing that killing the holder releases the lock with its process.
- **The wait had no caller-facing surface.** `maintain.sh` offered no way to
  ask for a shorter or longer wait. `farm-tool` could show "queued" only
  because `upsert_repo` wrote its own status file before spawning the entry;
  a hand run of the same entry got no holder, no hold-back and no way out.

## Decision

**The lock guards the mutation of a mirror the farm already holds: the align
an acquisition performs on an existing mirror, and the maintenance sweep.**

The requirement, in the entries' own terms:

- `-forge-mirror.sh` takes the lock only in its `--align` branch, and
  `forge-mirror.mjs` reaches that branch by spawning
  `-forge-mirror.sh --align TARGET --dest DIR`. An acquisition of a mirror
  that does not exist yet takes no lock.
- `maintain.sh` keeps wrapping its whole command: a sweep is the mutation.
- No other entry in the folder takes it. `migrate-to-bare.mjs` writes a
  separate root (its own `--dest`), not the farm's mirrors.

**An acquisition does its lock-free work first.** The batch plans every
input, clones the mirrors that do not exist yet, and only then runs the
aligns that take the lock — so a busy lock costs the fresh clones nothing
(waiting, or a give-up, comes after every clone) and the complaint about it
lands last. The fresh/existing split is frozen while planning, before the
first clone: a mirror cloned in the run is current by construction and is
never aligned again.

**A wait defaults to ten seconds.** `FG_FARM_MUTATION_LOCK_TIMEOUT_S`
defaults to 10 (it was 1800). A wait that expires gives up with exit 75
(`EX_TEMPFAIL`) — a bounded, retryable failure instead of a half-hour stall
— and a value that is not a whole number of seconds gives up with exit 64
(`EX_USAGE`). Three surfaces raise it:

- `./git/maintain.sh --lock-timeout SECONDS ...` consumes the flag in the
  shim, before `farm-lock.sh` ever sees argv, and
  forwards every other word untouched. The flag dies there rather than in
  `maintain-mirrors.mjs` because the wait happens in that shell.
- `./git/-forge-mirror.sh ... --lock-timeout SECONDS` reaches
  `forge-mirror.mjs`, which resolves the wait (flag, then environment, then
  the queue default) and passes it to the align sub-run through the
  environment. The flag sits on the node side there because node is what
  spawns the waiting shell.
- `FG_FARM_MUTATION_LOCK_TIMEOUT_S=SECONDS` raises the wait of any entry, and
  `0` waits indefinitely.

**Every wait reports itself**, as text on stderr — the stream the folder's
logger already writes (d045) — and it carries:

- at the first blocked attempt, what is being run:
  `farm mutation lock busy — waiting up to Ns (0 = no deadline) for: <argv>`;
- every thirty seconds after that, a heartbeat with the same facts, so a run
  that outlives its patience is distinguishable from one that hung;
- once the lock is taken, `acquired after Ns`, printed only when a wait
  actually happened, so the line means something;
- when the wait expires, the full report: the lock path; the holder's own
  status line verbatim (its tool, pid, start and job — the locked/free answer
  itself comes from the lock's kernel probe, because a file's existence
  proves nothing, d137's rule), or `not recorded` when nothing describes the
  holder. Then the way out that line supports: a live pid gets `the lock
  releases when pid N exits — kill N to end this wait now`, since the kernel
  drops the lock with the process; a pid that has gone is called out as a
  description lagging the truth; no line or no pid names
  `./node-run.sh git/farm-tool.mjs maintenance_status`, which reads the
  holder from the lock itself, as the way in. The report ends with how to
  extend the wait (the flag, the environment, `0` for no deadline).

**A signal is answered by the phase it lands in.** During a wait, nothing is
in flight and nothing is held: the signal ends the wait, and the entry dies
with the usual interrupted status (130 for INT, 143 for TERM), no status
line and no lock to clean up. Once the lock is held, d164's guard applies —
the shell traps INT and TERM so the step in flight can finish while the lock
outlives it, and the epilogue (unlock, status removal) runs before the entry
returns the command's status. The trap belongs to the held phase alone: a
guard installed over the wait would swallow an interrupt meant for a lock the
caller does not yet hold.

**One wait queues.** The align inherits 1800 seconds rather than ten, because
a sweep mutates the same mirrors an acquisition is about to: the wait it
absorbs is the sweep's remaining duration, and d099 already serialises these
mutations behind one queue. A first-time clone waits for nothing.

## Why the lock stays in shell

The lock is an fd in the caller's own process (d121), and `farm-lock.sh` is
its only taker (d138: the shell entries are trampolines into node). The align
therefore reaches the lock by spawning the entry that owns it, not by taking
the lock from node: node keeps naming, probing and describing the lock
(`lib/farm-lock.mjs`) and never acquiring it. There is exactly one
mechanism, and the align's wait, report, status file and give-up code are the
same code path a hand run of `-forge-mirror.sh --align` gets.

The spawn is synchronous on purpose: the align is the acquisition's step in
flight (d164), so a signal finishes it rather than landing between a fetch
and its report.

## Consequences

- An acquisition of a new mirror never waits behind a sweep. An align waits
  no longer than its configured wait and says what held it up.
- The align's expiry surfaces as the entry's own error line (`align queue
  timed out on the farm mutation lock (see stderr)`), so `upsert_repo`
  reports a failure whose reason sits in the tool's stderr log and the
  envelope shape stays what d099 fixed it to.
- The status file is written before the block and removed after it, so
  `farm-tool`'s "queued" line describes a lock that does not exist yet and
  `maintenance_status` still has a holder to read.
- The heartbeat costs one line per thirty seconds in a log nobody watches
  live (a cron sweep's stderr, an MCP server's log), in exchange for telling
  the two apart.
- `maintain.sh` parses one flag itself. Its flag table is the shim's and
  `maintain-mirrors.mjs` never sees the token: two flag vocabularies in one
  entry, the price of keeping the wait in the process that waits.

## Alternatives rejected

- **Taking the lock in `forge-mirror.mjs`.** node cannot flock, so the lock
  would need a second mechanism — a sidecar process, or parsing `flock(1)`'s
  held output — beside the shell's fd. The align spawns the entry instead and
  the folder keeps exactly one taker.
- **A lock per mirror, or per host.** The blast radius is the farm: two
  sweeps are two writers on shared roots and shared packfiles, and the by-host
  pacing gate (d076) already assumes one writer per host.
- **A silent wait with a spinner.** The report must survive a
  non-interactive run — a cron log, an MCP server's stderr — so it is text
  lines that mean the same thing when no terminal reads them.
- **Moving `--lock-timeout` into `maintain-mirrors.mjs`.** The wait happens
  before node starts, so node would consume a flag the shell needs first:
  parsed twice, by two parsers, with the loser silent. The shim consumes what
  it owns and forwards the rest, and an unknown flag still dies at node's flag
  table with the rest of the folder's.

## Verification

Run against a scratch mirror root and a second process holding the lock:

- A free lock: `./git/-forge-mirror.sh <url> --dest <tmp>` with an existing
  mirror at the resolved path prints `aligned mirror` and exits 0; the
  acquisition line precedes it.
- A held lock and `--lock-timeout 1` on either entry: the run prints the
  busy line, exits 75 after one second, and the report names the lock path
  and the holder. The align's expiry appears once more as the
  acquisition's error line.
- A bare `--lock-timeout` with no value: `maintain.sh` exits 64 with
  `--lock-timeout needs a value`; `--lock-timeout abc` exits 64 with
  `--lock-timeout must be a whole number of seconds (got abc)`.
- No flag and no environment: the wait reports `up to 10s` and gives up at
  ten seconds with `busy after 10s` and exit 75. Raising the wait to forty
  seconds with a lock held for thirty-three of them earns the `30s held back`
  heartbeat and then `acquired after 33s`.
- A holder described by `farm-tool`: the report shows its status line —
  tool, pid, start, `upsert_repo <url>` — instead of `not recorded`, and the
  unlock hint names that pid; the same line with the pid gone yields the
  description-lags-the-truth callout.
- Signals in each phase: INT or TERM during a wait ends it at once (130, 143,
  no status line); during the guarded command the shell survives — INT sent to
  the shell alone runs a `sleep 4` step to completion (0) before the d164 line
  prints — and the epilogue clears the status line and releases the lock in
  every case (130 when the signal reached the step, 143 under TERM).
- A batch of one existing mirror (listed first) and one fresh URL behind a
  held lock (`--lock-timeout 5`): the fresh mirror's `mirrored` line lands
  before the lock's busy line, its give-up, and the entry's
  `1 of 2 inputs failed` summary — and the fresh mirror exists on disk
  afterwards.
