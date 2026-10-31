/**
 * @fileoverview maintain-mirrors.mjs — keep the bare reference mirrors aligned
 * with their upstreams, then run the optimizations that make deep history
 * search (git pickaxe) fast. Companion to `migrate-to-bare.mjs`; rationale and
 * the "why bare" argument live in non-bare-issues.md.
 *
 * Two phases per mirror, independently switchable; phase 2 also has an
 * opt-in deep form (docs/d089):
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
 *      The deep form (--deep-optimize) runs "git gc --aggressive" first —
 *      the forced delta recomputation that shrinks slow-moving mirrors on
 *      cold storage, which delta reuse lets compose with (never be undone
 *      by) the routine sequence — then re-runs OPTIMIZE so bitmaps and Bloom
 *      filters are guaranteed over the fresh pack. Hours per farm; the pass
 *      ladder is docs/d089's.
 *
 * `git maintenance start` is deliberately NOT used: it installs a per-repo
 * background timer (cron/systemd) and would run these same commands on a
 * schedule the fleet owner cannot see. This script is the explicit,
 * observable replacement.
 *
 * Usage (one program, two shims — `./git/maintain.sh` for POSIX shells,
 * `git\maintain.ps1` for native Windows, identical flags; docs/d062):
 *   ./git/maintain.sh [--root DIR] [--jobs N] [--max-depth N]
 *                     [--no-fetch] [--no-optimize] [--deep-optimize]
 *                     [--min-interval S]
 *
 *   --root DIR        mirror root to maintain (default $REFERENCES_ROOT else
 *                     ~/Downloads/references — the farm itself). Discovery is
 *                     by shape, not by host, so every forge mirror under the
 *                     root is covered whatever its host (github.com,
 *                     codeberg.org, git.sr.ht, …).
 *   --jobs N          parallel HOSTS (default: every discovered host at once).
 *                     One worker owns one host at a time, so a host never has
 *                     two jobs in flight; N only caps how many hosts run at
 *                     once. Per-host serialization holds for any N (docs/d044)
 *   --max-depth N     discovery depth bound (default 5)
 *   --no-fetch        skip phase 1 (optimize only)
 *   --no-optimize     skip phase 2 (fetch only)
 *   --min-interval S  idle seconds after each upstream fetch before the next
 *                     fetch on the SAME host starts. Unset: 1 s for every
 *                     forge; a software-forge host gets 30 s — half of the
 *                     original 60 s, now that scheduling also removes
 *                     same-host concurrency (docs/d044, docs/d076).
 *                     Passing it explicitly applies it to EVERY fetch, and
 *                     `--min-interval 0` disables pacing.
 *   --only GLOB       maintain only mirrors whose relative path matches
 *                     (repeatable)
 *   --exclude GLOB    skip mirrors whose relative path matches (repeatable)
 *
 * Scheduling is by host because a host is the unit that rate-limits: the old
 * flat default (`--jobs 2` over all mirrors) could put both workers on two
 * mirrors of the SAME host — two concurrent requests, which is exactly what
 * the software-forge tenant rejects (docs/d044). Grouping makes one-job-per-
 * host structural; different hosts still fetch in parallel.
 *
 * The pacing input is the flag or that default — never an ambient environment
 * variable. A sweep must be able to say what it is about to do from its own
 * command line; a timing knob readable from outside would make two identical
 * runs pace differently (docs/d060).
 */

import { existsSync } from "node:fs";
import { relative } from "node:path";

import {
	createMinIntervalGate,
	DEFAULT_MAX_DEPTH,
	DEFAULT_ROOT,
	deepOptimizeMirror,
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
 * Seconds of idle after a fetch before the next fetch on the same host when
 * `--min-interval` is unset — the gentle default for every forge (public
 * forges used to receive none at all, which is what "aggressive" meant).
 */
const DEFAULT_MIN_INTERVAL = 1;

/**
 * Seconds of idle before the next software-forge fetch when `--min-interval`
 * is unset — the rate-limit contract of the Visual Builder Studio tenant,
 * the maintainer's counterpart of `-vbs-mirror-all.sh`'s between-repositories
 * throttle (docs/d044). It deliberately overrides DEFAULT_MIN_INTERVAL
 * upward: that tenant rate-limits even a fully serial sweep, so its floor
 * stays higher. 30 s rather than the original 60 s: the by-host scheduler
 * now rules out same-host overlap on its own, so the interval only has to
 * bound the request *rate*, not also fight concurrency (docs/d076).
 */
const SOFTWARE_FORGE_MIN_INTERVAL = 30;

/**
 * Group key for mirrors with no resolvable upstream host (no
 * `remote.origin.url`, or a URL that carries none — a local path, file://).
 * All such mirrors share one bucket, so local repack work stays serialized
 * instead of each becoming its own unbounded parallel lane. Parentheses
 * cannot occur in a hostname, so the key cannot collide with a real one.
 */
const LOCAL_HOST = "(local)";

/**
 * Concurrency for the upstream-URL probe phase. It must precede scheduling
 * (host is a property of the URL, and the work farm's path layout carries no
 * host segment) and every probe is a local `git config` spawn; bounded so a
 * 775-mirror farm does not fork 775 gits at once.
 */
const ORIGIN_PROBE_JOBS = 8;

/**
 * @typedef {object} Options
 * @property {string} root
 * @property {number|null} jobs caps how many HOSTS are worked at once; null
 *   means one worker per discovered host. A host never exceeds one in-flight
 *   job either way — groups are never split across workers.
 * @property {number} maxDepth
 * @property {boolean} fetch
 * @property {boolean} optimize
 * @property {boolean} deep run the deep pass before the routine one; implies
 *   optimize (docs/d089)
 * @property {string[]} only
 * @property {string[]} exclude
 * @property {number|null} minInterval explicit seconds between upstream
 *   fetches on EVERY host; null means "1 s, software-forge hosts
 *   SOFTWARE_FORGE_MIN_INTERVAL" (docs/d044)
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
		// null = the by-host default: one worker per discovered host.
		jobs: null,
		maxDepth: DEFAULT_MAX_DEPTH,
		fetch: true,
		optimize: true,
		// Opt-in, never defaulted: a forced repack is an hours-to-days job on
		// cold storage — docs/d089 owns the ladder and its costs.
		deep: false,
		only: [],
		exclude: [],
		// `null` means "the per-host defaults" (see createPacing), not
		// "unset/disabled" — `--min-interval 0` is the explicit disable. No env
		// seed: the flag or the default is the whole input (docs/d060).
		minInterval: null,
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
			case "--deep-optimize":
				o.deep = true;
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
	if (o.jobs !== null && (!Number.isInteger(o.jobs) || o.jobs < 1)) {
		throw new Error("--jobs must be a positive integer number of hosts");
	}
	return o;
}

/**
 * The host an origin URL fetches from, or null when it has none (local path,
 * file://, unparseable) — the key the by-host scheduler groups on. scp-like
 * spellings (`git@host:owner/repo.git`, `host.tld:owner/repo.git`) are not
 * URLs the WHATWG parser accepts (no scheme), so they are matched first; the
 * scheme-less form requires a dot in the host so a Windows path (`C:/…`)
 * cannot be mistaken for one. A scheme'd URL keeps its port, because a
 * different port is a different endpoint.
 * @param {string} url
 * @returns {string|null}
 */
function originHost(url) {
	const scpWithUser = /^[^/@]+@([^/:]+):/.exec(url);
	if (scpWithUser) {
		// group 1 is required — a match always carries it
		return scpWithUser[1] ?? null;
	}
	const scpHostOnly = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):/.exec(url);
	if (scpHostOnly) {
		// group 1 is required — a match always carries it
		return scpHostOnly[1] ?? null;
	}
	try {
		const host = new URL(url).host;
		return host || null;
	} catch {
		return null;
	}
}

/**
 * @typedef {object} Pacing
 * @property {(host: string, url: string) => <T>(fn: () => Promise<T>) => Promise<T>} gateFor
 *   the gate covering `host`'s fetches: one fetch at a time, then the idle
 *   interval (interval 0 = pass-through)
 * @property {(host: string, url: string) => number} intervalFor the idle
 *   seconds `host`'s fetches get (0 when pacing is disabled)
 */

/**
 * Per-host pacing policy for one run: gates are keyed by HOST, because the
 * scheduler already owns one worker per host — a single global gate would now
 * serialize different hosts' fetches against each other, which pacing never
 * needed to do. A host's fetches share one gate, so they stay strictly
 * one-at-a-time, with the interval measured from the end of one fetch to the
 * start of the next (docs/d044).
 *
 * Interval per host: the explicit `--min-interval` wins (an operator who
 * names a number wants it everywhere) and `0` disables pacing; unset, a
 * software-forge host gets SOFTWARE_FORGE_MIN_INTERVAL — that tenant
 * rate-limits even a fully serial sweep (docs/d044) — and every other host
 * DEFAULT_MIN_INTERVAL. The pacing input is the flag or that default, never an
 * ambient environment variable (docs/d060).
 * @param {Options} o
 * @returns {Pacing}
 */
function createPacing(o) {
	/** @type {Map<string, { seconds: number, gate: <T>(fn: () => Promise<T>) => Promise<T> }>} */
	const byHost = new Map();
	/** @param {string} host @param {string} url */
	const entryFor = (host, url) => {
		let entry = byHost.get(host);
		if (!entry) {
			const seconds =
				o.minInterval ??
				(parseSoftwareForgeRemote(url) === null
					? DEFAULT_MIN_INTERVAL
					: SOFTWARE_FORGE_MIN_INTERVAL);
			entry = { seconds, gate: createMinIntervalGate(seconds * 1000) };
			byHost.set(host, entry);
		}
		return entry;
	};
	return {
		gateFor: (host, url) => entryFor(host, url).gate,
		intervalFor: (host, url) => entryFor(host, url).seconds,
	};
}

/**
 * Fetch/align and/or optimize one mirror. Its upstream URL and host are
 * resolved during scheduling — grouping needs them before any job starts.
 * @param {{ repo: string, url: string|null, host: string }} target
 * @param {Options} o
 * @param {Pacing} pacing
 * @returns {Promise<"ok"|"skipped"|"failed">}
 */
async function maintainOne(target, o, pacing) {
	const { repo, url, host } = target;
	if (o.fetch && !url) {
		logWarn("no upstream — cannot align; optimize only", { repo });
	}

	if (o.fetch && url) {
		const runFetch = () =>
			git(repo, ["remote", "update", "--prune"], { must: false });
		const fetch = await pacing.gateFor(host, url)(runFetch);
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
			await (o.deep ? deepOptimizeMirror(repo) : optimizeMirror(repo));
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
		deep: o.deep ? 1 : 0,
		paced: o.fetch && url ? (pacing.intervalFor(host, url) > 0 ? 1 : 0) : 0,
	});
	return "ok";
}

/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"usage: ./git/maintain.sh [--root DIR] [--jobs N] [--max-depth N]\n" +
				"                       [--no-fetch] [--no-optimize] [--deep-optimize]\n" +
				"                       [--min-interval S]\n" +
				"                       [--only GLOB]... [--exclude GLOB]\n" +
				"       git\\maintain.ps1 takes the same flags — the native Windows\n" +
				"       entry for non-NTFS / non-local UNC farm roots (docs/d062)\n" +
				"       defaults: one worker per host (a host never has two jobs in\n" +
				"       flight); 1 s min-interval, 30 s on a software-forge host\n" +
				"       (docs/d044)\n",
		);
		return;
	}
	if (!existsSync(o.root)) {
		throw Object.assign(new Error("reference root not found"), {
			root: o.root,
		});
	}
	if (o.deep && !o.optimize) {
		throw new Error(
			"--deep-optimize conflicts with --no-optimize — deep implies optimize (docs/d089)",
		);
	}
	if (!o.fetch && !o.optimize) {
		throw new Error("both --no-fetch and --no-optimize given — nothing to do");
	}

	const discovered = findBareMirrors(o.root, o.maxDepth);
	const rels = discovered.map((p) => relative(o.root, p));
	const kept = new Set(filterByGlobs(rels, o.only, o.exclude));
	const repos = discovered.filter((p) => kept.has(relative(o.root, p)));
	// The URL must be resolved BEFORE scheduling: host is a property of the
	// origin URL (the work farm's path layout carries no host segment), so
	// neither discovery order nor path shape can define the groups. The probe
	// returns repo/url pairs because pool() results arrive in completion
	// order, not in the order of its items.
	const probes = await pool(repos, ORIGIN_PROBE_JOBS, async (repo) => ({
		repo,
		url: await originUrl(repo),
	}));
	const urlByRepo = new Map(probes.map((p) => [p.repo, p.url]));
	/** @type {Map<string, { repo: string, url: string|null, host: string }[]>} */
	const groups = new Map();
	for (const repo of repos) {
		const url = urlByRepo.get(repo) ?? null;
		// A mirror with no upstream (or one carrying no host) joins the local
		// bucket — see LOCAL_HOST.
		const host = (url && originHost(url)) || LOCAL_HOST;
		let group = groups.get(host);
		if (!group) {
			group = [];
			groups.set(host, group);
		}
		group.push({ repo, url, host });
	}
	const hostGroups = [...groups.values()];
	// Default: one worker per discovered host. An explicit --jobs caps how
	// many hosts are in flight; a group is never split, so no --jobs value
	// can put two jobs on one host.
	const workers = Math.max(
		1,
		Math.min(o.jobs ?? hostGroups.length, hostGroups.length),
	);

	const pacing = createPacing(o);
	logInfo("discovered bare mirrors", {
		root: o.root,
		count: repos.length,
		skippedByFilter: discovered.length - repos.length,
		hosts: hostGroups.length,
		jobs: workers,
		fetch: o.fetch ? 1 : 0,
		optimize: o.optimize ? 1 : 0,
		deep: o.deep ? 1 : 0,
		paceScope:
			o.minInterval === null ? "default" : o.minInterval > 0 ? "all" : "off",
		minInterval: o.minInterval ?? DEFAULT_MIN_INTERVAL,
		softwareForgeMinInterval: o.minInterval ?? SOFTWARE_FORGE_MIN_INTERVAL,
	});
	if (repos.length === 0) {
		logWarn("no bare mirrors found under root", { root: o.root });
		return;
	}

	const results = await pool(hostGroups, workers, async (group) => {
		// One host, one worker: processing a group serially is what makes
		// "a host never has two jobs in flight" structural, not a hope.
		const out = [];
		for (const target of group) {
			out.push(await maintainOne(target, o, pacing));
		}
		return out;
	});
	/** @type {Record<string, number>} */
	const tally = { ok: 0, skipped: 0, failed: 0 };
	for (const groupResults of results) {
		for (const r of groupResults) {
			tally[r] = (tally[r] ?? 0) + 1;
		}
	}

	logInfo("maintenance summary", {
		mirrors: repos.length,
		ok: tally.ok,
		skipped: tally.skipped,
		failed: tally.failed,
	});
	if (tally.failed) {
		process.exitCode = 1;
	}
}

await main().catch((err) => {
	logError("maintenance aborted", {
		error: err,
	});
	process.exit(1);
});
