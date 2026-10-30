/**
 * @fileoverview git-deep-optimize.test.mjs — pins the maintenance-pass ladder
 * of maintain-mirrors.mjs (docs/d089) from git's own argv: a git wrapper on
 * PATH records each invocation before exec'ing the real git, so the assertions
 * are about the commands maintenance actually spawns, not about function
 * wiring. Asserted: the default sweep never spawns gc; --deep-optimize
 * produces, per mirror, config then gc --aggressive followed by
 * repack -adb --write-bitmap-index and commit-graph write --reachable
 * --changed-paths (the re-run that gc's conditional bitmap write and its
 * changed-paths-less commit-graph cannot guarantee); --deep-optimize together
 * with --no-optimize aborts at argument parsing.
 *
 * Run: node --test
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
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
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], {
	encoding: "utf8",
}).stdout.trim();
assert.ok(REAL_GIT, "the wrapper must know the real git to exec into");

/**
 * Two bare mirrors on separate pseudo-hosts — the shape the by-host scheduler
 * groups on, so the deep run exercises the same queue a real farm does.
 * @param {string} root
 * @returns {void}
 */
function buildFarm(root) {
	for (const rel of ["host-a/one.git", "host-b/one.git"]) {
		const dir = join(root, rel);
		mkdirSync(dir, { recursive: true });
		execFileSync("git", ["init", "--bare", "-q", dir]);
		execFileSync("git", [
			"-C",
			dir,
			"remote",
			"add",
			"origin",
			"git@host.example:owner/one.git",
		]);
	}
}

/**
 * A git that logs then obeys. The wrapper is first on PATH for the maintained
 * child process only, so the test's own setup keeps using the real git.
 * @param {string} binDir
 * @param {string} gitLog
 * @returns {void}
 */
function installGitWrapper(binDir, _gitLog) {
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(binDir, "git"),
		`#!/bin/sh\nprintf '%s\n' "$*" >>"$GITLOG"\nexec ${REAL_GIT} "$@"\n`,
		{ mode: 0o755 },
	);
}

/**
 * The subcommand sequence one mirror saw, in spawn order. Wrapper lines are
 * the wrapped git's argv: "-C <repo> <subcommand...>".
 * @param {string} gitLog
 * @param {string} repo
 * @returns {string[]}
 */
function commandsFor(gitLog, repo) {
	return readFileSync(gitLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(" "))
		.filter((parts) => parts[0] === "-C" && parts[1] === repo)
		.map((parts) => parts.slice(2).join(" "));
}

/**
 * Run maintain-mirrors.mjs fetch-free (no network, no ssh fakery needed) and
 * return its structured logs.
 * @param {string} root
 * @param {string} binDir
 * @param {string} gitLog
 * @param {...string} args
 * @returns {{ logs: Record<string, unknown>[], status: number }}
 */
function runMaintain(root, binDir, gitLog, ...args) {
	const res = spawnSync(
		process.execPath,
		[MAINTAIN, "--root", root, "--no-fetch", ...args],
		{
			encoding: "utf8",
			env: {
				...process.env,
				GITLOG: gitLog,
				PATH: binDir + delimiter + (process.env.PATH ?? ""),
			},
			timeout: 60_000,
		},
	);
	const logs = `${res.stdout}\n${res.stderr}`
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
	return { logs, status: res.status };
}

/** @returns {{ dir: string, binDir: string, farm: string, gitLog: string }} */
function freshFarm() {
	const dir = mkdtempSync(join(tmpdir(), "maintain-passes-"));
	const farm = join(dir, "farm");
	const binDir = join(dir, "bin");
	const gitLog = join(dir, "git.log");
	buildFarm(farm);
	installGitWrapper(binDir, gitLog);
	return { dir, binDir, farm, gitLog };
}

test("the routine default sweep never spawns gc", () => {
	const { dir, binDir, farm, gitLog } = freshFarm();
	try {
		const { logs, status } = runMaintain(farm, binDir, gitLog);
		assert.equal(status, 0, "the sweep must succeed");
		assert.ok(
			logs.some((l) => l.msg === "maintenance summary" && l.failed === 0),
		);
		for (const rel of ["host-a/one.git", "host-b/one.git"]) {
			const cmds = commandsFor(gitLog, join(farm, rel));
			assert.equal(
				cmds.filter((c) => c === "gc" || c.startsWith("gc ")).length,
				0,
				"the routine pass must not run gc: delta recomputation is the deep pass's job",
			);
			assert.ok(cmds.includes("repack -adb --write-bitmap-index"));
			assert.ok(cmds.includes("commit-graph write --reachable --changed-paths"));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--deep-optimize runs config, gc --aggressive, then the pickaxe sequence — only where asked", () => {
	const { dir, binDir, farm, gitLog } = freshFarm();
	try {
		const { logs, status } = runMaintain(
			farm,
			binDir,
			gitLog,
			"--deep-optimize",
			"--only",
			"host-a/one.git",
		);
		assert.equal(status, 0, "the sweep must succeed");
		assert.ok(
			logs.some((l) => l.msg === "mirror maintained" && l.deep === 1),
			"the deep choice must be visible in the per-mirror log",
		);

		const deep = commandsFor(gitLog, join(farm, "host-a/one.git"));
		const iConfig = deep.indexOf("config gc.writeCommitGraph true");
		const iGc = deep.indexOf("gc --aggressive");
		const iRepack = deep.indexOf("repack -adb --write-bitmap-index");
		const iGraph = deep.indexOf("commit-graph write --reachable --changed-paths");
		for (const [name, i] of [["config", iConfig], ["gc", iGc], ["repack", iRepack], ["commit-graph", iGraph]]) {
			assert.ok(i !== -1, `the deep pass must run ${name}`);
		}
		assert.ok(
			iConfig < iGc && iGc < iRepack && iRepack < iGraph,
			"config first (gc.writeCommitGraph), then the forced repack, then the pack/graph sequence over the fresh pack",
		);
		assert.equal(
			deep.filter((c) => c === "repack -adb --write-bitmap-index").length,
			1,
			"exactly one pickaxe repack — after the aggressive one",
		);

		assert.deepEqual(
			commandsFor(gitLog, join(farm, "host-b/one.git")),
			[],
			"an --only-filtered mirror must not be touched at all",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--deep-optimize conflicts with --no-optimize", () => {
	const { dir, binDir, farm, gitLog } = freshFarm();
	try {
		const { logs, status } = runMaintain(
			farm,
			binDir,
			gitLog,
			"--deep-optimize",
			"--no-optimize",
		);
		assert.equal(status, 1, "an argv conflict must exit 1");
		const abort = logs.find((l) => l.msg === "maintenance aborted");
		assert.ok(abort, "an argv conflict must abort, not sweep");
		assert.ok(
			String(abort.error?.message ?? "").includes("--deep-optimize"),
			"the abort message must name the conflict",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
