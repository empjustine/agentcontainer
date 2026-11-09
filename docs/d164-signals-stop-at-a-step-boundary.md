---
id: d164
type: module-design
status: draft
title: "d164 — a signal stops a sweep at a step boundary, and the lock outlives the work"
parent: git
depends-on: [d089, d099, d121]
references: [d044, d075, d138, d150, d162]
tags: ["git", "mirror", "signals", "sigint", "maintenance", "lock", "recovery"]
---

# d164 — a signal stops a sweep at a step boundary

**Status:** draft · the mechanism is implemented and measured (the probes below);
the treatment of a SIGKILLed parent is a documented corner, not a solved one.

## Problem

The maintenance sweep had no signal handling at all. `grep` over `git/` found no
`SIGINT`, no `process.on`, no `signal` option on any child: Node's default handler
ran, so the first Ctrl-C meant "stop everything now", and what "everything" was
depended on who received the signal.

That mattered because a deep pass is not a short operation. `git gc --aggressive`
on a 154 MB mirror with 519,900 objects runs for tens of seconds on a warm page
cache and much longer on a real farm, and it is the step whose whole point is to
recompute every delta. Discarding it costs the pass; keeping it running after its
parent is gone costs something worse.

The lock (docs/d099) is held by the shell that wraps the sweep, on its own fd. The
moment that shell exits, the lock is free — whether or not a repack is still
running. So a signal that stops the parent but not the work does not just waste
time: it tells the next mutation that the farm is idle while `git pack-objects` is
still writing.

## What the measurements showed

Every number below comes from a scratch copy of
`github.com/termux/termux-packages.git` (154 MB, 519,900 objects, one pack) under
`/tmp`, driven through `./git/maintain.sh --no-fetch --deep-optimize --only
'github.com/termux/termux-packages.git'`.

**SIGINT to the node process alone** (`kill -INT <node pid>`, the shape a
supervisor or `systemctl stop` has): node exited 130 immediately, the
`git gc --aggressive` child kept running as an orphan, and `flock -n` on the farm
lock **succeeded while that repack was still running**. A second sweep in that
window gets `fatal: gc is already running on machine '…' pid N (use --force if
not)`, exit 128 — and `git repack -adb`, which the optimizing pass also runs, has
no such guard: it returns 0 and repacks beside the first one.

**SIGINT to the whole process group** (what a terminal Ctrl-C does): node and the
git child both died. git cleaned up after itself — no `tmp_pack_*`, no `gc.pid`,
`git fsck --connectivity-only` clean, `garbage: 0` — but the step's work was gone
and the lock was free the moment the shell died.

**SIGKILL to the whole group**: the only residue was `gc.pid`. `git fsck` stayed
clean, `count-objects -v` reported `garbage: 0`, and the next `git gc` on that repo
returned 0 — a stale pid file from a dead process does not block a later gc.

**POSIX trap behaviour** (the shell half): with `trap … INT` installed, a
group SIGINT while a foreground child that traps the signal is running leaves the
shell alive, lets the child finish, and runs the trap _after_ the child completes.
Four lines in the wrapper are enough to keep the lock's holder alive; no
signal-forwarding protocol is needed.

**`execFile` ignores `detached`.** The first implementation passed
`{ detached: true }` to `execFile`; the child's PGID stayed the parent's, measured
three ways. Node's `execFile` builds its own spawn options from an allow-list that
does not include `detached`, so the option was silently dropped and a Ctrl-C still
killed the step. `spawn` honours it, which is why `git()` uses `spawn`.

So the repository is never _broken_ by an interrupt — git's temp-file-and-rename
design is why, and it is worth stating plainly rather than assuming it. What an
interrupt costs is the work, and what a half-delivered interrupt costs is the
lock's meaning.

## Decision

Three mechanisms, each answering one part of "stop, but not here":

**The refusal sits in `git()`, not in the steps.** `git/lib/stop-signal.mjs` holds
one process-wide request; `git()` calls `throwIfStopRequested()` _before_ it
spawns anything. Every sequence in this folder is written as a chain of `git()`
calls (fetch → config → gc → repack → commit-graph → `remote set-url`), so a
refusal inside `git()` turns every one of those chains into a stop _between_ its
steps without a single step function knowing that signals exist.

**The running step is detached, so a terminal signal cannot reach it.** `git()`
spawns with `detached: true`, which puts git and `pack-objects` in their own
process group. A Ctrl-C reaches the sweep's node process and the shell, never the
step, so the step finishes and the sweep reports the boundary it stopped at. The
abort path is the one that kills that group, deliberately, with SIGTERM and then
SIGKILL after 5 s.

**The second signal takes the step away.** `installStopHandler()` is called from
`runEntry`, the tail every entry in this folder shares (docs/d121), so the
behaviour is a property of the folder rather than a habit each tool must keep.
The first signal logs `stop requested — finishing the step in flight` with the
exit code; the second logs the abort, signals the tracked groups, and exits with
the signal's code even if a child needs the full grace.

**The shell keeps the lock alive across the boundary.** `with_farm_mutation_lock`
installs a trap for INT and TERM that only writes a line to stderr. Because POSIX
runs that trap after the foreground command completes, the shell — the lock
holder — exits _after_ node does, which is the whole reason the lock and the work
now die together in the order d164 argues for.

## Consequences

### A stopped sweep says what it did

`maintain-mirrors` counts a repo the stop refused as `skipped`, a repo whose step
was cut as `interrupted`, and adds `stopped: 1` to the summary. The exit status is
130 (SIGINT) or 143 (SIGTERM), not 1: a sweep the operator cut short is not a
sweep that failed, and an operator script that retries on 1 would otherwise
retry a deliberate stop. Both log shapes name the boundary, and an `interrupted`
repo is never reported as `ok`.

### Stopping costs the step, and that cost is visible

The measured run finished its `gc --aggressive` 32 s after the Ctrl-C and then
refused `repack`. That delay is the feature: the operator sees
`stop requested — finishing the step in flight` immediately, and the second signal
is the escape hatch when the step is slower than the patience for it. A stop that
returned instantly would have thrown that pass away instead.

### The discovery phase is not a boundary

A signal during the origin-URL probe (one `git config --get` per mirror) refuses
the next probe and aborts the entry without the summary line, because the probe
runs `pool` over an ungrouped list. Nothing is mutated yet at that point, so the
only loss is the log line.

### What is still not protected

- **A SIGKILLed parent leaves a detached child running.** After the sweep's node
  process is SIGKILLed, the shell's `wait` returns, the lock is released, and the
  detached repack continues. git's own `gc.pid` guard turns the next
  `gc` into a rc-128 failure rather than a second gc, and the unusable pack is
  never left behind, but `repack` has no such guard. This is the price of the
  detach: a signal no handler can run for is exactly the case a process group
  would have covered.
- **`git remote update` has no timeout.** A first signal during a hung fetch waits
  for git's own network timeouts. The second signal is the answer, and a
  per-invocation timeout is a separate decision.
- **Only `runEntry` callers get the handler.** `farm-tool.mjs` does not optimize
  or fetch, so nothing that mutates a mirror today sits outside it.

## Alternatives rejected

- **Die immediately, cleanly (no detach).** Fast, and it throws away the step on
  every Ctrl-C — the reported problem, not a fix for it.
- **`SIGSTOP` the child on the first signal.** Suspending `pack-objects` holds
  memory and locks for an unbounded time and cannot be resumed by a later run;
  finishing is shorter and leaves no state to resume.
- **Ignore the signals and print "kill -9 to stop".** A terminal operator's first
  Ctrl-C would appear to do nothing at all.
- **A persistent job queue with resumable passes.** The right long-term shape, and
  far larger than the problem: git's passes are individually crash-safe, so a
  per-repo boundary already gives a resumable sweep — the next run redoes only
  what did not finish.

## Verification status

Measured on this host (WSL2, btrfs, the scratch farms above): the orphan + free
lock before the change; the group signal before the change; the SIGKILL residue;
the POSIX trap ordering; `execFile`'s dropped `detached`; and, after the change,
one end-to-end `maintain.sh` run whose group SIGINT left the gc child alive and
the lock HELD at t+0.5/1/2 s, finished the step, reported
`interrupted: 1, stopped: 1`, exited 130 with `fsck` clean and `garbage: 0`.

`git/tests/git-stop-signal.test.mjs` pins the three properties without a farm: the
first signal finishes the step and starts nothing else (exit 130, first marker
present, second absent), the second signal aborts within the grace, and a
requested stop refuses the next `git()` before a child exists.

Not verified: a `SIGKILL`ed parent with a real farm-sized repack in flight (the
corner above is reasoned from the measured pieces, not run end to end), and any
host where `flock` is missing — that path warns and runs unlocked, so it has no
lock to outlive (docs/d099).
