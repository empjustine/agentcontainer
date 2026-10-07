/**
 * @fileoverview maintain-mirrors.mjs — keep the bare reference mirrors aligned
 * with their upstreams, then run the optimizations that make deep history
 * search (git pickaxe) fast. Companion to `migrate-to-bare.mjs`; rationale and
 * the "why bare" argument live in non-bare-issues.md.
 *
 * Two phases per mirror, independently switchable:
 *
 *   1. ALIGN — `git remote update --prune`. The mirror refspec
 *      (`+refs/*:refs/*`, set by `clone --mirror`) makes upstream the source
 *      of truth: new/updated refs arrive, refs upstream deleted are deleted
 *      here. Refs with no `remote.origin.url` are reported and skipped (a
 *      purely local repo cannot be aligned).
 *   2. OPTIMIZE — `repack -adb --write-bitmap-index` then
 *      `commit-graph write --reachable --changed-paths`. The commit-graph
 *      Bloom filters are the real pickaxe accelerator, but they only help a
 *      path-limited search (`git log -S 'x' -- path`), never an all-history
 *      grep without a pathspec. See optimizeMirror() in git-lib.mjs.
 *
 * `git maintenance start` is deliberately NOT used: it installs a per-repo
 * background timer (cron/systemd) and would run these same commands on a
 * schedule the fleet owner cannot see. This script is the explicit,
 * observable replacement.
 *
 * Usage:
 *   ./git/maintain.sh [--root DIR] [--jobs N] [--max-depth N]
 *                     [--no-fetch] [--no-optimize] [--min-interval S]
 *
 *   --root DIR        mirror root to maintain (default $REFERENCES_ROOT else
 *                     ~/Downloads/references — the farm itself). Discovery is
 *                     by shape, not by host, so every forge mirror under the
 *                     root is covered whatever its host (github.com,
 *                     codeberg.org, git.sr.ht, …).
 *   --jobs N          parallel mirrors (default 2 — fetch and repack compete
 *                     for disk, so the default is lower than migrate's)
 *   --max-depth N     discovery depth bound (default 5)
 *   --no-fetch        skip phase 1 (optimize only)
 *   --no-optimize     skip phase 2 (fetch only)
 *   --min-interval S  idle seconds after each upstream fetch before the next
 *                     starts. Unset: 60 for a software-forge mirror, 0 for a
 *                     public forge. Passing it explicitly applies it to EVERY
 *                     fetch, and `--min-interval 0` disables pacing. Env
 *                     `MIRROR_MIN_INTERVAL` seeds the same value; the flag
 *                     wins.
 *   --only GLOB       maintain only mirrors whose relative path matches
 *                     (repeatable)
 *   --exclude GLOB    skip mirrors whose relative path matches (repeatable)
 *
 * The pacing default is host-dependent because the tenants are: public forges
 * tolerate a burst, while the software-forge (Visual Builder Studio) tenant
 * rate-limits even a `--jobs 1` sweep (docs/d044). Pacing only the forge that
 * needs it keeps the home farm's minute-long sweep from becoming hours.
 */

import { existsSync } from "node:fs";
import { relative } from "node:path";

import {
	createMinIntervalGate,
	DEFAULT_MAX_DEPTH,
	DEFAULT_ROOT,
	filterByGlobs,
	findBareMirrors,
	git,
	logError,
	logInfo,
	logWarn,
	optimizeMirror,
	originUrl,
	pool,
	setLogTool,
} from "./git-lib.mjs";
import { parseSoftwareForgeRemote } from "./software-forge-remotes.mjs";

setLogTool("git/maintain-mirrors");

/**
 * Seconds of idle before the next software-forge fetch when `--min-interval`
 * is unset — the maintainer's counterpart of `-vbs-mirror-all.sh`'s
 * `VBS_THROTTLE` default (docs/d044).
 */
const DEFAULT_SOFTWARE_FORGE_MIN_INTERVAL = 60;

/**
 * @typedef {object} Options
 * @property {string} root
 * @property {number} jobs
 * @property {number} maxDepth
 * @property {boolean} fetch
 * @property {boolean} optimize
 * @property {string[]} only
 * @property {string[]} exclude
 * @property {number|null} minInterval explicit seconds between upstream
 *   fetches for EVERY mirror; null means "pace only the software forge, at
 *   DEFAULT_SOFTWARE_FORGE_MIN_INTERVAL" (docs/d044)
 * @property {boolean} help
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
	/** @type {Options} */
	const o = {
		// The live farm holds the mirrors IN PLACE (git/non-bare-issues.md), not at
		// the `-bare` sibling migrate defaults to, so maintain targets the farm
		// root. Forge hosts (github.com, codeberg.org, git.sr.ht, …) are just
		// directories under it; findBareMirrors covers them all by shape.
		root: DEFAULT_ROOT,
		jobs: 2,
		maxDepth: DEFAULT_MAX_DEPTH,
		fetch: true,
		optimize: true,
		only: [],
		exclude: [],
		// `null` means "pace only the software forge" (see createPacing), not
		// "unset/disabled" — `--min-interval 0` is the explicit disable.
		minInterval:
			process.env.MIRROR_MIN_INTERVAL === undefined
				? null
				: Number(process.env.MIRROR_MIN_INTERVAL),
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		switch (a) {
			case "--root":
				o.root = /** @type {string} */ (argv[++i]);
				break;
			case "--jobs":
				o.jobs = Number(argv[++i]);
				break;
			case "--max-depth":
				o.maxDepth = Number(argv[++i]);
				break;
			case "--no-fetch":
				o.fetch = false;
				break;
			case "--no-optimize":
				o.optimize = false;
				break;
			case "--min-interval":
				o.minInterval = Number(argv[++i]);
				break;
			case "--only":
				o.only.push(/** @type {string} */ (argv[++i]));
				break;
			case "--exclude":
				o.exclude.push(/** @type {string} */ (argv[++i]));
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
	if (
		o.minInterval !== null &&
		(!Number.isFinite(o.minInterval) || o.minInterval < 0)
	) {
		throw new Error("--min-interval must be a non-negative number of seconds");
	}
	return o;
}

/**
 * @typedef {object} Pacing
 * @property {<T>(fn: () => Promise<T>) => Promise<T>} gate shared min-interval gate
 * @property {(url: string) => boolean} shouldPace whether this origin is paced
 */

/**
 * The upstream-fetch pacing policy. Public forges tolerate a burst, so they
 * are not paced by default; the software-forge tenant rate-limits even a
 * `--jobs 1` sweep, so its fetches are (docs/d044). An explicit `--min-interval`
 * overrides the scope — the operator who names a number wants it everywhere —
 * and `0` disables pacing. The gate is shared, so `--jobs 2` still yields one
 * forge request at a time.
 * @param {Options} o
 * @returns {Pacing}
 */
function createPacing(o) {
	const explicit = o.minInterval;
	const seconds = explicit ?? DEFAULT_SOFTWARE_FORGE_MIN_INTERVAL;
	return {
		gate: createMinIntervalGate(seconds * 1000),
		shouldPace:
			explicit !== null
				? () => explicit > 0
				: (url) => parseSoftwareForgeRemote(url) !== null,
	};
}

/**
 * Fetch/align and/or optimize one mirror.
 * @param {string} repo
 * @param {Options} o
 * @param {Pacing} pacing
 * @returns {Promise<"ok"|"skipped"|"failed">}
 */
async function maintainOne(repo, o, pacing) {
	const url = await originUrl(repo);
	if (o.fetch && !url) {
		logWarn("no upstream — cannot align; optimize only", { repo });
	}
	const paced = o.fetch && url ? pacing.shouldPace(url) : false;

	if (o.fetch && url) {
		const runFetch = () =>
			git(repo, ["remote", "update", "--prune"], { must: false });
		const fetch = await (paced ? pacing.gate(runFetch) : runFetch());
		if (fetch.code !== 0) {
			logWarn("fetch failed — mirror left as-is", {
				repo,
				origin: url,
				stderr: fetch.stderr.trim().split("\n").slice(-2).join(" | "),
			});
			return "failed";
		}
	}

	if (o.optimize) {
		try {
			await optimizeMirror(repo);
		} catch (err) {
			logWarn("optimization failed — mirror left as-is", {
				repo,
				error: err,
			});
			return "failed";
		}
	}

	logInfo("mirror maintained", {
		repo,
		origin: url ?? "",
		fetched: o.fetch && url ? 1 : 0,
		optimized: o.optimize ? 1 : 0,
		paced: paced ? 1 : 0,
	});
	return "ok";
}

/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"usage: ./git/maintain.sh [--root DIR] [--jobs N] [--max-depth N]\n" +
				"                       [--no-fetch] [--no-optimize] [--min-interval S]\n" +
				"                       [--only GLOB]... [--exclude GLOB]\n",
		);
		return;
	}
	if (!existsSync(o.root)) {
		throw Object.assign(new Error("reference root not found"), {
			root: o.root,
		});
	}
	if (!o.fetch && !o.optimize) {
		throw new Error("both --no-fetch and --no-optimize given — nothing to do");
	}

	const discovered = findBareMirrors(o.root, o.maxDepth);
	const rels = discovered.map((p) => relative(o.root, p));
	const kept = new Set(filterByGlobs(rels, o.only, o.exclude));
	const repos = discovered.filter((p) => kept.has(relative(o.root, p)));
	const pacing = createPacing(o);
	logInfo("discovered bare mirrors", {
		root: o.root,
		count: repos.length,
		skippedByFilter: discovered.length - repos.length,
		jobs: o.jobs,
		fetch: o.fetch ? 1 : 0,
		optimize: o.optimize ? 1 : 0,
		paceScope:
			o.minInterval === null
				? "software-forge"
				: o.minInterval > 0
					? "all"
					: "off",
		minInterval: o.minInterval ?? DEFAULT_SOFTWARE_FORGE_MIN_INTERVAL,
	});
	if (repos.length === 0) {
		logWarn("no bare mirrors found under root", { root: o.root });
		return;
	}

	const results = await pool(repos, o.jobs, (repo) =>
		maintainOne(repo, o, pacing),
	);
	const tally = { ok: 0, skipped: 0, failed: 0 };
	for (const r of results) tally[r] += 1;

	logInfo("maintenance summary", {
		mirrors: repos.length,
		ok: tally.ok,
		skipped: tally.skipped,
		failed: tally.failed,
	});
	if (tally.failed) process.exitCode = 1;
}

await main().catch((err) => {
	logError("maintenance aborted", {
		error: err,
	});
	process.exit(1);
});
