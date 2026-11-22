/**
 * @fileoverview git-export-patches.test.mjs — pins the export as a ROUND TRIP,
 * not as a file listing (docs/d229). A patch series is right only if git can
 * rebuild the branch from it, so the central case applies every patch with
 * `git am` and compares the resulting tree with the exported branch's — over an
 * empty commit, a real binary blob, a rename and a mode change. Also pinned:
 * names sort into apply order, a branch with no upstream exports against
 * origin/HEAD, --base names its own starting point, a rerun swaps the series
 * whole, a crashed run's litter is recovered by the next run, and a failed run
 * leaves the previous series untouched.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const UNIT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(UNIT_DIR, "export-patches.mjs");

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
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function run(args, cwd) {
	const res = spawnSync(process.execPath, [ENTRY, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...IDENTITY },
	});
	return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * A bare origin holding one base commit, and a `feature` branch five commits
 * ahead of it: a text append, an empty commit, a binary blob with NUL bytes and
 * bytes that are not valid UTF-8, a rename, and a mode change. The branch has
 * no upstream, which is also the fallback case.
 * @returns {{ root: string, origin: string, work: string }}
 */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "export-patches-"));
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
	git(work, ["commit", "-qam", "second: append a line"]);
	git(work, ["commit", "-q", "--allow-empty", "-m", "third: changes nothing"]);
	writeFileSync(
		join(work, "blob.bin"),
		Buffer.from([0x61, 0x00, 0x62, 0xff, 0xfe, 0x7f, 0x0a]),
	);
	git(work, ["add", "blob.bin"]);
	git(work, ["commit", "-qm", "fourth: binary blob"]);
	git(work, ["mv", "a.txt", "renamed.txt"]);
	git(work, ["commit", "-qm", "fifth: rename"]);
	chmodSync(join(work, "renamed.txt"), 0o755);
	git(work, ["commit", "-qam", "sixth: executable"]);
	return { root, origin, work };
}

/**
 * @param {string} work
 * @returns {string[]} the commits the series covers, oldest first
 */
function expectedHashes(work) {
	return git(work, [
		"rev-list",
		"--reverse",
		"--no-merges",
		"origin/main..HEAD",
	]).split("\n");
}

/**
 * @param {string} root
 * @param {string} work
 * @returns {string} the published series directory
 */
function exportSeries(root, work) {
	const out = join(root, "series");
	const res = run(["--repo", work, "--out", out], root);
	assert.equal(res.status, 0, res.stderr);
	return out;
}

/**
 * @param {string} out
 * @returns {string[]} file names, lexicographically — which is apply order
 */
function seriesNames(out) {
	// readdir's own ENOENT is the answer when the export wrote nothing
	// (docs/d228); a guard here would only hide it.
	return readdirSync(out).sort();
}

/**
 * @param {string} root
 * @param {string} prefix
 * @returns {string[]}
 */
function litterBeside(root, prefix) {
	return readdirSync(root).filter((name) => name.startsWith(prefix));
}

test("names sort into apply order and every file is an mbox patch", () => {
	const { root, work } = fixture();
	try {
		const out = exportSeries(root, work);
		const names = seriesNames(out);
		const hashes = expectedHashes(work);
		assert.equal(names.length, hashes.length);
		hashes.forEach((hash, index) => {
			const expected = `${String(index + 1).padStart(4, "0")}-${hash}.git.patch`;
			assert.equal(names[index], expected);
			// Latin-1, so the bytes are read as they are: the "From " line is
			// the commit's identity inside the file and it is ASCII.
			const body = readFileSync(join(out, expected), "latin1");
			assert.ok(body.startsWith(`From ${hash} `), expected);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("applying the series rebuilds the branch", () => {
	const { root, origin, work } = fixture();
	try {
		const out = exportSeries(root, work);
		const applied = join(root, "applied");
		execFileSync("git", ["clone", "-q", origin, applied], { env: { ...process.env, ...IDENTITY } });
		git(applied, ["checkout", "-q", "-B", "main", "origin/main"]);
		for (const name of seriesNames(out)) {
			const res = spawnSync(
				"git",
				["-C", applied, "am", "-q", "--empty=keep", join(out, name)],
				{ encoding: "utf8", env: { ...process.env, ...IDENTITY } },
			);
			assert.equal(res.status, 0, `${name}: ${res.stderr}`);
		}
		const hashes = expectedHashes(work);
		assert.equal(git(applied, ["rev-list", "--count", "origin/main..HEAD"]), String(hashes.length));
		assert.equal(git(applied, ["rev-parse", "HEAD^{tree}"]), git(work, ["rev-parse", "HEAD^{tree}"]));
		// The byte-for-byte half: a decoded pipe would have turned these bytes
		// into U+FFFD and the tree check above would still have differed on it,
		// but this says WHY.
		assert.deepEqual(
			readFileSync(join(applied, "blob.bin")),
			readFileSync(join(work, "blob.bin")),
		);
		assert.equal(git(applied, ["ls-tree", "HEAD", "renamed.txt"]).startsWith("100755"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a branch with no upstream exports against origin/HEAD", () => {
	const { root, work } = fixture();
	try {
		const out = join(root, "series");
		const res = run(["--repo", work, "--out", out, "--json"], root);
		assert.equal(res.status, 0, res.stderr);
		const report = JSON.parse(res.stdout);
		assert.equal(report.base, "origin/main");
		assert.equal(report.patches.length, expectedHashes(work).length);
		assert.match(report.applyWith, /^git am --empty=keep .*\/\*\.git\.patch$/);
		assert.equal(report.patches[0].bytes > 0, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--base names its own starting point", () => {
	const { root, work } = fixture();
	try {
		const out = join(root, "series");
		const res = run(["--repo", work, "--out", out, "--base", "feature~2"], root);
		assert.equal(res.status, 0, res.stderr);
		const hashes = git(work, ["rev-list", "--reverse", "--no-merges", "feature~2..HEAD"]).split("\n");
		assert.equal(seriesNames(out).length, hashes.length);
		assert.ok(seriesNames(out)[0]?.includes(hashes[0] ?? ""), "the first patch is the first commit");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a rerun replaces the series whole and leaves no litter", () => {
	const { root, work } = fixture();
	try {
		const out = exportSeries(root, work);
		const first = seriesNames(out).length;
		writeFileSync(join(work, "later.txt"), "later\n");
		git(work, ["add", "later.txt"]);
		git(work, ["commit", "-qm", "seventh: later"]);
		const again = exportSeries(root, work);
		assert.equal(seriesNames(again).length, first + 1);
		assert.deepEqual(litterBeside(root, ".series"), [], "no .new-/.old- beside the target");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a crashed run's litter is recovered by the next run", () => {
	const { root, work } = fixture();
	try {
		const out = exportSeries(root, work);
		const names = seriesNames(out);
		renameSync(out, join(root, ".series.old-999"));
		mkdirSync(join(root, ".series.new-999"));
		writeFileSync(join(root, ".series.new-999", "half.patch"), "half\n");
		const res = run(["--repo", work, "--out", out], root);
		assert.equal(res.status, 0, res.stderr);
		assert.match(res.stderr, /restored the series a previous run moved aside/);
		assert.deepEqual(seriesNames(out), names);
		assert.deepEqual(litterBeside(root, ".series"), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed run leaves the previous series untouched", () => {
	const { root, work } = fixture();
	try {
		const out = exportSeries(root, work);
		const names = seriesNames(out);
		const res = run(["--repo", work, "--out", out, "--base", "nosuchref"], root);
		assert.equal(res.status, 1);
		assert.deepEqual(seriesNames(out), names);
		assert.deepEqual(litterBeside(root, ".series"), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nothing to export says so and writes nothing", () => {
	const { root, work } = fixture();
	try {
		const out = join(root, "series");
		const res = run(["--repo", work, "--out", out, "--base", "HEAD"], root);
		assert.equal(res.status, 0, res.stderr);
		assert.match(res.stdout, /nothing to export/);
		assert.deepEqual(litterBeside(root, "series"), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a directory that is not a repository is named as such", () => {
	const { root } = fixture();
	try {
		const res = run(["--repo", join(root, "nowhere"), "--out", join(root, "series")], root);
		assert.equal(res.status, 1);
		assert.match(res.stdout + res.stderr, /not a git repository/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--help prints the usage", () => {
	const res = run(["--help"], process.cwd());
	assert.equal(res.status, 0);
	assert.match(res.stdout, /usage: \.\/node-run\.sh git\/export-patches\.mjs/);
});

