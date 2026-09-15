/**
 * @fileoverview git-lib.mjs — shared helpers for the reference-mirror tooling
 * in this folder (`migrate-to-bare.mjs`, `maintain-mirrors.mjs`). It owns the
 * three things both scripts must agree on: how to run git without throwing the
 * run away, how to DISCOVER repos under a reference root, and the exact
 * optimization sequence that makes deep history search (git pickaxe) fast.
 *
 * Discovery is structural, not manifest-driven: a non-bare clone is any
 * directory that contains a `.git/` directory, and a bare mirror is any
 * directory that directly contains `HEAD` + `objects/` + `refs/`. Walking stops
 * at the first hit, so the walk never descends into a repo's working tree
 * (that is where the 1.6M-file blowup lives — see non-bare-issues.md). That
 * keeps discovery O(#owners + #repos), not O(#files).
 *
 * Why bare mirrors at all, and why `git -C <repo>` still answers every
 * history/pickaxe question without a checkout: see non-bare-issues.md. The
 * short version is that a working tree is pure overhead for search and it is
 * what makes podman's `z,U` relabel walk take ~39 s.
 *
 * Import convention (docs/d023): the shared logger resolves through `$LIB_DIR`
 * so the same file works in place and under any staged copy.
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const scriptDir = dirname(fileURLToPath(import.meta.url));
export const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logError, logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);

export { logError, logInfo, logWarn, setLogTool };

/**
 * The reference root to operate on when `--root` is not given. Matches the
 * mount the coding-agent runner used to take (coding-agent/run.sh), so the
 * mirror farm and the retired bind mount describe the same tree.
 */
export const DEFAULT_ROOT =
	process.env.REFERENCES_ROOT ?? join(homedir(), "Downloads", "references");

/**
 * Where bare mirrors go when `--dest` is not given. A SEPARATE tree, not
 * siblings of the clones: some reference "owners" are themselves repos that
 * contain further clones (e.g. github/duckdb holds the duckdb/* repos), so a
 * mirror created beside its clone would sit inside another clone's working
 * tree and be destroyed by `--delete-originals`. A parallel root makes the
 * farm flat, deletable and directly servable.
 */
export const DEFAULT_DEST =
	process.env.REFERENCES_MIRRORS ?? `${DEFAULT_ROOT}-bare`;

/**
 * Default recursion bound. The mirror layout is
 * `<root>/github/<owner>/<repo>[.git]`; 5 reaches the one nesting seen in the
 * farm (`github/empjustine/agentcontainerOLD/agentcontainer2`).
 */
export const DEFAULT_MAX_DEPTH = 5;

/**
 * @param {number} n
 * @returns {string}
 */
export function humanBytes(n) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

/**
 * Run `git -C cwd args…`. NEVER throws unless `must` is true: the mirror
 * tooling is a best-effort fleet operation, one broken remote must not abort
 * the other 775 repos.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ must?: boolean }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function git(cwd, args, opts = {}) {
	const { must = true } = opts;
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{ encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const out = String(stdout ?? "");
				const errout = String(stderr ?? "");
				if (err) {
					if (must) {
						reject(
							new Error(
								`git ${args.join(" ")} (in ${cwd}) failed: ${
									errout.trim() || err.message
								}`,
							),
						);
					} else {
						resolve({
							code: typeof err.code === "number" ? err.code : 1,
							stdout: out,
							stderr: errout,
						});
					}
					return;
				}
				resolve({ code: 0, stdout: out, stderr: errout });
			},
		);
	});
}

/**
 * A directory is a non-bare clone when it directly contains `.git/`.
 * @param {{ name: string, isDirectory(): boolean }[]} entries
 * @returns {boolean}
 */
function hasGitDir(entries) {
	return entries.some((e) => e.isDirectory() && e.name === ".git");
}

/**
 * A directory is a bare repo when it directly contains `HEAD`, `objects/` and
 * `refs/`. A non-bare clone root does NOT match this (its `.git/` holds them).
 * @param {{ name: string, isDirectory(): boolean, isFile(): boolean }[]} entries
 * @returns {boolean}
 */
function looksBare(entries) {
	const names = new Set(entries.map((e) => e.name));
	const hasObjects = entries.some(
		(e) => e.isDirectory() && e.name === "objects",
	);
	const hasRefs = entries.some((e) => e.isDirectory() && e.name === "refs");
	const hasHead = entries.some((e) => e.isFile() && e.name === "HEAD");
	return names.has("HEAD") && hasObjects && hasRefs && hasHead;
}

/**
 * Walk `root` and return every non-bare clone root (depth-first, sorted). A
 * repo root is a directory directly containing `.git/`; the walk CONTINUES
 * past it (unlike a naive prune) because some reference "owners" are repos
 * that wrap further clones (github/duckdb). Hidden dirs and `.git` itself are
 * never descended into.
 * @param {string} root
 * @param {number} [maxDepth]
 * @returns {string[]}
 */
export function findCloneRoots(root, maxDepth = DEFAULT_MAX_DEPTH) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} dir @param {number} depth */
	const walk = (dir, depth) => {
		if (depth > maxDepth) return;
		/** @type {import("node:fs").Dirent[]} */
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (hasGitDir(entries)) out.push(dir);
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".")) continue;
			walk(join(dir, e.name), depth + 1);
		}
	};
	walk(root, 0);
	return out.sort();
}

/**
 * Walk `root` and return every bare mirror (depth-first, sorted). Symmetric to
 * findCloneRoots; a bare repo is a leaf for this walk.
 * @param {string} root
 * @param {number} [maxDepth]
 * @returns {string[]}
 */
export function findBareMirrors(root, maxDepth = DEFAULT_MAX_DEPTH) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} dir @param {number} depth */
	const walk = (dir, depth) => {
		if (depth > maxDepth) return;
		/** @type {import("node:fs").Dirent[]} */
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (looksBare(entries)) {
			out.push(dir);
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".")) continue;
			walk(join(dir, e.name), depth + 1);
		}
	};
	walk(root, 0);
	return out.sort();
}

/**
 * Bounded-concurrency map. Each worker runs until the shared cursor drains, so
 * a slow network fetch on one repo does not leave the other slots idle.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>} results in input order
 */
export async function pool(items, limit, worker) {
	/** @type {R[]} */
	const results = new Array(items.length);
	let next = 0;
	const runners = Math.max(1, Math.min(limit, items.length));
	await Promise.all(
		Array.from({ length: runners }, async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await worker(items[i], i);
			}
		}),
	);
	return results;
}

/**
 * Compile a shell-style glob (`*` = within a path segment, `**` = across
 * segments, `?` = one char) into a predicate over a relative path. Used by the
 * `--only`/`--exclude` filters so a known-bad reference entry can be skipped
 * without editing the farm.
 * @param {string} glob
 * @returns {(s: string) => boolean}
 */
export function globMatcher(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i += 1) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i += 1;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	const rx = new RegExp(`^${re}$`);
	return (s) => rx.test(s);
}

/**
 * Apply `--only`/`--exclude` globs to a list of relative paths. `--only`
 * globs are OR-ed (empty = all); an `--exclude` match removes regardless.
 * @param {string[]} rels
 * @param {string[]} only
 * @param {string[]} exclude
 * @returns {string[]}
 */
export function filterByGlobs(rels, only, exclude) {
	const onlyFns = only.map(globMatcher);
	const excludeFns = exclude.map(globMatcher);
	return rels.filter((r) => {
		if (onlyFns.length && !onlyFns.some((f) => f(r))) return false;
		if (excludeFns.some((f) => f(r))) return false;
		return true;
	});
}

/**
 * The pickaxe optimizations, in the one order that is correct:
 *
 *   1. `repack -adb --write-bitmap-index` — collapse to one pack, drop
 *      redundant packs, write the reachability bitmap that speeds every
 *      `rev-list`/`log` walk.
 *   2. `commit-graph write --reachable --changed-paths` — the commit graph
 *      (skip parent/date walks) PLUS changed-path Bloom filters. The filters
 *      are what actually accelerates `git log -S`/`-G` — but ONLY when a
 *      pathspec is supplied, because they answer "did this commit touch path
 *      P?", not "does this commit's blob contain string S?". Documented in
 *      non-bare-issues.md; do not drop the `--changed-paths` flag thinking it
 *      is a no-op.
 *
 * Config is set so later fetches/gc keep the graph current, but the explicit
 * write is still required for the Bloom filters on an already-fetched mirror.
 * @param {string} repo absolute path to a bare repo
 * @returns {Promise<void>}
 */
export async function optimizeMirror(repo) {
	await git(repo, ["config", "core.commitGraph", "true"]);
	await git(repo, ["config", "gc.writeCommitGraph", "true"]);
	await git(repo, ["config", "fetch.writeCommitGraph", "true"]);
	await git(repo, ["repack", "-adb", "--write-bitmap-index"]);
	await git(repo, ["commit-graph", "write", "--reachable", "--changed-paths"]);
}

/**
 * The upstream URL a repo fetches from, or null when it has none (a purely
 * local repo — maintenance cannot align it).
 * @param {string} repo
 * @returns {Promise<string|null>}
 */
export async function originUrl(repo) {
	const r = await git(repo, ["config", "--get", "remote.origin.url"], {
		must: false,
	});
	const url = r.stdout.trim();
	return r.code === 0 && url ? url : null;
}
