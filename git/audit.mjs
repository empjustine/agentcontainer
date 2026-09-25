/**
 * @fileoverview audit.mjs — report the ANOMALIES in a non-bare reference farm
 * before (or instead of) migrating it. The farm is not a clean
 * `github/<owner>/<repo>` tree: an owner directory can itself be a repo that
 * wraps further clones (github/duckdb holds the duckdb/* repos), a clone can
 * sit at a nonstandard path, the stored path can disagree with the origin URL
 * it actually points at, and an entry can have no upstream at all. Migration
 * preserves all of this faithfully (relative paths + real origins), so this
 * audit is how a human sees the mess and decides what to clean up or exclude.
 *
 * stdout is the machine-readable JSON report; the human summary and warnings
 * go to stderr through lib/log.mjs (the repo's stdout/stderr contract).
 *
 * Usage:
 *   ./git/audit.sh [--root DIR] [--max-depth N] [--deep]
 *
 *   --deep   also run `git status --porcelain` and HEAD checks per repo
 *            (slow on large working trees; off by default)
 */

import { existsSync } from "node:fs";
import { relative } from "node:path";

import {
	DEFAULT_MAX_DEPTH,
	DEFAULT_ROOT,
	findCloneRoots,
	git,
	logError,
	logInfo,
	originUrl,
	setLogTool,
} from "./git-lib.mjs";
import {
	parseSoftwareForgeRemote,
	softwareForgeGlassUrl,
	softwareForgeHttpsUrl,
} from "./software-forge-remotes.mjs";

setLogTool("git/audit");

/**
 * @typedef {object} Options
 * @property {string} root
 * @property {number} maxDepth
 * @property {boolean} deep
 * @property {boolean} help
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
	/** @type {Options} */
	const o = {
		root: DEFAULT_ROOT,
		maxDepth: DEFAULT_MAX_DEPTH,
		deep: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		switch (a) {
			case "--root":
				o.root = /** @type {string} */ (argv[++i]);
				break;
			case "--max-depth":
				o.maxDepth = Number(argv[++i]);
				break;
			case "--deep":
				o.deep = true;
				break;
			case "-h":
			case "--help":
				o.help = true;
				break;
			default:
				throw Object.assign(new Error("unknown flag (try --help)"), {
					flag: a,
				});
		}
	}
	return o;
}

/**
 * Normalize an origin URL to `owner/repo` (lowercased) for path comparison.
 * Handles https, ssh (`git@host:owner/repo.git`) and plain host paths; returns
 * null for anything that is not a GitHub-style owner/repo.
 * @param {string|null} url
 * @returns {string|null}
 */
function githubSlug(url) {
	if (!url) return null;
	const hostMatch =
		/^(?:https?:\/\/github\.com\/|git@github\.com:)(.+?)(?:\.git)?$/i.exec(url);
	if (!hostMatch) return null;
	return hostMatch[1].toLowerCase();
}

/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"usage: ./git/audit.sh [--root DIR] [--max-depth N] [--deep]\n",
		);
		return;
	}
	if (!existsSync(o.root)) {
		throw Object.assign(new Error("reference root not found"), {
			root: o.root,
		});
	}

	const repos = findCloneRoots(o.root, o.maxDepth);
	const rels = repos.map((p) => relative(o.root, p));

	/** @type {Record<string, number>} */
	const hosts = {};
	/** @type {string[]} */
	const shallow = [];
	/** @type {string[]} */
	const noOrigin = [];
	/** @type {string[]} */
	const nonstandardPath = [];
	/** @type {{ path: string, origin: string }[]} */
	const pathOriginMismatch = [];
	/** @type {{ path: string, nestedIn: string }[]} */
	const nested = [];
	/** @type {Map<string, string[]>} */
	const byOrigin = new Map();
	/** @type {{ path: string, org: string, project: string, repo: string, glass: string|null, https: string|null }[]} */
	const softwareForgeRemotes = [];
	/** @type {string[]} */
	const detached = [];
	/** @type {string[]} */
	const dirty = [];

	for (let i = 0; i < repos.length; i += 1) {
		const repo = repos[i];
		const rel = rels[i];
		const url = await originUrl(repo);

		let host = "(none)";
		if (url) {
			try {
				host = new URL(url.replace(/^git@([^:]+):/, "ssh://$1/")).hostname;
			} catch {
				host = "(unparsable)";
			}
		}
		hosts[host] = (hosts[host] ?? 0) + 1;
		if (!url) noOrigin.push(rel);

		if (existsSync(`${repo}/.git/shallow`)) shallow.push(rel);

		// The work farm is one private software forge whose URLs are not
		// `host/owner/repo`; decode them so the report shows the identity and the
		// glass-pane link a human can open (docs/d044).
		const softwareForge = parseSoftwareForgeRemote(url);
		if (softwareForge) {
			softwareForgeRemotes.push({
				path: rel,
				org: softwareForge.org,
				project: softwareForge.projectSlug ?? softwareForge.projectId ?? "",
				repo: softwareForge.repo,
				glass: softwareForgeGlassUrl(softwareForge),
				https: softwareForgeHttpsUrl(softwareForge),
			});
		}

		const m = /^github\/[^/]+\/.+$/.exec(rel);
		if (!m) nonstandardPath.push(rel);
		const slug = githubSlug(url);
		if (slug && m) {
			const claimed = rel.replace(/^github\//, "").toLowerCase();
			if (claimed !== slug) {
				pathOriginMismatch.push({ path: rel, origin: url ?? "" });
			}
		}

		// A repo is nested when another discovered repo's relative path is a
		// strict prefix of it.
		const parent = rels.find((r) => r !== rel && rel.startsWith(`${r}/`));
		if (parent) nested.push({ path: rel, nestedIn: parent });

		if (url) {
			const list = byOrigin.get(url) ?? [];
			list.push(rel);
			byOrigin.set(url, list);
		}

		if (o.deep) {
			const head = await git(repo, ["symbolic-ref", "-q", "HEAD"], {
				must: false,
			});
			if (head.code !== 0) detached.push(rel);
			const status = await git(repo, ["status", "--porcelain"], {
				must: false,
			});
			if (status.stdout.trim()) dirty.push(rel);
		}
	}

	const duplicateOrigins = [...byOrigin.entries()]
		.filter(([, list]) => list.length > 1)
		.map(([origin, paths]) => ({ origin, paths }));

	/** @type {Record<string, unknown>} */
	const report = {
		root: o.root,
		total: repos.length,
		hosts,
		shallow,
		noOrigin,
		nonstandardPath,
		pathOriginMismatch,
		nested,
		duplicateOrigins,
		softwareForgeRemotes,
		...(o.deep ? { detached, dirty } : {}),
	};
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

	logInfo("audit summary", {
		root: o.root,
		total: repos.length,
		shallow: shallow.length,
		noOrigin: noOrigin.length,
		nonstandardPath: nonstandardPath.length,
		pathOriginMismatch: pathOriginMismatch.length,
		nested: nested.length,
		duplicateOrigins: duplicateOrigins.length,
		softwareForge: softwareForgeRemotes.length,
		...(o.deep ? { detached: detached.length, dirty: dirty.length } : {}),
	});

	// Non-GitHub hosts are the "non-github-repos inside by mistake" class; call
	// them out explicitly rather than burying them in the host histogram.
	for (const [host, n] of Object.entries(hosts)) {
		if (host !== "github.com") {
			logInfo("non-github host present", { host, count: n });
		}
	}
}

await main().catch((err) => {
	logError("audit aborted", {
		error: err,
	});
	process.exit(1);
});
