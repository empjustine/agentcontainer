/**
 * @fileoverview d099's farm tool surface, end to end (docs/d099, docs/d121):
 * the ported entry's argv shapes, envelopes, caps, exit codes and the
 * stderr/stdout split. The shell it replaces was proven byte-identical against
 * these same verbs before deletion, so what is pinned here is the part a future
 * MCP façade will depend on: one JSON object on stdout, caps that are VISIBLE,
 * and a refusal that costs an exit code rather than a half-written payload.
 *
 * Every case runs the real entry through node against a throwaway farm.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const UNIT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(UNIT_DIR, "farm-tool.mjs");

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
	GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
};

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function git(cwd, args, env = {}) {
	const res = spawnSync("git", args, {
		cwd,
		env: { ...GIT_ENV, ...env },
		encoding: "utf8",
	});
	assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
	return res.stdout;
}

const README = "alpha line one\nsecond\nthird\n";

/**
 * One working repo, mirrored bare into the farm at `id`.
 * @param {string} root
 * @param {string} id
 * @param {(dir: string) => void} [populate]
 */
function mirror(root, id, populate) {
	const work = mkdtempSync(join(tmpdir(), "farm-work-"));
	git(work, ["init", "-q", "-b", "main", "."]);
	writeFileSync(join(work, "readme.txt"), README);
	mkdirSync(join(work, "src"), { recursive: true });
	writeFileSync(join(work, "src", "a.js"), "needle here\nnothing\n");
	writeFileSync(join(work, "bin.dat"), Buffer.from([0x00, 0x01, 0x41]));
	if (populate) {
		populate(work);
	}
	git(work, ["add", "-A"]);
	git(work, ["commit", "-qm", "initial commit with needle"]);
	writeFileSync(join(work, "later.txt"), "needle later\n");
	git(work, ["add", "-A"]);
	git(
		work,
		["commit", "-qm", "second commit needle too"],
		{ GIT_AUTHOR_DATE: "2024-02-01T00:00:00Z", GIT_COMMITTER_DATE: "2024-02-01T00:00:00Z" },
	);
	git(work, ["tag", "v1.0"]);
	git(work, ["branch", "feature/x"]);
	const dest = join(root, `${id}.git`);
	mkdirSync(dirname(dest), { recursive: true });
	git(root, ["clone", "-q", "--mirror", work, dest]);
	git(dest, ["remote", "set-url", "origin", `https://example.invalid/${id}`]);
	rmSync(work, { recursive: true, force: true });
}

/**
 * A throwaway farm plus the lock dir the maintenance verbs describe.
 * @returns {{ env: Record<string, string>, root: string, cleanup: () => void }}
 */
function farm() {
	const base = mkdtempSync(join(tmpdir(), "farm-tool-"));
	const root = join(base, "farm");
	const run = join(base, "run");
	mkdirSync(root, { recursive: true });
	mkdirSync(run, { recursive: true });
	mirror(root, "acme/alpha", (dir) => {
		writeFileSync(join(dir, "big.txt"), "x".repeat(300 * 1024));
	});
	mirror(root, "acme/beta");
	return {
		root,
		env: { REFERENCES_ROOT: root, XDG_RUNTIME_DIR: run },
		cleanup: () => rmSync(base, { recursive: true, force: true }),
	};
}

/**
 * @param {string[]} argv
 * @param {Record<string, string>} env
 * @returns {{ status: number, out: string, err: string, json: any }}
 */
function run(argv, env) {
	const res = spawnSync("node", [ENTRY, ...argv], {
		env: { ...process.env, ...env },
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const out = res.stdout;
	// `--help` answers with prose, every other verb with the one envelope.
	let json = null;
	if (out.startsWith("{")) {
		json = JSON.parse(out);
	}
	return { status: res.status ?? 1, out, err: res.stderr, json };
}

/**
 * The envelope's result array. Spelled as a helper so the mapping cases read as
 * assertions instead of type casts.
 * @param {any} envelope
 * @returns {any[]}
 */
function results(envelope) {
	const list = envelope?.results;
	return Array.isArray(list) ? list : [];
}

/** @param {string} stderr @returns {Record<string, any>[]} */
function logs(stderr) {
	return stderr
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

test("no tool prints the usage on stderr and exits 2", () => {
	const { env, cleanup } = farm();
	try {
		const res = run([], env);
		assert.equal(res.status, 2);
		assert.equal(res.out, "");
		assert.match(res.err, /^usage: \.\/git\/farm-tool\.sh TOOL/);
	} finally {
		cleanup();
	}
});

test("--help names the shim, never the .mjs behind it", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["--help"], env);
		assert.equal(res.status, 0);
		assert.match(res.out, /usage: \.\/git\/farm-tool\.sh TOOL/);
		assert.match(res.out, /git\/lib\/farm-posture\.mjs/);
		assert.doesNotMatch(res.out, /farm-tool\.mjs/);
		assert.equal(res.err, "");
	} finally {
		cleanup();
	}
});

test("an unknown tool is a 2 with the one failure envelope", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["nope"], env);
		assert.equal(res.status, 2);
		assert.deepEqual(res.json, {
			tool: "nope",
			ok: false,
			error: "unknown tool (try --help)",
			name: "nope",
		});
		// The same fact as a log line, with `call` rather than a second `tool`.
		const error = logs(res.err).find((l) => l.level === "error");
		assert.equal(error?.msg, "unknown tool (try --help)");
		assert.equal(error?.call, "nope");
		assert.equal(error?.tool, "git/farm-tool");
	} finally {
		cleanup();
	}
});

test("list_repos reports the farm sorted, with urls, refs and paging", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["list_repos"], env);
		assert.equal(res.status, 0);
		assert.equal(res.json.tool, "list_repos");
		assert.equal(res.json.ok, true);
		assert.equal(res.json.matches, 2);
		assert.equal(res.json.total, 2);
		assert.equal(res.json.truncated, false);
		assert.deepEqual(
			results(res.json).map((r) => r.id),
			["acme/alpha", "acme/beta"],
		);
		const alpha = results(res.json)[0];
		assert.equal(alpha.url, "https://example.invalid/acme/alpha");
		assert.equal(alpha.default_branch, "main");
		assert.ok(alpha.ref_count >= 3, `ref_count ${alpha.ref_count}`);

		const first = run(["list_repos", "*", "0", "1"], env);
		assert.equal(first.json.total, 1);
		assert.equal(first.json.truncated, true);
		const second = run(["list_repos", "*", "1", "1"], env);
		assert.deepEqual(
			results(second.json).map((r) => r.id),
			["acme/beta"],
		);
		assert.equal(second.json.truncated, false);
	} finally {
		cleanup();
	}
});

test("list_repos' filter is a case-glob, and a bad one is refused", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["list_repos", "acme/a*"], env);
		assert.deepEqual(
			results(res.json).map((r) => r.id),
			["acme/alpha"],
		);
		assert.equal(res.json.matches, 1);

		const bad = run(["list_repos", "-x"], env);
		assert.equal(bad.status, 2);
		assert.equal(bad.json.error, "invalid glob (leading -)");
	} finally {
		cleanup();
	}
});

test("list_refs types every ref from its name", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["list_refs", "acme/alpha"], env);
		assert.equal(res.status, 0);
		const byRef = new Map(results(res.json).map((r) => [r.ref, r.type]));
		assert.equal(byRef.get("refs/heads/main"), "branch");
		assert.equal(byRef.get("refs/heads/feature/x"), "branch");
		assert.equal(byRef.get("refs/tags/v1.0"), "tag");
		assert.match(
			results(res.json)[0].sha,
			/^[0-9a-f]{40}$|^[0-9a-f]{64}$/,
			"a ref reports the object it points at",
		);
		const missing = run(["list_refs", "acme/nope"], env);
		assert.equal(missing.status, 3);
		assert.equal(missing.json.error, "no such mirror in the farm");
	} finally {
		cleanup();
	}
});

test("search_code pins hits to the searched commit and filters paths", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["search_code", "needle", "acme/*"], env);
		assert.equal(res.status, 0);
		assert.equal(res.json.repos_matched, 2);
		assert.ok(res.json.total >= 2);
		for (const hit of res.json.results) {
			assert.ok(["acme/alpha", "acme/beta"].includes(hit.repo));
			assert.match(hit.commit_sha, /^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
			assert.equal(typeof hit.line, "number");
			assert.match(hit.text, /needle/);
		}
		// The glob applies to paths AFTER grep matched, so it can only narrow.
		const byPath = run(["search_code", "needle", "acme/alpha", "src/*"], env);
		assert.deepEqual(
			results(byPath.json).map((h) => h.path),
			["src/a.js"],
		);
		assert.match(results(byPath.json)[0].text, /needle here/);

		const capped = run(["search_code", "needle", "acme/*", "*", "fixed", "1"], env);
		assert.equal(capped.json.total, 1);
		assert.equal(capped.json.truncated, true);

		// regex mode is git grep's default (BRE), so `.` is a metacharacter and
		// the literal spelling must not match.
		const regex = run(["search_code", "ne.dle here", "acme/alpha", "*", "regex"], env);
		assert.equal(regex.status, 0);
		assert.equal(regex.json.total, 1);
		const literal = run(["search_code", "ne.dle here", "acme/alpha", "*", "fixed"], env);
		assert.equal(literal.json.total, 0);

		const bogus = run(["search_code", "needle", "acme/*", "*", "fuzzy"], env);
		assert.equal(bogus.status, 2);
		assert.equal(bogus.json.error, "MODE must be fixed or regex");
	} finally {
		cleanup();
	}
});

test("search_code refuses a runaway fan-out and lets WIDE=1 attempt it", () => {
	const { env, cleanup } = farm();
	try {
		// 65 empty mirrors: past the bound, and unreadable, so a WIDE run has to
		// skip them rather than fail.
		for (let i = 1; i <= 65; i += 1) {
			const dest = join(String(env.REFERENCES_ROOT), `bulk/p${i}.git`);
			mkdirSync(dest, { recursive: true });
			git(dest, ["init", "-q", "--bare", "."]);
		}
		const refused = run(["search_code", "needle", "bulk/*"], env);
		assert.equal(refused.status, 4);
		assert.equal(
			refused.json.error,
			"live-grep fan-out exceeded — narrow the repo filter, or pass WIDE=1 to attempt it",
		);
		assert.equal(refused.json.repos, "65");
		assert.equal(refused.json.bound, "64");

		const wide = run(
			["search_code", "needle", "bulk/*", "*", "fixed", "10", "0", "1"],
			env,
		);
		assert.equal(wide.status, 0);
		assert.equal(wide.json.total, 0);
		assert.ok(
			logs(wide.err).some((l) => l.msg === "unreadable HEAD — skipped"),
			"a mirror without a readable HEAD is skipped, not fatal",
		);
	} finally {
		cleanup();
	}
});

test("search_paths names files and pins them to HEAD", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["search_paths", "src/*", "acme/alpha"], env);
		assert.equal(res.status, 0);
		assert.deepEqual(
			results(res.json).map((r) => r.path),
			["src/a.js"],
		);
		assert.match(results(res.json)[0].commit_sha, /^[0-9a-f]{40}|[0-9a-f]{64}/);

		const empty = run(["search_paths", "", "acme/alpha"], env);
		assert.equal(empty.status, 2);
		assert.equal(empty.json.error, "empty path glob");
	} finally {
		cleanup();
	}
});

test("read_file pages a pinned blob and reports the truncation it caused", () => {
	const { env, cleanup } = farm();
	try {
		const whole = run(["read_file", "acme/alpha", "HEAD", "readme.txt"], env);
		assert.equal(whole.status, 0);
		assert.equal(whole.json.content, README);
		assert.equal(whole.json.truncated, false);
		assert.equal(whole.json.offset, 1);
		assert.equal(whole.json.limit, 200);

		const page = run(
			["read_file", "acme/alpha", "HEAD", "readme.txt", "2", "1"],
			env,
		);
		assert.equal(page.json.content, "second\n");
		assert.equal(page.json.truncated, true, "a line past the window exists");

		const last = run(
			["read_file", "acme/alpha", "HEAD", "readme.txt", "3", "1"],
			env,
		);
		assert.equal(last.json.content, "third\n");
		assert.equal(last.json.truncated, false);

		const pinned = run(["read_file", "acme/alpha", "HEAD~1", "later.txt"], env);
		assert.equal(pinned.status, 3, "later.txt does not exist one commit back");
		assert.equal(pinned.json.error, "no such path at rev");

		const blob = run(["read_file", "acme/alpha", "HEAD", "bin.dat"], env);
		assert.equal(blob.json.content, "A", "C0 bytes are dropped, not shipped");
	} finally {
		cleanup();
	}
});

test("read_file's byte cap truncates visibly, and its refusals are stated", () => {
	const { env, cleanup } = farm();
	try {
		const capped = run(["read_file", "acme/alpha", "HEAD", "big.txt"], env);
		assert.equal(capped.status, 0);
		assert.equal(capped.json.truncated, true);
		assert.equal(Buffer.byteLength(capped.json.content), 262_144);

		const unknownRev = run(["read_file", "acme/alpha", "nope", "readme.txt"], env);
		assert.equal(unknownRev.status, 3);
		assert.equal(unknownRev.json.error, "unknown rev");

		const tree = run(["read_file", "acme/alpha", "HEAD", "src"], env);
		assert.equal(tree.status, 3);
		assert.equal(tree.json.error, "not a blob");

		const offset = run(["read_file", "acme/alpha", "HEAD", "readme.txt", "0"], env);
		assert.equal(offset.status, 2);
		assert.equal(offset.json.error, "OFFSET is 1-based");
	} finally {
		cleanup();
	}
});

test("search_history is a pickaxe with a path glob and a date floor", () => {
	const { env, cleanup } = farm();
	try {
		const all = run(["search_history", "needle", "acme/alpha"], env);
		assert.equal(all.status, 0);
		assert.deepEqual(
			results(all.json).map((r) => r.subject),
			["second commit needle too", "initial commit with needle"],
		);
		assert.equal(results(all.json)[0].date, "2024-02-01T00:00:00Z");

		const byPath = run(
			["search_history", "needle", "acme/alpha", "later*"],
			env,
		);
		assert.deepEqual(
			results(byPath.json).map((r) => r.subject),
			["second commit needle too"],
		);

		const since = run(
			["search_history", "needle", "acme/alpha", "*", "2023-01-01"],
			env,
		);
		assert.equal(since.json.total, 2);
		const future = run(
			["search_history", "needle", "acme/alpha", "*", "2030-01-01"],
			env,
		);
		assert.equal(future.json.total, 0);

		const capped = run(
			["search_history", "needle", "acme/alpha", "*", "", "0", "1"],
			env,
		);
		assert.equal(capped.json.total, 1);
		assert.equal(capped.json.truncated, true);
	} finally {
		cleanup();
	}
});

test("diff returns a patch, an empty patch for an unmatched glob, and a cap", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["diff", "acme/alpha", "HEAD~1", "HEAD", "later*"], env);
		assert.equal(res.status, 0);
		assert.match(res.json.patch, /^diff --git a\/later\.txt/m);
		assert.equal(res.json.truncated, false);
		assert.match(res.json.commit_sha_a, /^[0-9a-f]{40}|[0-9a-f]{64}/);

		// The keep-all trap: no matching pathspec must mean NO patch, never the
		// whole repo.
		const none = run(["diff", "acme/alpha", "HEAD~1", "HEAD", "nothing*"], env);
		assert.equal(none.json.patch, "");
		assert.equal(none.json.truncated, false);

		const capped = run(["diff", "acme/alpha", "HEAD~1", "HEAD", "*", "40"], env);
		assert.equal(capped.json.truncated, true);
		assert.equal(Buffer.byteLength(capped.json.patch), 40);

		const over = run(
			["diff", "acme/alpha", "HEAD~1", "HEAD", "*", "999999999"],
			env,
		);
		assert.equal(over.status, 2);
		assert.equal(over.json.error, "MAX may not exceed the server cap");
		assert.equal(over.json.server_cap, "262144");

		const unknown = run(["diff", "acme/alpha", "nope", "HEAD"], env);
		assert.equal(unknown.status, 3);
		assert.equal(unknown.json.error, "unknown rev");
	} finally {
		cleanup();
	}
});

test("maintenance_status answers from the lock, not from a status file", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["maintenance_status"], env);
		assert.equal(res.status, 0);
		assert.equal(res.json.locked, false);
		assert.equal(res.json.holder, null);
		assert.equal(
			res.json.lock_path,
			join(String(env.XDG_RUNTIME_DIR), "agentcontainer-farm-mutation.lock"),
		);
	} finally {
		cleanup();
	}
});

test("the maintenance verbs refuse before any child runs", () => {
	const { env, cleanup } = farm();
	try {
		const mode = run(["compact_repo", "acme/alpha", "bogus"], env);
		assert.equal(mode.status, 2);
		assert.equal(mode.json.error, "MODE must be optimize or deep");

		const missing = run(["compact_repo", "acme/nope"], env);
		assert.equal(missing.status, 3);

		// A leading `-` must never reach the child: `-h` would print help and
		// read as success.
		const url = run(["upsert_repo", "-h"], env);
		assert.equal(url.status, 2);
		assert.equal(url.json.error, "invalid url (leading -)");

		const empty = run(["upsert_repo", ""], env);
		assert.equal(empty.status, 2);
		assert.equal(empty.json.error, "empty url");
	} finally {
		cleanup();
	}
});

test("a missing farm is a 3, not an empty result", () => {
	const res = run(["list_repos"], {
		REFERENCES_ROOT: "/nonexistent/farm-for-tests",
		XDG_RUNTIME_DIR: tmpdir(),
	});
	assert.equal(res.status, 3);
	assert.equal(res.json.error, "farm root not found");
	assert.equal(res.json.root, "/nonexistent/farm-for-tests");
	assert.equal(res.json.tool, "list_repos");
});

test("the payload stream carries one JSON object and nothing else", () => {
	const { env, cleanup } = farm();
	try {
		const res = run(["search_code", "needle", "acme/alpha"], env);
		const lines = res.out.split("\n").filter((line) => line !== "");
		assert.equal(lines.length, 1);
		assert.doesNotThrow(() => JSON.parse(String(lines[0])));
	} finally {
		cleanup();
	}
});
