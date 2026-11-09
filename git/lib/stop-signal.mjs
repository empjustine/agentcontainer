/**
 * @fileoverview stop-signal.mjs — what a signal means to a sweep: stop at the
 * next step boundary, never mid-step.
 *
 * WHY the boundary is the whole point: an interrupted `git gc` does not corrupt
 * a mirror (git writes `tmp_pack_*` and renames on success — measured: fsck
 * clean and `garbage: 0` after SIGINT and after SIGKILL), but the work is
 * discarded, and a git child that OUTLIVES its parent is actively harmful: the
 * parent's exit drops the farm lock (docs/d099) while the repack still runs, so
 * the next sweep collides with a repack it cannot see — `git gc` then refuses
 * with "gc is already running" (rc 128) while `git repack -adb` does not refuse
 * at all. docs/d164 owns the measurements and the decision.
 *
 * The contract every entry inherits through `runEntry`:
 *
 *   - the FIRST SIGINT/SIGTERM requests a stop: `throwIfStopRequested()` refuses
 *     the next step, and the step already running is allowed to finish;
 *   - the SECOND signal aborts: tracked git children get SIGTERM, then SIGKILL
 *     after the grace, and the process exits with the signal's code.
 *
 * One process, one request. A sweep per process is the only shape these entries
 * have, and a controller threaded through each `git()` call would put this
 * policy at call sites that cannot see a signal arrive.
 */

import { logError, logWarn } from "./log.mjs";

/**
 * The exit status a shell reports for an interrupted command: 128 + the
 * signal's number. A stopped sweep must not look like a failed one (1).
 */
const EXIT_CODE = { SIGINT: 130, SIGTERM: 143 };

/**
 * How long a tracked child gets to clean up after SIGTERM. The same 5 s the
 * host's own exec convention allows before SIGKILL (docs/d150).
 */
const KILL_GRACE_MS = 5000;

/** @type {string|null} */
let request = null;
let installed = false;
/** @type {Set<import("node:child_process").ChildProcess>} */
const children = new Set();

/**
 * The refusal `throwIfStopRequested()` throws. Carried as a class, not a flag
 * check at the call site, so a caller can tell "this step was refused because
 * the operator asked" from "this step failed" (they are reported differently).
 */
export class StopRequested extends Error {
  /**
   * @param {string} signal the requesting signal
   * @param {boolean} [abortedStep] true when the step that was running was
   *   taken away (second signal); false when it was refused before it started.
   *   The mirror is consistent either way — the flag is what lets the report
   *   say which happened (docs/d164)
   */
  constructor(signal, abortedStep = false) {
    super(`stopped by ${signal}`);
    this.name = "StopRequested";
    this.signal = signal;
    this.abortedStep = abortedStep;
  }
}

/** @returns {string|null} the requesting signal, or null while running normally */
export function stopRequested() {
  return request;
}

/** @returns {number} 130/143 while a stop is requested, 0 otherwise */
export function stopExitCode() {
  return request ? EXIT_CODE[request] : 0;
}

/** Refuse the next unit of work while a stop is requested; return otherwise. */
export function throwIfStopRequested() {
  const signal = request;
  if (signal) {
    throw new StopRequested(signal);
  }
}

/**
 * Register a child git process so the abort path can find it. Registered by
 * `git()` for every invocation, which is why no step function knows about
 * signals.
 * @param {import("node:child_process").ChildProcess} child
 */
export function trackChild(child) {
  children.add(child);
}

/** @param {import("node:child_process").ChildProcess} child */
export function untrackChild(child) {
  children.delete(child);
}

/**
 * Signal a child's whole process group. The group is the target because
 * `git()` spawns detached: a repack's real work is in `git pack-objects`, a
 * child of git, and killing git alone leaves it writing.
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalGroup(child, signal) {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone (or never existed): a finished child needs
    // no signal, and there is nothing else to tell.
  }
}

/**
 * Install the two-signal handler. Called once per entry from `runEntry`, so a
 * new tool cannot forget it.
 */
export function installStopHandler() {
  if (installed) {
    return;
  }
  installed = true;
  /** @param {string} signal */
  const handle = (signal) => {
    if (!request) {
      request = signal;
      logWarn("stop requested — finishing the step in flight", {
        signal,
        exitCode: EXIT_CODE[signal],
        abort: "signal again",
      });
      return;
    }
    logError("aborting the git step in flight", {
      signal,
      running: children.size,
    });
    for (const child of children) {
      signalGroup(child, "SIGTERM");
    }
    // Deliberately not unref'd: the process has to outlive the grace, because
    // a second signal means "now", not "when convenient". A child that exits
    // on SIGTERM ends the run earlier through the normal path, which is why
    // this timer is the backstop rather than the mechanism.
    setTimeout(() => {
      for (const child of children) {
        signalGroup(child, "SIGKILL");
      }
      process.exit(stopExitCode());
    }, KILL_GRACE_MS);
  };
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}
