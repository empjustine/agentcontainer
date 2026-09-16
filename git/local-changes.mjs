/**
 * @fileoverview local-changes.mjs — show everything a git repository holds
 * that its remotes do not. The four categories are the four ways work goes
 * missing: uncommitted changes (staged, unstaged, untracked, and IGNORED —
 * `.gitignore` hides files, it does not protect them), stashes, branches that
 * exist on no remote, and branches whose upstream is behind them. It exists to
 * answer "is there anything here I would lose or forget?" before a clone is
 * archived, migrated to a bare mirror (docs/d044), or deleted.
 *
 * Default is one repo (`.`); `--root DIR` sweeps a tree of clones, reusing the
 * structural discovery from git-lib.mjs (docs/git/non-bare-issues.md), and
 * shows only the repos with findings unless `--all` is given.
 *
 * Human-readable text goes to stdout (the viewer); `--json` emits the same
 * data as an object. Corroborating logs go to stderr through lib/log.mjs.
 *
 * Usage:
 *   ./git/local-changes.sh [--repo DIR] [--root DIR] [--json] [--all]
 *                          [--max-depth N] [--max-entries N] [--no-ignored]
 *                          [--only GLOB]... [--exclude GLOB]...
 *
 *   --repo DIR       inspect this repository (default `.`)
 *   --root DIR       sweep every clone under DIR instead
 *   --json           emit JSON instead of text
 *   --all            (with --root) also show repos with no findings
 *   --max-depth N    discovery depth bound under --root (default 5)
 *   --max-entries N  cap each list at N entries (default 200)
 *   --no-ignored     skip the ignored-file category
 *   --only/--exclude GLOB  filter repos under --root by relative path
 */

import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
	DEFAULT_MAX_DEPTH,
	filterByGlobs,
	findCloneRoots,
	git,
	logError,
	logInfo,
	pool,
	setLogTool,
} from "./git-lib.mjs";

setLogTool("git/local-changes");

const UNIT = "\x1f";

/**
 * @typedef {object} StatusEntry
 * @property {string} status the two porcelain status chars
 * @property {string} path
 */

/**
 * @typedef {object} BranchEntry
 * @property {string} name
 * @property {string|null} upstream
 * @property {string} object short object id
 * @property {number} ahead
 * @property {number} behind
 * @property {boolean} gone upstream ref deleted
 * @property {boolean} onRemote a remote-tracking ref shares this name
 */

/**
 * @typedef {object} StashEntry
 * @property {string} ref reflog selector, e.g. stash@{0}
 * @property {string|null} date ISO timestamp
 * @property {string} subject
 * @property {string[]} files
 */

/**
 * @typedef {object} RepoInfo
 * @property {string} path absolute repo path
 * @property {boolean} bare
 * @property {string} head branch name, or short oid when detached
 * @property {boolean} detached
 * @property {string|null} upstream
 * @property {number} ahead
 * @property {number} behind
 * @property {{staged: StatusEntry[], unstaged: StatusEntry[], untracked: string[], ignored: string[]}} uncommitted
 * @property {StashEntry[]} stashes
 * @property {BranchEntry[]} branches
 * @property {string[]} localOnly
 * @property {string[]} aheadBranches
 * @property {string[]} goneBranches
 * @property {number} findings total items across every category
 */

/**
 * @typedef {object} Options
 * @property {string} repo
 * @property {string} root
 * @property {boolean} json
 * @property {boolean} all
 * @property {number} maxDepth
 * @property {number} maxEntries
 * @property {boolean} ignored
 * @property {string[]} only
 * @property {string[]} exclude
 * @property {boolean} help
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
	/** @type {Options} */
	const o = {
		repo: ".",
		root: "",
		json: false,
		all: false,
		maxDepth: DEFAULT_MAX_DEPTH,
		maxEntries: 200,
		ignored: true,
		only: [],
		exclude: [],
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		switch (a) {
			case "--repo":
				o.repo = /** @type {string} */ (argv[++i]);
				break;
			case "--root":
				o.root = /** @type {string} */ (argv[++i]);
				break;
			case "--json":
				o.json = true;
				break;
			case "--all":
				o.all = true;
				break;
			case "--max-depth":
				o.maxDepth = Number(argv[++i]);
				break;
			case "--max-entries":
				o.maxEntries = Number(argv[++i]);
				break;
			case "--no-ignored":
				o.ignored = false;
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
				if (a.startsWith("-"))
					throw Object.assign(new Error("unknown flag (try --help)"), {
						flag: a,
					});
				o.repo = a;
		}
	}
	return o;
}

/**
 * Split `git status --porcelain=v1 -z` into its four work-tree buckets. With
 * `-z`, a rename/copy entry is two NUL-separated tokens (new path, then the
 * original), which is why the loop can advance an extra step.
 * @param {string} repo
 * @param {boolean} includeIgnored
 * @returns {Promise<{staged: StatusEntry[], unstaged: StatusEntry[], untracked: string[], ignored: string[]}>}
 */
async function statusBuckets(repo, includeIgnored) {
	const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
	if (includeIgnored) args.push("--ignored");
	const r = await git(repo, args, { must: false });
	const tokens = r.stdout.split("\0");
	/** @type {StatusEntry[]} */
	const staged = [];
	/** @type {StatusEntry[]} */
	const unstaged = [];
	/** @type {string[]} */
	const untracked = [];
	/** @type {string[]} */
	const ignored = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token) continue;
		const xy = token.slice(0, 2);
		const path = token.slice(3);
		if (xy === "??") {
			untracked.push(path);
			continue;
		}
		if (xy === "!!") {
			ignored.push(path);
			continue;
		}
		if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
			i += 1; // the next token is the rename source
		}
		if (xy[0] !== " " && xy[0] !== "?") {
			staged.push({ status: xy, path: path });
		}
		if (xy[1] !== " " && xy[1] !== "?") {
			unstaged.push({ status: xy, path: path });
		}
	}
	return { staged, unstaged, untracked, ignored };
}

/**
 * @param {string} track `%(upstream:track)` value, e.g. `[ahead 2, behind 1]`
 * @returns {{ahead: number, behind: number, gone: boolean}}
 */
function parseTrack(track) {
	if (!track) return { ahead: 0, behind: 0, gone: false };
	if (/gone/.test(track)) return { ahead: 0, behind: 0, gone: true };
	const ahead = /ahead (\d+)/.exec(track);
	const behind = /behind (\d+)/.exec(track);
	return {
		ahead: ahead ? Number(ahead[1]) : 0,
		behind: behind ? Number(behind[1]) : 0,
		gone: false,
	};
}

/**
 * A local branch is "on a remote" when a remote-tracking ref shares its name.
 * The check is against the CURRENT remote-tracking refs, so run `git fetch`
 * first if the answer must reflect the live remote.
 * @param {string} repo
 * @returns {Promise<{branches: BranchEntry[], remoteNames: Set<string>}>}
 */
async function branchInfo(repo) {
	// A literal tab, not `%x1f`: `git for-each-ref` (unlike `git log`) does not
	// expand hex escapes in --format, so the field separator arrives literally.
	// Ref names cannot contain a tab, and `split` keeps empty fields intact.
	const format = [
		"%(refname:short)",
		"%(upstream:short)",
		"%(upstream:track)",
		"%(objectname:short)",
	].join("\t");
	const local = await git(
		repo,
		["for-each-ref", `--format=${format}`, "refs/heads"],
		{ must: false },
	);
	const remote = await git(
		repo,
		["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
		{ must: false },
	);

	const remoteNames = new Set();
	for (const line of remote.stdout.split("\n")) {
		const name = line.trim();
		if (!name || name.endsWith("/HEAD")) continue;
		const slash = name.indexOf("/");
		if (slash >= 0) remoteNames.add(name.slice(slash + 1));
	}

	/** @type {BranchEntry[]} */
	const branches = [];
	for (const line of local.stdout.split("\n")) {
		if (!line) continue;
		const [name, upstream, track, object] = line.split("\t");
		const { ahead, behind, gone } = parseTrack(track);
		branches.push({
			name: name,
			upstream: upstream || null,
			object: object ?? "",
			ahead: ahead,
			behind: behind,
			gone: gone,
			onRemote: remoteNames.has(name),
		});
	}
	return { branches, remoteNames };
}

/**
 * @param {string} repo
 * @returns {Promise<StashEntry[]>}
 */
async function stashInfo(repo) {
	const r = await git(repo, ["stash", "list", `--format=%gd%x1f%ct%x1f%gs`], {
		must: false,
	});
	/** @type {StashEntry[]} */
	const stashes = [];
	for (const line of r.stdout.split("\n")) {
		if (!line) continue;
		const [ref, seconds, subject] = line.split(UNIT);
		const files = await git(repo, ["stash", "show", "--name-only", ref], {
			must: false,
		});
		stashes.push({
			ref: ref,
			date: seconds ? new Date(Number(seconds) * 1000).toISOString() : null,
			subject: subject ?? "",
			files: files.stdout.split("\n").filter(Boolean),
		});
	}
	return stashes;
}

/**
 * @param {string} repo
 * @param {Options} o
 * @returns {Promise<RepoInfo>}
 */
async function inspectRepo(repo, o) {
	const bare =
		(
			await git(repo, ["rev-parse", "--is-bare-repository"], { must: false })
		).stdout.trim() === "true";
	const headRef = await git(repo, ["symbolic-ref", "-q", "HEAD"], {
		must: false,
	});
	const detached = headRef.code !== 0;
	const head = detached
		? (
				await git(repo, ["rev-parse", "--short", "HEAD"], { must: false })
			).stdout.trim()
		: headRef.stdout.trim().replace(/^refs\/heads\//, "");

	/** @type {RepoInfo} */
	const info = {
		path: resolve(repo),
		bare: bare,
		head: head,
		detached: detached,
		upstream: null,
		ahead: 0,
		behind: 0,
		uncommitted: { staged: [], unstaged: [], untracked: [], ignored: [] },
		stashes: [],
		branches: [],
		localOnly: [],
		aheadBranches: [],
		goneBranches: [],
		findings: 0,
	};

	if (!bare) {
		info.uncommitted = await statusBuckets(repo, o.ignored);
		info.stashes = await stashInfo(repo);
	}

	const { branches } = await branchInfo(repo);
	info.branches = branches;
	for (const branch of branches) {
		if (branch.name === head) {
			info.upstream = branch.upstream;
			info.ahead = branch.ahead;
			info.behind = branch.behind;
		}
		if (!branch.onRemote) info.localOnly.push(branch.name);
		if (branch.ahead > 0) info.aheadBranches.push(branch.name);
		if (branch.gone) info.goneBranches.push(branch.name);
	}

	const u = info.uncommitted;
	info.findings =
		u.staged.length +
		u.unstaged.length +
		u.untracked.length +
		u.ignored.length +
		info.stashes.length +
		info.localOnly.length +
		info.aheadBranches.length +
		info.goneBranches.length;
	return info;
}

/**
 * @template T
 * @param {T[]} list
 * @param {number} max
 * @returns {(T|string)[]}
 */
function capped(list, max) {
	if (list.length <= max) return list;
	return [...list.slice(0, max), `… ${list.length - max} more`];
}

/**
 * @param {RepoInfo} info
 * @param {Options} o
 * @returns {string}
 */
function formatRepo(info, o) {
	const lines = [];
	const head = info.bare
		? `${info.head} (bare)`
		: info.detached
			? `${info.head} (detached)`
			: `${info.head}${info.upstream ? ` → ${info.upstream}` : ""}`;
	lines.push(`${info.path}`);
	lines.push(
		`  HEAD ${head}${info.ahead || info.behind ? `  +${info.ahead}/-${info.behind}` : ""}`,
	);

	const u = info.uncommitted;
	/** @type {[string, (StatusEntry|string)[]][]} */
	const sections = [
		["staged", u.staged],
		["unstaged", u.unstaged],
		["untracked", u.untracked],
		["ignored", u.ignored],
	];
	for (const [label, entries] of sections) {
		if (!entries.length) continue;
		lines.push(`  ${label.toUpperCase()} (${entries.length})`);
		for (const entry of capped(entries, o.maxEntries)) {
			if (typeof entry === "string") {
				lines.push(`    ${entry}`);
			} else {
				lines.push(`    ${entry.status}  ${entry.path}`);
			}
		}
	}

	if (info.stashes.length) {
		lines.push(`  STASHES (${info.stashes.length})`);
		for (const stash of info.stashes) {
			lines.push(
				`    ${stash.ref}  ${stash.date ?? ""}  ${stash.subject}  (${stash.files.length} files)`,
			);
		}
	}

	if (info.localOnly.length) {
		lines.push(`  BRANCHES NOT ON ANY REMOTE (${info.localOnly.length})`);
		for (const name of capped(info.localOnly, o.maxEntries))
			lines.push(`    ${name}`);
	}

	if (info.aheadBranches.length) {
		lines.push(`  AHEAD OF UPSTREAM (${info.aheadBranches.length})`);
		for (const name of capped(info.aheadBranches, o.maxEntries)) {
			const branch = info.branches.find((b) => b.name === name);
			lines.push(
				`    ${name}  ${branch?.upstream ?? ""}  +${branch?.ahead ?? 0}`,
			);
		}
	}

	if (info.goneBranches.length) {
		lines.push(`  UPSTREAM GONE (${info.goneBranches.length})`);
		for (const name of capped(info.goneBranches, o.maxEntries))
			lines.push(`    ${name}`);
	}

	if (info.findings === 0)
		lines.push("  (clean — nothing local that a remote lacks)");
	return lines.join("\n");
}

/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"usage: ./git/local-changes.sh [--repo DIR] [--root DIR] [--json] [--all]\n" +
				"                              [--max-depth N] [--max-entries N] [--no-ignored]\n" +
				"                              [--only GLOB]... [--exclude GLOB]...\n",
		);
		return;
	}

	/** @type {string[]} */
	let repos;
	if (o.root) {
		if (!existsSync(o.root))
			throw Object.assign(new Error("root not found"), { root: o.root });
		const discovered = findCloneRoots(o.root, o.maxDepth);
		const rels = discovered.map((p) => relative(o.root, p));
		const kept = new Set(filterByGlobs(rels, o.only, o.exclude));
		repos = discovered.filter((p) => kept.has(relative(o.root, p)));
		logInfo("discovered clones", { root: o.root, count: repos.length });
	} else {
		const repo = resolve(o.repo);
		if (!existsSync(repo))
			throw Object.assign(new Error("repo not found"), { repo });
		repos = [repo];
	}

	const infos = await pool(repos, 4, (repo) => inspectRepo(repo, o));
	const shown =
		o.root && !o.all ? infos.filter((info) => info.findings > 0) : infos;

	if (o.json) {
		process.stdout.write(`${JSON.stringify({ repos: shown }, null, 2)}\n`);
	} else if (shown.length === 0) {
		process.stdout.write("no repositories with local-only changes found\n");
	} else {
		process.stdout.write(
			`${shown.map((info) => formatRepo(info, o)).join("\n\n")}\n`,
		);
	}

	const dirty = infos.filter((info) => info.findings > 0).length;
	logInfo("local-changes summary", {
		repos: infos.length,
		withFindings: dirty,
		shown: shown.length,
	});
}

await main().catch((err) => {
	logError("local-changes aborted", {
		error: err,
	});
	process.exit(1);
});
