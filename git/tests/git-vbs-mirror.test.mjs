/**
 * @fileoverview The VBS bulk-mirror port (docs/d044, docs/d121). The shell it
 * replaces is deleted, so these tests ARE the parity evidence: the manifest
 * extractor's field fallbacks, the identity/slug derivation, the clone URL per
 * transport, `--only`'s shell-glob semantics, the failure envelope and the exit
 * codes. Every case runs the real entry through node, because the port's whole
 * risk is in what the argv-to-envelope path does, not in one helper.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const UNIT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(UNIT_DIR, "vbs-mirror-all.mjs");

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [o]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(args, { cwd } = {}) {
	try {
		const stdout = execFileSync("node", [ENTRY, ...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout, stderr: "" };
	} catch (err) {
		const e = /** @type {any} */ (err);
		return {
			status: typeof e.status === "number" ? e.status : 1,
			stdout: String(e.stdout ?? ""),
			stderr: String(e.stderr ?? ""),
		};
	}
}

/**
 * A scratch dir holding one manifest, removed with the test.
 * @param {string} name
 * @param {unknown} manifest
 * @returns {{ dir: string, manifest: string }}
 */
function fixture(name, manifest) {
	const dir = mkdtempSync(join(tmpdir(), `vbs-${name}-`));
	const file = join(dir, "manifest.json");
	writeFileSync(file, JSON.stringify(manifest));
	return { dir, manifest: file };
}

/**
 * The error line's message, for asserting the envelope without its timestamp.
 * @param {string} stderr
 * @returns {string|undefined}
 */
function errorMessage(stderr) {
	const line = stderr
		.split("\n")
		.map((/** @type {string} */ l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.find((/** @type {any} */ o) => o?.level === "error");
	return line?.msg;
}

const TENANT = "https://vbs.example.com/";

test("--list prints identity, clone URL, and derives the slug from projectId", () => {
	const f = fixture("list", {
		base: TENANT,
		org: "acme",
		repositories: [
			{
				projectId: "acme_my-proj_1234",
				repo: "alpha",
				sshUrl: "ssh://vbs.example.com/acme_my-proj_1234/alpha.git",
			},
			// No sshUrl → the URL is BUILT, and `.git` is stripped from the name.
			{ projectId: "acme_other_99", repo: "beta.git" },
			// No projectSlug and no projectId → the literal "unknown" slug.
			{ repo: "gamma" },
		],
	});
	try {
		const out = run([
			"--manifest",
			f.manifest,
			"--dest",
			f.dir,
			"--list",
			"--ssh-user",
			"idcs-x",
		]);
		assert.equal(out.status, 0);
		const rows = [
			"acme/my-proj/alpha\tssh://idcs-x@vbs.example.com/acme_my-proj_1234/alpha.git",
			"acme/other/beta\tssh://idcs-x@vbs.example.com/acme_other_99/beta.git",
			"acme/unknown/gamma\tssh://idcs-x@vbs.example.com//gamma.git",
		];
		assert.equal(out.stdout, `${rows.join("\n")}\n`);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("the extractor accepts the projectGuid/slug/name/httpUrl spellings", () => {
	// A bare-array manifest is NOT covered: it carries no `base`, so the tenant
	// check refuses it before any row is read (the jq extractor's array branch
	// was unreachable for the same reason).
	const f = fixture("spellings", {
		base: TENANT,
		org: "acme",
		repositories: [
			{
				projectGuid: "acme_a_7",
				slug: "s",
				name: "arr",
				httpUrl: "https://vbs.example.com/acme/s/acme_a_7/scm/arr.git",
			},
		],
	});
	try {
		const out = run([
			"--manifest",
			f.manifest,
			"--dest",
			f.dir,
			"--list",
			"--transport",
			"https",
			"--http-user",
			"me@x",
		]);
		assert.equal(out.status, 0);
		assert.equal(
			out.stdout,
			"acme/s/arr\thttps://me@x@vbs.example.com/acme/s/acme_a_7/scm/arr.git\n",
		);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("a URL that already carries userinfo is left alone", () => {
	const f = fixture("userinfo", {
		base: TENANT,
		org: "acme",
		repositories: [
			{ projectId: "p", repo: "r", sshUrl: "ssh://already@host/x/y.git" },
		],
	});
	try {
		const out = run([
			"--manifest",
			f.manifest,
			"--dest",
			f.dir,
			"--list",
			"--ssh-user",
			"idcs-x",
		]);
		assert.equal(out.stdout, "acme/p/r\tssh://already@host/x/y.git\n");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("--only is a shell case glob: `*` crosses slashes, classes work", () => {
	const f = fixture("only", {
		base: TENANT,
		org: "acme",
		repositories: [
			{ projectId: "p1", projectSlug: "one", repo: "alpha" },
			{ projectId: "p2", projectSlug: "two", repo: "beta" },
			{ projectId: "p3", projectSlug: "plain", repo: "gamma" },
		],
	});
	try {
		/**
		 * @param {string} glob
		 * @returns {string[]}
		 */
		const identities = (glob) => {
			const out = run([
				"--manifest",
				f.manifest,
				"--dest",
				f.dir,
				"--list",
				"--only",
				glob,
			]);
			assert.equal(out.status, 0);
			return out.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => /** @type {string} */ (line.split("\t")[0]));
		};
		// `*` must cross the `/` separators — a path glob would match nothing here.
		assert.deepEqual(identities("acme/*/alpha"), ["acme/one/alpha"]);
		assert.deepEqual(identities("*/*/beta"), ["acme/two/beta"]);
		assert.deepEqual(identities("acme/?lain/gamma"), ["acme/plain/gamma"]);
		assert.deepEqual(identities("acme/[op]*/alpha"), ["acme/one/alpha"]);
		assert.deepEqual(identities("acme/[!o]ne/alpha"), []);
		assert.deepEqual(identities("acme/one/alpha"), ["acme/one/alpha"]);
		assert.deepEqual(identities("nope"), []);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("each refusal exits 1 with its own message", () => {
	const f = fixture("refusals", {
		base: TENANT,
		org: "acme",
		repositories: [{ projectId: "p", repo: "r" }],
	});
	const empty = fixture("empty", { base: TENANT, org: "acme" });
	const noBase = fixture("nobase", { org: "acme", repositories: [] });
	try {
		/** @type {[string[], string][]} */
		const cases = [
			[[], "no manifest: --manifest FILE (a vbs-har.sh export carries base + org)"],
			[
				["--manifest", join(f.dir, "nope.json"), "--dest", f.dir],
				"manifest not found",
			],
			[
				["--manifest", noBase.manifest, "--dest", f.dir],
				"no tenant origin: manifest has no base field",
			],
			[["--manifest", f.manifest], "no mirror dest: pass --dest DIR (or set WORK_MIRRORS)"],
			[
				["--manifest", f.manifest, "--dest", f.dir, "--transport", "ftp"],
				"--transport must be ssh or https",
			],
			[["--manifest", empty.manifest, "--dest", f.dir], "manifest has no repositories"],
			// WORK_MIRRORS is the one env read allowed to stand in for --dest.
		];
		for (const [args, message] of cases) {
			const out = run(args);
			assert.equal(out.status, 1, args.join(" "));
			assert.equal(errorMessage(out.stderr), message, args.join(" "));
		}
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
		rmSync(empty.dir, { recursive: true, force: true });
		rmSync(noBase.dir, { recursive: true, force: true });
	}
});

test("WORK_MIRRORS stands in for --dest; --dest wins over it", () => {
	const f = fixture("env", {
		base: TENANT,
		org: "acme",
		repositories: [{ projectId: "p", repo: "r" }],
	});
	try {
		// --list never touches git, so the env default is observable in the
		// "mirroring tenant" line without a real clone. Logs go to STDERR here:
		// stdout is this tool's payload stream, even when the payload is rows.
		const out = spawnSync("node", [ENTRY, "--manifest", f.manifest, "--list"], {
			encoding: "utf8",
			env: { ...process.env, WORK_MIRRORS: "/from/env" },
		});
		assert.equal(out.status, 0);
		assert.match(out.stderr, /"dest":"\/from\/env"/);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("--help prints the usage and exits 0", () => {
	const out = run(["--help"]);
	assert.equal(out.status, 0);
	assert.match(out.stdout, /^usage: -vbs-mirror-all\.sh --manifest FILE/);
	assert.match(out.stdout, /--throttle N {3}seconds between repositories/);
});

test("an unknown flag is refused through the folder's one error", () => {
	const out = run(["--bogus"]);
	assert.equal(out.status, 1);
	assert.match(out.stderr, /unknown flag \(try --help\)/);
	assert.match(out.stderr, /"--bogus"|"flag":"--bogus"/);
});

test("a real clone mirrors, the next run aligns, and a hard failure leaves nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "vbs-mirror-"));
	const origin = join(dir, "origin.git");
	const work = join(dir, "work");
	const dest = join(dir, "dest");
	const manifest = join(dir, "manifest.json");
	try {
		// A local origin stands in for the tenant: the ssh branch uses a
		// manifest URL verbatim, so a filesystem path IS a clone URL here.
		execFileSync("git", ["init", "-q", "--bare", origin]);
		execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
		writeFileSync(join(work, "f"), "one\n");
		execFileSync("git", ["-C", work, "add", "f"]);
		execFileSync("git", [
			"-C", work, "-c", "user.email=t@t", "-c", "user.name=t",
			"commit", "-qm", "one",
		]);
		execFileSync("git", ["-C", work, "push", "-q", "origin", "HEAD:refs/heads/main"]);
		writeFileSync(
			manifest,
			JSON.stringify({
				base: TENANT,
				org: "acme",
				repositories: [
					{ projectId: "p1", projectSlug: "one", repo: "local", sshUrl: origin },
					{ projectId: "p2", projectSlug: "two", repo: "gone", sshUrl: join(dir, "missing.git") },
				],
			}),
		);
		const args = [
			"--manifest", manifest, "--dest", dest,
			"--throttle", "0", "--retries", "0", "--cooldown", "0",
		];

		const first = run(args);
		assert.equal(first.status, 1, "one repo failed, so the sweep did");
		assert.ok(first.stderr.includes('"msg":"mirrored"'));
		assert.ok(
			first.stderr.includes('"msg":"step failed"'),
			"a missing origin is a HARD failure — no retry burns the rate budget",
		);
		assert.ok(first.stderr.includes('"msg":"summary"'));
		mkdirSync(join(dest, "acme", "one"), { recursive: true });
		assert.ok(
			execFileSync("git", ["-C", join(dest, "acme/one/local.git"), "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		);

		// Second run: the mirror is in place, so it takes the ALIGN path.
		const second = run(args);
		assert.equal(second.status, 1);
		assert.ok(second.stderr.includes('"msg":"aligned"'));
		// A half-written mirror would be mistaken for a good one later; the
		// failed clone must leave nothing behind.
		assert.equal(
			run([...args, "--only", "acme/two/gone"]).status,
			1,
			"the failed repo keeps failing",
		);
		assert.throws(() => execFileSync("git", ["-C", join(dest, "acme/two/gone.git"), "rev-parse", "HEAD"], { stdio: "ignore" }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
