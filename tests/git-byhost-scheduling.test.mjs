/**
 * @fileoverview git-byhost-scheduling.test.mjs — pins the by-host scheduler
 * and per-host pacing of maintain-mirrors.mjs (docs/d076) from the only
 * evidence that cannot lie about concurrency: timestamps. A fake `ssh` on
 * PATH records when each of its invocations starts and ends; the farm is two
 * fake hosts plus one upstream-less mirror. Asserted: no same-host overlap
 * ever (whatever `--jobs` says), the idle interval between one host's
 * consecutive fetches (1 s by default, none with `--min-interval 0`), and
 * cross-host overlap present by default but impossible with `--jobs 1`.
 *
 * The fetches themselves fail on purpose (the fake ssh exits 0 with no
 * protocol output), which is the fail-fast shape maintain must have anyway —
 * a logged fetch failure per mirror, never a hang (docs/d075). The
 * scheduling evidence is the ssh log either way.
 *
 * Run: node --test
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAINTAIN = join(REPO_ROOT, "git", "maintain-mirrors.mjs");
/** Fake-ssh session length — wide enough to make overlaps unambiguous. */
const FAKE_FETCH_MS = 600;
const SECOND_NS = 1_000_000_000;

/**
 * Bare mirrors whose origins point at the fake hosts, plus one mirror with
 * no upstream at all (the `(local)` bucket, docs/d076).
 * @param {string} root
 * @returns {void}
 */
function buildFarm(root) {
	const mirrors = {
		"host-a/one.git": "git@host-a.example:owner/one.git",
		"host-a/two.git": "git@host-a.example:owner/two.git",
		"host-b/one.git": "git@host-b.example:owner/one.git",
		"local/lonely.git": null,
	};
	for (const [rel, origin] of Object.entries(mirrors)) {
		const dir = join(root, rel);
		mkdirSync(dir, { recursive: true });
		execFileSync("git", ["init", "--bare", "-q", dir]);
		if (origin) {
			execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
		}
	}
}

/**
 * @param {string} binDir
 * @returns {void}
 */
function installFakeSsh(binDir) {
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(binDir, "ssh"),
		`#!/bin/sh
printf 'S %s %s\\n' "$*" "$(date +%s%N)" >>"$SSHLOG"
sleep ${FAKE_FETCH_MS / 1000}
printf 'E %s %s\\n' "$*" "$(date +%s%N)" >>"$SSHLOG"
exit 0
`,
		{ mode: 0o755 },
	);
}

/**
 * Run maintain-mirrors.mjs against the farm. A nonzero tally is the tool's
 * designed exit 1 (the fake ssh fails every fetch); anything worse is an
 * abort and a test failure.
 * @param {string} root
 * @param {string} binDir
 * @param {string} sshLog
 * @param {...string} args
 * @returns {{ stderrLines: Record<string, unknown>[], status: number }}
 */
function runMaintain(root, binDir, sshLog, ...args) {
	const res = spawnSync(
		process.execPath,
		[MAINTAIN, "--root", root, "--no-optimize", ...args],
		{
			encoding: "utf8",
			env: {
				...process.env,
				SSHLOG: sshLog,
				PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
			},
			timeout: 60_000,
		},
	);
	assert.ok(res.status !== null, `maintain crashed: ${res.stderr}`);
	assert.ok(
		res.status <= 1,
		`maintain aborted (status ${res.status}): ${res.stderr}`,
	);
	const stderrLines = res.stderr
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	// An aborted run also exits 1, so the tally's designed exit code alone
	// cannot tell "expected fetch failures" from "crashed halfway".
	const aborted = stderrLines.find((l) => l.level === "error");
	assert.equal(aborted, undefined, `maintain aborted: ${aborted?.msg} ${aborted?.error?.message ?? ""}`);
	return { stderrLines, status: res.status };
}

/**
 * Parse the fake-ssh log into fetch intervals. Starts are stacked per host
 * and popped by that host's end, so the parse is order-independent — which
 * it must be, since interleaved same-host lines are the failure being tested
 * for, not an assumption the parser may make.
 * @param {string} sshLog
 * @returns {{ host: string, start: number, end: number }[]}
 */
function readFetches(sshLog) {
	/** @type {Map<string, number[]>} */
	const starts = new Map();
	const intervals = [];
	for (const line of readFileSync(sshLog, "utf8").split("\n")) {
		if (!line) continue;
		const firstSpace = line.indexOf(" ");
		const kind = line.slice(0, firstSpace);
		const rest = line.slice(firstSpace + 1);
		const lastSpace = rest.lastIndexOf(" ");
		const args = rest.slice(0, lastSpace);
		const host = /host-[ab]\.example/.exec(args)?.[0];
		assert.ok(host, `fake ssh saw an unexpected host: ${args}`);
		let stack = starts.get(host);
		if (!stack) {
			stack = [];
			starts.set(host, stack);
		}
		if (kind === "S") {
			stack.push(Number(rest.slice(lastSpace + 1)));
			continue;
		}
		const start = stack.pop();
		assert.ok(start !== undefined, "fake ssh ended without a start");
		intervals.push({ host, start, end: Number(rest.slice(lastSpace + 1)) });
	}
	return intervals;
}

/**
 * @param {{ host: string, start: number, end: number }[]} intervals
 * @param {boolean} sameHost
 * @returns {number} pairs whose spans overlap
 */
function countOverlaps(intervals, sameHost) {
	let overlaps = 0;
	for (let i = 0; i < intervals.length; i += 1) {
		for (let j = i + 1; j < intervals.length; j += 1) {
			const a = intervals[i];
			const b = intervals[j];
			if ((a.host === b.host) !== sameHost) continue;
			if (a.start < b.end && b.start < a.end) overlaps += 1;
		}
	}
	return overlaps;
}

/**
 * The smallest idle gap between one host's consecutive fetches, in ns.
 * @param {{ host: string, start: number, end: number }[]} intervals
 * @returns {number}
 */
function minSameHostGapNs(intervals) {
	/** @type {Map<string, { start: number, end: number }[]>} */
	const byHost = new Map();
	for (const f of intervals) {
		const list = byHost.get(f.host) ?? [];
		list.push(f);
		byHost.set(f.host, list);
	}
	let min = Number.POSITIVE_INFINITY;
	for (const list of byHost.values()) {
		list.sort((a, b) => a.start - b.start);
		for (let i = 1; i < list.length; i += 1) {
			min = Math.min(min, list[i].start - list[i - 1].end);
		}
	}
	return min;
}

test("by-host scheduling: one job per host, per-host pacing (docs/d076)", () => {
	const tmp = mkdtempSync(join(tmpdir(), "git-byhost-"));
	try {
		const root = join(tmp, "farm");
		const binDir = join(tmp, "bin");
		const sshLog = join(tmp, "ssh.log");
		mkdirSync(root, { recursive: true });
		buildFarm(root);
		installFakeSsh(binDir);

		// Run 1 — defaults: one worker per host, 1 s of idle per host.
		writeFileSync(sshLog, "");
		const run1 = runMaintain(root, binDir, sshLog);
		const discovery1 = run1.stderrLines.find(
			(l) => l.msg === "discovered bare mirrors",
		);
		assert.equal(discovery1?.hosts, 3, "host-a + host-b + the (local) bucket");
		assert.equal(discovery1?.jobs, 3, "default = every discovered host");
		assert.equal(discovery1?.minInterval, 1);
		assert.equal(discovery1?.softwareForgeMinInterval, 30);
		assert.equal(run1.status, 1, "fake-ssh fetches fail; exit 1 by tally");
		const lonely = run1.stderrLines.find(
			(l) => l.msg === "no upstream — cannot align; optimize only",
		);
		assert.match(String(lonely?.repo ?? ""), /local\/lonely\.git$/);

		const fetches1 = readFetches(sshLog);
		assert.ok(
			fetches1.filter((f) => f.host === "host-a.example").length >= 2,
			"host-a's mirrors were both attempted",
		);
		assert.equal(countOverlaps(fetches1, true), 0, "no same-host overlap");
		assert.ok(
			minSameHostGapNs(fetches1) >= 0.9 * SECOND_NS,
			"default interval sits between one host's fetches",
		);
		assert.ok(
			countOverlaps(fetches1, false) > 0,
			"different hosts still fetch in parallel",
		);

		// Run 2 — --min-interval 0: pacing off, the by-host rule intact.
		writeFileSync(sshLog, "");
		runMaintain(root, binDir, sshLog, "--min-interval", "0");
		const fetches2 = readFetches(sshLog);
		assert.equal(countOverlaps(fetches2, true), 0);
		assert.ok(
			minSameHostGapNs(fetches2) < 0.5 * SECOND_NS,
			"--min-interval 0 really disables the idle gap",
		);

		// Run 3 — --jobs 1: one host at a time, so not even cross-host overlap.
		writeFileSync(sshLog, "");
		const run3 = runMaintain(root, binDir, sshLog, "--jobs", "1");
		const discovery3 = run3.stderrLines.find(
			(l) => l.msg === "discovered bare mirrors",
		);
		assert.equal(discovery3?.jobs, 1, "--jobs caps the hosts in flight");
		const fetches3 = readFetches(sshLog);
		assert.equal(countOverlaps(fetches3, true), 0);
		assert.equal(countOverlaps(fetches3, false), 0);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
