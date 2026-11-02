/**
 * @fileoverview The node side of the farm mutation lock (docs/d121). The lock
 * itself stays in `git/farm-lock.sh` — node only names it, probes it, and
 * reads/writes the holder description. These tests pin the two things that
 * could silently rot: the path rule (a hand copy, asserted against the shell
 * function that stays authoritative) and the "probe the truth, not a file's
 * existence" rule.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	farmMutationLockPath,
	probeFarmMutationLock,
	readLockHolder,
	writeLockStatus,
} from "../lib/farm-lock.mjs";

const UNIT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The shell copy's answer, for the same environment.
 * @param {Record<string, string>} env
 */
function shellLockPath(env) {
	return execFileSync(
		"sh",
		["-c", ". ./farm-lock.sh && farm_mutation_lock_path"],
		{ cwd: UNIT_DIR, env: { ...process.env, ...env }, encoding: "utf8" },
	);
}

test("the path rule agrees with farm-lock.sh — XDG runtime dir", () => {
	const env = { XDG_RUNTIME_DIR: "/run/user/1234" };
	assert.equal(farmMutationLockPath({ env, uid: 1234 }), shellLockPath(env));
});

test("the path rule agrees with farm-lock.sh — /tmp fallback carries the uid", () => {
	// The fallback is what makes the uid load-bearing: /tmp is shared, so a
	// lock without it would serialize two different users against each other.
	const env = { XDG_RUNTIME_DIR: "", TMPDIR: "/tmp" };
	const path = farmMutationLockPath({ env, uid: 1000 });
	assert.equal(path, shellLockPath(env));
	assert.match(path, /agentcontainer-farm-mutation-1000\.lock$/);
});

test("a free lock probes free, and a held one probes held", async () => {
	const dir = mkdtempSync(join(tmpdir(), "farm-lock-"));
	const lock = join(dir, "mutation.lock");
	// Hold it the way the shell does (flock's fd mode) from ANOTHER process:
	// the probe must see a foreign holder, not its own file descriptor, which
	// is the whole reason the status file cannot answer this question.
	const holder = spawn(
		"sh",
		["-c", `exec 9>"${lock}" && flock 9 && echo held && sleep 30`],
		// Its own process group: the holder is `sh` PLUS the `sleep` that
		// inherited fd 9, so killing sh alone would leave the lock held.
		{ stdio: ["ignore", "pipe", "ignore"], detached: true },
	);
	try {
		await new Promise((resolve, reject) => {
			holder.stdout.on("data", resolve);
			holder.on("error", reject);
		});
		assert.equal(probeFarmMutationLock(lock), "held");
		holder.kill("SIGTERM");
		await new Promise((resolve) => {
			holder.on("exit", resolve);
		});
		assert.equal(probeFarmMutationLock(lock), "held", "sleep still holds fd 9");
		if (holder.pid !== undefined) {
			process.kill(-holder.pid, "SIGKILL");
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 100);
		});
		assert.equal(probeFarmMutationLock(lock), "free", "a dead holder frees it");
	} finally {
		if (holder.pid !== undefined) {
			try {
				process.kill(-holder.pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the holder description round-trips and is cleared without the lock", () => {
	const dir = mkdtempSync(join(tmpdir(), "farm-lock-"));
	const lock = join(dir, "mutation.lock");
	try {
		assert.equal(readLockHolder(lock), null, "no status file → no holder");
		writeLockStatus(lock, { tool: "farm-tool", detail: "upsert_repo URL" });
		const holder = readLockHolder(lock);
		assert.equal(holder?.tool, "farm-tool");
		assert.equal(holder?.detail, "upsert_repo URL");
		assert.equal(holder?.pid, process.pid);
		assert.match(
			String(holder?.started),
			/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
		);
		// A half-written status file must not throw: the flock state above it
		// is still the answer.
		writeFileSync(`${lock}.status`, "{not json");
		assert.equal(readLockHolder(lock), null);
		assert.match(readFileSync(`${lock}.status`, "utf8"), /not json/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
