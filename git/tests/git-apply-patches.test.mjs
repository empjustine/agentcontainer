/**
 * @fileoverview git-apply-patches.test.mjs — the receiving end of the series is
 * pinned by what SURVIVES a failure, not by what a successful run printed
 * (docs/d229). A transport that leaves the receiver half-patched is worse than
 * one that refuses, so every failure case here asserts the same three things:
 * the branch is where the run found it, the work tree is clean, and the local
 * work that was there before is still there. The centre of the file is the
 * round trip (export, then apply onto a fresh clone of the same origin) and the
 * store-and-forward case (`--3way` over context that drifted).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const UNIT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const APPLY = join(UNIT_DIR, "apply-patches.mjs");
const EXPORT = join(UNIT_DIR, "export-patches.mjs");

/** @type {Record<string, string>} */
const IDENTITY = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...IDENTITY },
	}).trim();
}

/**
 * @param {string} entry
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function run(entry, args, cwd) {
	const res = spawnSync(process.execPath, [entry, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...IDENTITY },
	});
	return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * A bare origin holding one base commit and a `feature` branch four commits
 * ahead of it: an append, a new file, an empty commit, and a blob whose bytes
 * are not valid UTF-8. The branch has no upstream, so the export falls back to
 * origin/HEAD the way the unbranched case does.
 * @returns {{ root: string, origin: string, work: string }}
 */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "apply-patches-"));
	const origin = join(root, "origin.git");
	execFileSync("git", ["init", "--bare", "-q", origin]);
	git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	const work = join(root, "work");
	mkdirSync(work);
	git(work, ["init", "-q"]);
	writeFileSync(join(work, "a.txt"), "one\n");
	git(work, ["add", "a.txt"]);
	git(work, ["commit", "-qm", "base"]);
	git(work, ["remote", "add", "origin", origin]);
	git(work, ["push", "-q", "origin", "HEAD:main"]);
	git(work, ["fetch", "-q", "origin"]);
	git(work, ["remote", "set-head", "origin", "-a"]);
	git(work, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(work, "a.txt"), "one\ntwo\n");
	git(work, ["commit", "-qam", "append a line"]);
	writeFileSync(join(work, "b.txt"), "bee\n");
	git(work, ["add", "b.txt"]);
	git(work, ["commit", "-qm", "add b"]);
	git(work, ["commit", "-q", "--allow-empty", "-m", "empty but real"]);
	writeFileSync(join(work, "blob.bin"), Buffer.from([0x61, 0x00, 0xff, 0xfe, 0x0a]));
	git(work, ["add", "blob.bin"]);
	git(work, ["commit", "-qm", "binary blob"]);
	return { root, origin, work };
}

/**
 * The series the export entry writes for `work` — the pair is the transport, so
 * the receiving test builds its input with the sending tool rather than with
 * fixture patches hand-written to match.
 * @param {string} root
 * @param {string} work
 * @returns {string}
 */
function seriesFor(root, work) {
	const out = join(root, "series");
	const res = run(EXPORT, ["--repo", work, "--out", out], root);
	assert.equal(res.status, 0, res.stderr);
	return out;
}

/**
 * @param {string} origin
 * @param {string} dir
 * @returns {string} the clone's path, on `main` at origin/main
 */
function cloneOf(origin, dir) {
	execFileSync("git", ["clone", "-q", origin, dir], { env: { ...process.env, ...IDENTITY } });
	git(dir, ["checkout", "-q", "-B", "main", "origin/main"]);
	return dir;
}

/**
 * The three things a failed run must leave true.
 * @param {string} dir
 * @param {string} head
 */
function assertUntouched(dir, head) {
	assert.equal(git(dir, ["rev-parse", "HEAD"]), head, "the branch is where the run found it");
	assert.equal(git(dir, ["status", "--porcelain"]), "", "the work tree is clean");
}

/**
 * A bare origin, one base commit holding a 20-line file, and a `feature` branch
 * that rewrites line 10. The receiver's drift lands on line 7 — inside the
 * hunk's context window, but on a line the patch does not change — which is the
 * shape a literal diff refuses and a 3-way merge resolves.
 * @returns {{ root: string, origin: string, work: string }}
 */
function driftFixture() {
	const root = mkdtempSync(join(tmpdir(), "apply-3way-"));
	const origin = join(root, "origin.git");
	git(root, ["init", "--bare", "-q", origin]);
	git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	const work = join(root, "work");
	mkdirSync(work);
	git(work, ["init", "-q"]);
	const lines = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
	writeFileSync(join(work, "f.txt"), `${lines.join("\n")}\n`);
	git(work, ["add", "f.txt"]);
	git(work, ["commit", "-qm", "base"]);
	git(work, ["remote", "add", "origin", origin]);
	git(work, ["push", "-q", "origin", "HEAD:main"]);
	git(work, ["fetch", "-q", "origin"]);
	git(work, ["remote", "set-head", "origin", "-a"]);
	git(work, ["checkout", "-q", "-b", "feature"]);
	lines[9] = "line10 PATCHED";
	writeFileSync(join(work, "f.txt"), `${lines.join("\n")}\n`);
	git(work, ["commit", "-qam", "rewrite line 10"]);
	return { root, origin, work };
}

test("applying the series rebuilds the branch", () => {
	const { root, origin, work } = fixture();
	try {
		const series = seriesFor(root, work);
		const rx = cloneOf(origin, join(root, "rx"));
		const before = git(rx, ["rev-parse", "HEAD"]);
		const res = run(APPLY, ["--repo", rx, "--series", series], root);
		assert.equal(res.status, 0, res.stderr);
		assert.equal(
			git(rx, ["rev-parse", "HEAD^{tree}"]),
			git(work, ["rev-parse", "HEAD^{tree}"]),
		);
		assert.equal(git(rx, ["rev-list", "--count", `${before}..HEAD`]), "4");
		assert.match(res.stdout, /undo: git reset --hard /);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a series that is already applied leaves the branch where it was", () => {
	const { root, origin, work } = fixture();
	try {
		const series = seriesFor(root, work);
		const rx = cloneOf(origin, join(root, "rx"));
		assert.equal(run(APPLY, ["--repo", rx, "--series", series], root).status, 0);
		const head = git(rx, ["rev-parse", "HEAD"]);
		const res = run(APPLY, ["--repo", rx, "--series", series], root);
		assert.equal(res.status, 1);
		assert.match(res.stderr, /the series did not apply/);
		assertUntouched(rx, head);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a conflict halfway through reverses the commits it made", () => {
	const { root, origin, work } = fixture();
	try {
		const series = seriesFor(root, work);
		const rx = cloneOf(origin, join(root, "rx"));
		// Patch 1 (append a line) applies and is COMMITTED; patch 2 creates
		// b.txt, which is already here with other content. The rollback has to
		// undo the commit too, not just the patch that failed.
		writeFileSync(join(rx, "b.txt"), "squatter\n");
		git(rx, ["add", "b.txt"]);
		git(rx, ["commit", "-qm", "squat b"]);
		const head = git(rx, ["rev-parse", "HEAD"]);
		const res = run(APPLY, ["--repo", rx, "--series", series], root);
		assert.equal(res.status, 1);
		assertUntouched(rx, head);
		assert.equal(readFileSync(join(rx, "b.txt"), "utf8"), "squatter\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a dirty work tree is refused and its edit survives", () => {
	const { root, origin, work } = fixture();
	try {
		const series = seriesFor(root, work);
		const rx = cloneOf(origin, join(root, "rx"));
		writeFileSync(join(rx, "a.txt"), "one\nlocal edit\n");
		const head = git(rx, ["rev-parse", "HEAD"]);
		const res = run(APPLY, ["--repo", rx, "--series", series], root);
		assert.equal(res.status, 1);
		assert.equal(git(rx, ["rev-parse", "HEAD"]), head);
		assert.equal(readFileSync(join(rx, "a.txt"), "utf8"), "one\nlocal edit\n");
		assert.equal(git(rx, ["status", "--porcelain"]), "M a.txt");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--3way merges context that the plain apply refuses", () => {
	const { root, origin, work } = driftFixture();
	try {
		const series = seriesFor(root, work);
		const rx = cloneOf(origin, join(root, "rx"));
		const drifted = readFileSync(join(rx, "f.txt"), "utf8").split("\n");
		drifted[6] = "line7 DRIFTED";
		writeFileSync(join(rx, "f.txt"), drifted.join("\n"));
		git(rx, ["commit", "-qam", "drift: rewrite line 7"]);
		const head = git(rx, ["rev-parse", "HEAD"]);
		const plain = run(APPLY, ["--repo", rx, "--series", series], root);
		assert.equal(plain.status, 1, "a literal diff cannot place the hunk");
		assertUntouched(rx, head);
		const three = run(APPLY, ["--repo", rx, "--series", series, "--3way"], root);
		assert.equal(three.status, 0, three.stderr);
		const body = readFileSync(join(rx, "f.txt"), "utf8").split("\n");
		assert.equal(body[6], "line7 DRIFTED", "the receiver's line survives");
		assert.equal(body[9], "line10 PATCHED", "and so does the patch's");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an empty series says so and applies nothing", () => {
	const { root, work } = fixture();
	try {
		mkdirSync(join(root, "empty"));
		const head = git(work, ["rev-parse", "HEAD"]);
		const res = run(APPLY, ["--repo", work, "--series", join(root, "empty")], root);
		assert.equal(res.status, 0, res.stderr);
		assert.match(res.stdout, /nothing to apply/);
		assertUntouched(work, head);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a directory with no series names it and the missing-read", () => {
	const { root, work } = fixture();
	try {
		const res = run(APPLY, ["--repo", work, "--series", join(root, "nowhere")], root);
		assert.equal(res.status, 1);
		assert.match(res.stderr, /no patch series here/);
		assert.match(res.stderr, /ENOENT/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--json reports both ends of the apply and an undo", () => {
	const { root, origin, work } = fixture();
	try {
		const series = seriesFor(root, work);
		const rx = cloneOf(origin, join(root, "rx"));
		const before = git(rx, ["rev-parse", "HEAD"]);
		const res = run(APPLY, ["--repo", rx, "--series", series, "--json"], root);
		assert.equal(res.status, 0, res.stderr);
		const report = JSON.parse(res.stdout);
		assert.equal(report.branch, "main");
		assert.equal(report.headBefore, before);
		assert.equal(report.commits.length, 4);
		assert.equal(report.undo, `git reset --hard ${before}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--help prints the usage", () => {
	const res = run(APPLY, ["--help"], process.cwd());
	assert.equal(res.status, 0);
	assert.match(res.stdout, /usage: \.\/node-run\.sh git\/apply-patches\.mjs/);
});

