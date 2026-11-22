/**
 * @fileoverview apply-patches.mjs — the receiving end of the series
 * `export-patches.mjs` writes (docs/d229): commit the patches onto the current
 * branch, or roll the branch back and say so.
 *
 * The series is plain `git am` input, so a receiver without this tree needs
 * nothing but git:
 *
 *   git am --empty=keep <dir>/*.git.patch
 *
 * This entry point exists because that one line is easy to get wrong in the two
 * places it matters. It cannot be made safe by checking first — a
 * `git apply --check` that then authorizes a real apply is exactly the
 * just-in-case probe docs/d228 forbids, and it is wrong even when it passes,
 * because a patch can apply cleanly and still not be the patch that is expected
 * (`--3way` resolves hunks the check refused). The act decides: git applies,
 * and a failure is rolled back with git's own transaction — `git am --abort`,
 * which restores the branch and the work tree to the state `git am` found.
 *
 * That rollback is why the whole series goes in ONE `git am` invocation: git
 * keeps one `rebase-apply` state per run, so one abort restores everything the
 * run did, and a series that stops halfway is put back whole rather than left
 * as the broken intermediate state (docs/d228 R8/R11).
 *
 * `--3way` is the store-and-forward case: a series generated on one host,
 * applied to a tree whose context has drifted. It needs the pre-image blobs in
 * the receiving repository — the same history — because a literal diff carries
 * no objects to merge against; a tree that lacks them says so per patch, and
 * the fix is the exporting side's base.
 *
 * Usage:
 *   ./node-run.sh git/apply-patches.mjs [--repo DIR] [--series DIR]
 *                                       [--3way] [--json]
 *
 *   --repo DIR    repository to apply to (default ".")
 *   --series DIR  directory holding the series (default `<repo>/.git-patches`)
 *   --3way        hand `--3way` to git am, for a tree whose context drifted
 *   --json        emit the result as JSON on stdout instead of text
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseFlags, runEntry } from "./lib/cli.mjs";
import { git, logInfo, logWarn, setLogTool } from "./lib/git-core.mjs";

setLogTool("git/apply-patches");

/** Field separator for `git log --format`: a subject is one line and a ref name
 * cannot hold a 0x1f, so the split needs no quoting. */
const UNIT = "\x1f";

const USAGE =
	"usage: ./node-run.sh git/apply-patches.mjs [--repo DIR] [--series DIR]\n" +
	"                                        [--3way] [--json]\n";

/**
 * @typedef {object} Options
 * @property {string} repo
 * @property {string} series
 * @property {boolean} threeway
 * @property {boolean} json
 * @property {boolean} help
 */

/**
 * @typedef {object} Commit
 * @property {string} hash
 * @property {string} subject
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
	const { values, help } = parseFlags(argv, {
		repo: { default: "." },
		series: { default: "" },
		threeway: { names: ["--3way"], kind: "bool" },
		json: { kind: "bool" },
	});
	const repo = resolve(values.repo);
	return {
		repo,
		series: resolve(values.series || join(repo, ".git-patches")),
		threeway: values.threeway,
		json: values.json,
		help,
	};
}

/**
 * The series, in apply order — which is a plain lexicographic sort of the
 * directory, because the export's name carries a zero-padded ordinal
 * (`<ordinal>-<hash>.git.patch`). readdir's own ENOENT is the answer when
 * there is no series here; a probe first would only hide which directory was
 * meant (docs/d228).
 * @param {string} series
 * @returns {string[]} absolute paths, oldest commit first
 */
function seriesFiles(series) {
	let names;
	try {
		names = readdirSync(series);
	} catch (err) {
		const code = /** @type {{ code?: string } | null | undefined} */ (err)?.code;
		throw Object.assign(new Error("no patch series here"), {
			series,
			detail: code ?? String(err),
		});
	}
	return names
		.filter((name) => name.endsWith(".git.patch"))
		.sort()
		.map((name) => join(series, name));
}

/**
 * @param {string} repo
 * @param {string} range
 * @returns {Promise<Commit[]>}
 */
async function commitsIn(repo, range) {
	const r = await git(repo, ["log", "--reverse", "--format=%H%x1f%s", "--end-of-options", range]);
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
 * Put the branch and the work tree back where the run found them. am's abort
 * is the rollback: it resets to the head `git am` recorded when it started, so
 * asking for it is a request to undo, not a check of whether undoing is needed.
 * Its exit status says whether there was anything to undo.
 * @param {string} repo
 * @returns {Promise<boolean>} whether an apply was rolled back
 */
async function rollBack(repo) {
	const abort = await git(repo, ["am", "--abort"], { must: false });
	return abort.code === 0;
}

/**
 * @param {string} repo
 * @param {string[]} files
 * @param {boolean} threeway
 * @returns {Promise<{ code: number, stderr: string }>}
 */
async function am(repo, files, threeway) {
	const args = ["am", "--empty=keep"];
	if (threeway) {
		args.push("--3way");
	}
	const r = await git(repo, [...args, ...files], { must: false });
	return { code: r.code, stderr: r.stderr };
}

/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(USAGE);
		return;
	}

	const probe = await git(o.repo, ["rev-parse", "--git-dir"], { must: false });
	if (probe.code !== 0) {
		throw Object.assign(new Error("not a git repository"), {
			repo: o.repo,
			detail: probe.stderr.trim(),
		});
	}
	const files = seriesFiles(o.series);
	if (files.length === 0) {
		process.stdout.write(`nothing to apply: no *.git.patch in ${o.series}\n`);
		logInfo("apply-patches summary", { repo: o.repo, series: o.series, patches: 0 });
		return;
	}

	const branch = (await git(o.repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
	const headBefore = (await git(o.repo, ["rev-parse", "HEAD"])).stdout.trim();
	const outcome = await am(o.repo, files, o.threeway);
	if (outcome.code !== 0) {
		const rolledBack = await rollBack(o.repo);
		const headAfter = (await git(o.repo, ["rev-parse", "HEAD"])).stdout.trim();
		// After a rollback the branch must be exactly where the run found it. A
		// difference means the abort restored some OTHER run's starting point —
		// a series was already in progress when this one began — and that is
		// reported rather than smoothed over (docs/d228 R7).
		if (rolledBack && headAfter !== headBefore) {
			logWarn("an apply was in progress before this run; it was rolled back too", {
				headBefore,
				headAfter,
			});
		}
		throw Object.assign(new Error("the series did not apply"), {
			repo: o.repo,
			series: o.series,
			branch,
			headBefore,
			headAfter,
			rolledBack,
			patches: files.length,
			detail: outcome.stderr.trim(),
		});
	}

	const commits = await commitsIn(o.repo, `${headBefore}..HEAD`);
	if (commits.length !== files.length) {
		logWarn("the branch gained a different number of commits than the series holds", {
			patches: files.length,
			commits: commits.length,
		});
	}
	const headAfter = (await git(o.repo, ["rev-parse", "HEAD"])).stdout.trim();
	const undo = `git reset --hard ${headBefore}`;
	if (o.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					repo: o.repo,
					series: o.series,
					branch,
					headBefore,
					headAfter,
					undo,
					commits,
				},
				null,
				2,
			)}\n`,
		);
	} else {
		const lines = [
			`${branch} — applied ${commits.length} patch(es) from ${o.series}`,
			...commits.map((c) => `  ${c.hash.slice(0, 8)}  ${c.subject}`),
			`undo: ${undo}`,
		];
		process.stdout.write(`${lines.join("\n")}\n`);
	}
	logInfo("apply-patches summary", {
		repo: o.repo,
		series: o.series,
		branch,
		headBefore,
		headAfter,
		patches: commits.length,
	});
}

await runEntry("apply-patches", main);
