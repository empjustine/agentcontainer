/**
 * @fileoverview The farm tool's safety posture (docs/d099, docs/d121): the
 * allowlist validators, the farm's discovery rule, the one glob question, and
 * the byte window `read_file` cuts. These are the rules a verb must not be able
 * to re-decide, so they are tested where they live rather than through a verb.
 *
 * The discovery case asserts the node walk against the SHELL rule it replaces
 * (`find -mindepth 2 -maxdepth 6 -type d -name '*.git'` plus a HEAD test): the
 * farm tool now shares git-core's structural walk, and a divergence here would
 * mean list_repos and the mirroring scripts describe different farms.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CAPS,
	CollectWindow,
	FarmError,
	blobLineWindow,
	farmRoot,
	listRepoIds,
	requireGlob,
	requirePath,
	requireRepoId,
	requireRev,
	requireSince,
	requireUint,
	selectRepos,
	stripControl,
	stripControlBytes,
} from "../lib/farm-posture.mjs";

/** @param {string} dir @param {string} name */
function bareRepo(dir, name) {
	const path = join(dir, `${name}.git`);
	mkdirSync(path, { recursive: true });
	const res = spawnSync("git", ["init", "-q", "--bare", path], {
		encoding: "utf8",
	});
	assert.equal(res.status, 0, res.stderr);
	return path;
}

/**
 * A fixture farm with every shape the discovery rule has to classify: nested
 * mirrors, a mirror too deep to reach, a non-mirror bare repo, and a `*.git`
 * directory that is not bare at all.
 * @returns {{ root: string, cleanup: () => void }}
 */
function fixtureFarm() {
	const root = mkdtempSync(join(tmpdir(), "farm-posture-"));
	bareRepo(root, "github/acme/alpha");
	bareRepo(root, "gitlab/acme/beta");
	bareRepo(root, "deep/a/b/c/d/e/f"); // depth 7 from the root: out of range
	mkdirSync(join(root, "plain"), { recursive: true }); // bare repo, no .git
	const notBare = join(root, "github", "work.git");
	mkdirSync(notBare, { recursive: true });
	writeFileSync(join(notBare, "HEAD"), "ref: refs/heads/main\n");
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("discovery matches the shell rule the port replaced", () => {
	const { root, cleanup } = fixtureFarm();
	try {
		// The rule as farm-tool-lib.sh spelled it, run for real.
		const shell = execFileSync(
			"sh",
			[
				"-c",
				`find "$1" -mindepth 2 -maxdepth 6 -type d -name '*.git' | while IFS= read -r d; do
					[ -f "$d/HEAD" ] || continue
					rel=\${d#"$1"/}
					printf '%s\\n' "\${rel%.git}"
				done | sort`,
				"sh",
				root,
			],
			{ encoding: "utf8" },
		)
			.split("\n")
			.filter((line) => line !== "");
		const node = listRepoIds(root);
		// The `.git` directory that is not a mirror is the ONE deliberate
		// narrowing: the shell accepted any directory with a HEAD, which an
		// interrupted clone can leave behind. git-core's rule (HEAD + objects +
		// refs) is the structural truth, and a mirror missing objects has
		// nothing to list refs from.
		assert.deepEqual(
			node,
			shell.filter((id) => id !== "github/work"),
			`node: ${node.join(",")} shell: ${shell.join(",")}`,
		);
		assert.ok(node.includes("github/acme/alpha"));
		assert.ok(node.includes("gitlab/acme/beta"));
		assert.ok(
			!node.some((id) => id.startsWith("deep/")),
			"a mirror past the farm's depth is not a member",
		);
		assert.ok(
			!node.some((id) => id.startsWith("plain")),
			"the farm's naming rule is `*.git`, not bareness alone",
		);
	} finally {
		cleanup();
	}
});

test("discovery is sorted — a cursor is only a promise over a stable order", () => {
	const { root, cleanup } = fixtureFarm();
	try {
		const ids = listRepoIds(root);
		assert.deepEqual(ids, [...ids].sort());
	} finally {
		cleanup();
	}
});

test("the repo filter is a shell case-glob: `*` crosses `/`", () => {
	const { root, cleanup } = fixtureFarm();
	try {
		assert.deepEqual(selectRepos(root, "github/*").ids, ["github/acme/alpha"]);
		assert.deepEqual(selectRepos(root, "*acme*").ids, [
			"github/acme/alpha",
			"gitlab/acme/beta",
		]);
		assert.deepEqual(selectRepos(root, "*/*beta").ids, ["gitlab/acme/beta"]);
		assert.deepEqual(selectRepos(root).ids.length, 2);
	} finally {
		cleanup();
	}
});

/**
 * Every refusal a verb can produce from a payload, in one table: the code, the
 * message and the field the envelope reports are all part of d099's contract.
 * @type {[string, string, number, string, Record<string, string>][]}
 */
const REFUSALS = [
	["repo id", "", 2, "invalid repo id", { id: "" }],
	["repo id", "-x", 2, "invalid repo id", { id: "-x" }],
	["repo id", "/abs", 2, "invalid repo id", { id: "/abs" }],
	["repo id", "a/../b", 2, "invalid repo id", { id: "a/../b" }],
	["repo id", "a b", 2, "invalid repo id", { id: "a b" }],
	["repo id", "a\\b", 2, "invalid repo id", { id: "a\\b" }],
	["repo id", "a:b", 2, "invalid repo id", { id: "a:b" }],
	["repo id", "a*", 2, "invalid repo id (glob metacharacter)", { id: "a*" }],
	["repo id", "a[0]", 2, "invalid repo id (glob metacharacter)", { id: "a[0]" }],
	["repo id", "a?", 2, "invalid repo id (glob metacharacter)", { id: "a?" }],
	["rev", "", 2, "invalid rev", { rev: "" }],
	["rev", "--upload-pack=x", 2, "invalid rev", { rev: "--upload-pack=x" }],
	["rev", "HEAD;id", 2, "invalid rev", { rev: "HEAD;id" }],
	["path", "", 2, "invalid path", { path: "" }],
	["path", "-n", 2, "invalid path", { path: "-n" }],
	["path", "/etc/passwd", 2, "invalid path", { path: "/etc/passwd" }],
	["path", "a/../../b", 2, "invalid path", { path: "a/../../b" }],
	["glob", "-x", 2, "invalid glob (leading -)", { glob: "-x" }],
	["glob", "a]b", 2, "invalid glob (allowlist)", { glob: "a]b" }],
	["glob", "a;b", 2, "invalid glob (allowlist)", { glob: "a;b" }],
	["since", "", 2, "invalid since value", { since: "" }],
	["since", "-1 day", 2, "invalid since value", { since: "-1 day" }],
	["since", "2024;rm", 2, "invalid since value", { since: "2024;rm" }],
	["uint", "-1", 2, "expected a non-negative integer", { value: "-1" }],
	["uint", "", 2, "expected a non-negative integer", { value: "" }],
	["uint", "1e3", 2, "expected a non-negative integer", { value: "1e3" }],
];

for (const [kind, value, code, message, fields] of REFUSALS) {
	test(`refuses ${kind} ${JSON.stringify(value)}`, () => {
		const validator =
			kind === "repo id"
				? requireRepoId
				: kind === "rev"
					? requireRev
					: kind === "path"
						? requirePath
						: kind === "glob"
							? requireGlob
							: kind === "since"
								? requireSince
								: requireUint;
		assert.throws(
			() => validator(value),
			(err) => {
				assert.ok(err instanceof FarmError);
				assert.equal(err.code, code);
				assert.equal(err.message, message);
				assert.deepEqual(err.fields, fields);
				return true;
			},
		);
	});
}

test("validators keep the value they accepted", () => {
	assert.equal(requireRepoId("github/acme/alpha"), "github/acme/alpha");
	assert.equal(requireRev("feature/x~2^"), "feature/x~2^");
	assert.equal(requirePath("docs/a b.md"), "docs/a b.md");
	assert.equal(requireGlob(""), "");
	assert.equal(requireGlob("src/*.js"), "src/*.js");
	assert.equal(requireSince("2024-01-01T00:00:00Z"), "2024-01-01T00:00:00Z");
	assert.equal(requireUint("42"), 42);
});

test("the farm root is REFERENCES_ROOT before any host default", () => {
	assert.equal(
		farmRoot({ env: { REFERENCES_ROOT: "/farm", HOME: "/home/x" } }),
		"/farm",
	);
});

test("read_file's window slices bytes, including a last line with no newline", () => {
	const bytes = Buffer.from("a\nb", "utf8");
	assert.deepEqual(blobLineWindow(bytes, 1, 1), {
		chunk: Buffer.from("a\n"),
		more: true,
	});
	assert.deepEqual(blobLineWindow(bytes, 2, 1), {
		chunk: Buffer.from("b"),
		more: false,
	});
	assert.deepEqual(blobLineWindow(bytes, 1, 2), {
		chunk: Buffer.from("a\nb"),
		more: false,
	});
	// Past the end: sed prints nothing, and nothing further exists.
	assert.deepEqual(blobLineWindow(bytes, 3, 1), {
		chunk: Buffer.alloc(0),
		more: false,
	});
});

test("a blank line past the window is not 'more' — the shell read one byte", () => {
	// `printf '\n\n\n'` is three empty lines; line 2 is a bare newline, so the
	// one-byte probe the shell used saw nothing.
	const bytes = Buffer.from("\n\n\n", "utf8");
	assert.deepEqual(blobLineWindow(bytes, 1, 1), {
		chunk: Buffer.from("\n"),
		more: false,
	});
	assert.deepEqual(blobLineWindow(bytes, 2, 1), {
		chunk: Buffer.from("\n"),
		more: false,
	});
});

test("stripControlBytes drops C0 but keeps tab and newline", () => {
	const input = Buffer.from([0x00, 0x09, 0x0a, 0x0b, 0x1f, 0x41, 0x80]);
	assert.deepEqual([...stripControlBytes(input)], [0x09, 0x0a, 0x41, 0x80]);
	assert.equal(stripControl("a\u0000b\tc\nd"), "ab\tc\nd");
});

test("the collect window distinguishes a caller's cursor from truncation", () => {
	const window = new CollectWindow(2, 2);
	for (const hit of ["a", "b", "c", "d", "e"]) {
		window.collect(hit);
	}
	assert.deepEqual(window.hits, ["c", "d"]);
	assert.equal(window.truncated, true);
	assert.equal(window.full(), true);

	const paged = new CollectWindow(0, 1);
	paged.collect("a");
	assert.equal(paged.truncated, false);
	assert.equal(paged.full(), false);
	assert.equal(CAPS.maxResults, 200);
});
