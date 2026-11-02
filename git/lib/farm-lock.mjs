/**
 * @fileoverview farm-lock.mjs — the node side of the farm mutation lock: its
 * PATH, the flock PROBE, and the holder status file beside it. It deliberately
 * does not TAKE the lock.
 *
 * Taking it stays in `git/farm-lock.sh`: the mutating verbs of the farm tool
 * run the existing shell entries (`-forge-mirror.sh`, `maintain.sh`), which
 * wrap themselves in `with_farm_mutation_lock` — so the lock is held by the
 * same process that holds it today, and by exactly one mechanism. Node only
 * needs to (a) name the lock, (b) ask whether it is currently held, and
 * (c) write/read the queuer's self-description, because a status query must
 * answer from the truth (the flock state) and not from a file's existence.
 *
 * The path rule is a HAND COPY of `farm_mutation_lock_path` in farm-lock.sh
 * (docs/d113: each unit owns its copy). Two spellings of one fact is a drift
 * risk, so `git/tests/git-farm-lock.test.mjs` sources the shell function and
 * asserts both produce the same path — the shell copy stays authoritative.
 * The lock file lives in the per-user runtime dir, never in the farm: a
 * read-only session must leave the farm byte-identical, and a lock inside it
 * would itself be a write (docs/d099).
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The farm mutation lock path for this host/user.
 * @param {{ env?: Record<string, string|undefined>, uid?: number }} [o]
 * @returns {string}
 */
export function farmMutationLockPath({
	env = process.env,
	uid = typeof process.getuid === "function" ? process.getuid() : 0,
} = {}) {
	const runtime = env.XDG_RUNTIME_DIR;
	if (runtime) {
		return join(runtime, "agentcontainer-farm-mutation.lock");
	}
	// The /tmp fallback is shared, so the uid is part of the name.
	return join(env.TMPDIR || tmpdir(), `agentcontainer-farm-mutation-${uid}.lock`);
}

/**
 * Ask flock whether anyone holds the lock right now. The probe is the truth —
 * inferring a mutex from a file's existence is wrong in both directions (an
 * unlocked file exists; a deleted status file does not free a held lock).
 * @param {string} lockPath
 * @returns {"held"|"free"|"unknown"} unknown = no flock(1) on this host, and
 *   without the mechanism a guess would be a lie
 */
export function probeFarmMutationLock(lockPath) {
	const res = spawnSync("flock", ["-n", lockPath, "true"], {
		stdio: "ignore",
	});
	if (res.error) {
		return "unknown";
	}
	return res.status === 0 ? "free" : "held";
}

/**
 * The queuer/holder description that sits beside the lock. Written by a verb
 * BEFORE it blocks on flock, so "queued" is visible too, and removed on the
 * way out.
 * @param {string} lockPath
 * @returns {{ tool: string|null, pid: number|null, started: string|null,
 *   detail: string|null }|null}
 */
export function readLockHolder(lockPath) {
	const file = `${lockPath}.status`;
	if (!existsSync(file)) {
		return null;
	}
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return {
			tool: typeof parsed.tool === "string" ? parsed.tool : null,
			pid: typeof parsed.pid === "number" ? parsed.pid : null,
			started: typeof parsed.started === "string" ? parsed.started : null,
			detail: typeof parsed.detail === "string" ? parsed.detail : null,
		};
	} catch {
		// A half-written or hand-edited status file is not an error: the lock
		// state above it is still the answer, only the description is missing.
		return null;
	}
}

/**
 * @param {string} lockPath
 * @param {{ tool: string, detail: string, pid?: number }} o
 */
export function writeLockStatus(lockPath, { tool, detail, pid = process.pid }) {
	const file = `${lockPath}.status`;
	const tmp = `${file}.tmp`;
	const body = `${JSON.stringify({
		tool,
		pid,
		started: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		detail,
	})}\n`;
	// tmp+rename: a status reader must never see half a line (docs/d050's
	// atomic-write rule, the same one the artifact writer follows).
	writeFileSync(tmp, body, { mode: 0o600 });
	renameSync(tmp, file);
}

/** @param {string} lockPath */
export function clearLockStatus(lockPath) {
	const file = `${lockPath}.status`;
	if (existsSync(file)) {
		rmSync(file, { force: true });
	}
}
