/**
 * @fileoverview export-patches.mjs — write the commits the local branch
 * carries and its upstream does not, as the patch series git reads back
 * (docs/d229).
 *
 * The format is git's own: each file is what `git format-patch` writes, an
 * email-shaped (mbox) patch — `From <sha>` line, author, date, subject,
 * diffstat, diff — which is exactly what `git am` consumes. The series is
 * therefore not a report ABOUT the difference, it IS the difference: applied to
 * the base it reproduces the branch commit for commit. `--binary` keeps a blob
 * change inside the series (format-patch omits binary hunks without it, and a
 * patch that cannot carry the blob cannot reproduce the commit), and
 * `--no-signature` drops the tool-version trailer, the only part of the file
 * that describes this host instead of the commit.
 *
 * Names are `<ordinal>-<full-hash>.git.patch`, the ordinal zero-padded to the
 * series width, so a plain lexicographic sort of the directory is the apply
 * order and the hash resolves without the repository. Apply in glob order, or
 * with the sibling entry that rolls back instead of leaving a half-patched
 * branch (docs/d229):
 *
 *   git am --empty=keep <dir>/*.git.patch
 *
 * `--empty=keep` because an exported commit may change nothing (dropping those
 * would not reproduce the branch) and `git am` stops on an empty patch by
 * default.
 *
 * Writing is a SWAP, never an update in place (docs/d228 R8/R10): the series is
 * built in `.<out>.new-<pid>` beside the target and published by one rename, so
 * a failed export leaves the previous series whole, and a run that died leaves
 * litter the next run removes instead of a directory that looks current.
 *
 * Usage:
 *   ./node-run.sh git/export-patches.mjs [--repo DIR] [--base REF]
 *                                        [--out DIR] [--json]
 *
 *   --repo DIR  repository to export from (default ".")
 *   --base REF  first commit NOT in the series (default: the branch's
 *               upstream, else origin/HEAD, for a branch not pushed yet)
 *   --out DIR   directory the series is published into (default
 *               `<repo>/.git-patches`; dot-prefixed, so a farm walk ignores it)
 *   --json      emit the series as JSON on stdout instead of text
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parseFlags, runEntry } from "./lib/cli.mjs";
import { git, logInfo, logWarn, setLogTool } from "./lib/git-core.mjs";

setLogTool("git/export-patches");

/** Field separator for `git log --format`: a subject is one line and a ref name
 * cannot hold a 0x1f, so the split needs no quoting. */
const UNIT = "\x1f";

const USAGE =
	"usage: ./node-run.sh git/export-patches.mjs [--repo DIR] [--base REF]\n" +
	"                                          [--out DIR] [--json]\n";

/**
 * @typedef {object} Options
 * @property {string} repo
 * @property {string} base
 * @property {string} out
 * @property {boolean} json
 * @property {boolean} help
 */

/**
 * @typedef {object} Commit
 * @property {string} hash
 * @property {string} subject
 */

/**
 * @typedef {object} Patch
 * @property {string} file bare file name inside the series directory
 * @property {string} hash
 * @property {string} subject
 * @property {number} bytes
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
	const { values, help } = parseFlags(argv, {
		repo: { default: "." },
		base: { default: "" },
		out: { default: "" },
		json: { kind: "bool" },
	});
	const repo = resolve(values.repo);
	return {
		repo,
		base: values.base,
		out: resolve(values.out || join(repo, ".git-patches")),
		json: values.json,
		help,
	};
}

/**
 * The commit the series starts from. The branch's own upstream is what "not
 * pushed yet" means; a branch that has never been pushed has none, and the
 * remote's default branch then answers the same question. Both are git's
 * answer — an absent upstream is the ref lookup's exit status, not a probe.
 * @param {string} repo
 * @param {string} explicit
 * @returns {Promise<string>}
 */
async function resolveBase(repo, explicit) {
	if (explicit) {
		return explicit;
	}
	for (const args of [
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		["rev-parse", "--abbrev-ref", "origin/HEAD"],
	]) {
		const r = await git(repo, args, { must: false });
		const ref = r.stdout.trim();
		if (r.code === 0 && ref) {
			return ref;
		}
	}
	throw new Error("no upstream to start from — name the base with --base REF");
}


/**
 * @param {string} repo
 * @param {string} base
 * @returns {Promise<Commit[]>} oldest first, which is apply order
 */
async function commitsSince(repo, base) {
	const r = await git(repo, [
		"log",
		"--reverse",
		"--no-merges",
		"--format=%H%x1f%s",
		"--end-of-options",
		`${base}..HEAD`,
	]);
	/** @type {Commit[]} */
	const commits = [];
	for (const line of r.stdout.split("\n")) {
		if (!line) {
			continue;
		}
		const [hash, subject] = line.split(UNIT);
		if (hash === undefined) {
			continue;
		}
		commits.push({ hash, subject: subject ?? "" });
	}
	return commits;
}

/**
 * Merges are not in the series: format-patch renders one only as a combined
 * diff (`--cc`), which `git am` cannot replay. Their content still arrives,
 * because it came in through the non-merge commits the merge brought.
 * @param {string} repo
 * @param {string} base
 * @returns {Promise<number>}
 */
async function mergeCount(repo, base) {
	const r = await git(
		repo,
		["rev-list", "--count", "--merges", "--end-of-options", `${base}..HEAD`],
		{ must: false },
	);
	return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/**
 * The name litter beside the target leads with a dot, so a farm walk's
 * discovery skips it (docs/d228 R11) — but a target that already leads with one
 * (`.git-patches`) keeps the single dot it has, or the names would not line up
 * with the series they belong to.
 * @param {string} out
 * @returns {string}
 */
function litterStem(out) {
	const name = basename(out);
	return name.startsWith(".") ? name : `.${name}`;
}

/**
 * Clean up what a run that died left beside the target (docs/d228 R11): its
 * staging directory is dropped, and a series a crash moved aside is moved back
 * when the name it belongs to is free again. rename's own errno decides
 * "free"/"occupied" — an existence test first would authorize a later act.
 * @param {string} out
 * @returns {void}
 */
function recoverLitter(out) {
	const dir = dirname(out);
	const stem = litterStem(out);
	/** @type {string[]} */
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		// No parent directory yet: nothing an earlier run could have written here.
		return;
	}
	for (const name of names) {
		if (name.startsWith(`${stem}.new-`)) {
			rmSync(join(dir, name), { recursive: true, force: true });
		}
	}
	for (const name of names) {
		if (!name.startsWith(`${stem}.old-`)) {
			continue;
		}
		const aside = join(dir, name);
		try {
			renameSync(aside, out);
			logInfo("restored the series a previous run moved aside", { out, aside });
		} catch (err) {
			const code = /** @type {{ code?: string } | null | undefined} */ (err)?.code;
			if (code !== "ENOTEMPTY" && code !== "EEXIST") {
				throw err;
			}
			// The target stands, so this aside is what a finished swap left behind.
			rmSync(aside, { recursive: true, force: true });
		}
	}
}

/**
 * Publish the staging directory under the target name, keeping the series it
 * replaces until the new one is in place (docs/d228 R8/R10).
 * @param {string} staging
 * @param {string} out
 * @returns {void}
 */
function publish(staging, out) {
	try {
		renameSync(staging, out);
		return;
	} catch (err) {
		const code = /** @type {{ code?: string } | null | undefined} */ (err)?.code;
		if (code !== "ENOTEMPTY" && code !== "EEXIST") {
			throw err;
		}
	}
	const aside = join(dirname(out), `${litterStem(out)}.old-${process.pid}`);
	renameSync(out, aside);
	try {
		renameSync(staging, out);
	} catch (err) {
		renameSync(aside, out);
		logWarn("publishing the new series failed — the previous one is back", {
			out,
		});
		throw err;
	}
	rmSync(aside, { recursive: true, force: true });
}


/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(USAGE);
		return;
	}

	// rev-parse is the act that decides whether this is a repository at all; its
	// stderr names the directory, which is what a mistyped --repo needs.
	const probe = await git(o.repo, ["rev-parse", "--git-dir"], { must: false });
	if (probe.code !== 0) {
		throw Object.assign(new Error("not a git repository"), {
			repo: o.repo,
			detail: probe.stderr.trim(),
		});
	}
	const base = await resolveBase(o.repo, o.base);
	const commits = await commitsSince(o.repo, base);
	const head = (await git(o.repo, ["rev-parse", "HEAD"])).stdout.trim();
	if (commits.length === 0) {
		process.stdout.write(`nothing to export: ${base}..HEAD is empty\n`);
		logInfo("export-patches summary", { repo: o.repo, base, patches: 0 });
		return;
	}
	const merges = await mergeCount(o.repo, base);
	if (merges > 0) {
		logWarn("merge commits are not in the series", {
			count: merges,
			why: "git am cannot replay a merge; its content arrives with the commits it brought",
		});
	}

	const staging = join(dirname(o.out), `${litterStem(o.out)}.new-${process.pid}`);
	/** @type {Patch[]} */
	const patches = [];
	try {
		recoverLitter(o.out);
		mkdirSync(staging, { recursive: true });
		// The series is generated into its own subdirectory and renamed from
		// there, because git must WRITE the patch: a patch is bytes, and the
		// `git()` pipe decodes UTF-8, so a diff line that is not valid UTF-8
		// (a text-ish blob's bytes) comes back with U+FFFD in it and the applied
		// file no longer matches the commit.
		const width = Math.max(4, String(commits.length).length);
		const emittedDir = join(staging, "emitted");
		mkdirSync(emittedDir, { recursive: true });
		await git(o.repo, [
			"format-patch",
			"--no-signature",
			"--binary",
			"--output-directory",
			emittedDir,
			"--end-of-options",
			`${base}..HEAD`,
		]);
		// git numbers by its own width, so the ordinal is read, not assumed; the
		// count is checked because an ordinal-to-commit misalignment would label
		// every patch after the gap with the wrong hash.
		const emitted = readdirSync(emittedDir)
			.map((name) => ({ name, ordinal: Number(/^(\d+)-/.exec(name)?.[1]) }))
			.sort((a, b) => a.ordinal - b.ordinal);
		if (emitted.length !== commits.length) {
			throw new Error(
				`format-patch emitted ${emitted.length} patches for ${commits.length} commits`,
			);
		}
		for (const [index, commit] of commits.entries()) {
			const source = join(emittedDir, emitted[index]?.name ?? "");
			// One read is both the integrity check and the size: the mbox "From "
			// line is the commit's identity inside the file, and a patch that lost
			// it would apply as nobody's work, silently. Latin-1 keeps the bytes
			// as they are; the line itself is ASCII.
			const body = readFileSync(source);
			if (!body.subarray(0, 64).toString("latin1").startsWith(`From ${commit.hash} `)) {
				throw new Error(
					`format-patch did not emit ${commit.hash} as an mbox patch`,
				);
			}
			const file = `${String(index + 1).padStart(width, "0")}-${commit.hash}.git.patch`;
			renameSync(source, join(staging, file));
			patches.push({
				file,
				hash: commit.hash,
				subject: commit.subject,
				bytes: body.length,
			});
		}
		rmSync(emittedDir, { recursive: true, force: true });
		publish(staging, o.out);
	} catch (err) {
		rmSync(staging, { recursive: true, force: true });
		throw err;
	}

	const applyWith = `git am --empty=keep ${join(o.out, "*.git.patch")}`;
	if (o.json) {
		process.stdout.write(
			`${JSON.stringify(
				{ repo: o.repo, base, head, outDir: o.out, applyWith, patches },
				null,
				2,
			)}\n`,
		);
	} else {
		const lines = [
			`${o.out} — ${patches.length} patch(es) from ${base}..HEAD (${head.slice(0, 8)})`,
			...patches.map((p) => `  ${p.file}  ${p.subject}`),
			`apply with: ${applyWith}`,
		];
		process.stdout.write(`${lines.join("\n")}\n`);
	}
	logInfo("export-patches summary", {
		repo: o.repo,
		base,
		head,
		out: o.out,
		patches: patches.length,
		merges,
		bytes: patches.reduce((sum, p) => sum + p.bytes, 0),
	});
}

await runEntry("export-patches", main);

