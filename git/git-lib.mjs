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
 *
 * This file is also on the native Windows path (the `maintain.ps1` entry,
 * docs/d062): nothing in it assumes POSIX path separators or bare-path import
 * specifiers — discovery takes paths opaquely, globs normalize separators,
 * and the logger import is a file: URL.
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
// A Windows LIB_DIR (`C:\...\lib`) is not a loadable specifier — the drive
// letter parses as a URL scheme and the ESM loader rejects it — so the logger
// is reached through an explicit file: URL, the one spelling valid everywhere
// (docs/d062).
const { logError, logInfo, logWarn, setLogStream, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(pathToFileURL(join(LIB_DIR, "log.mjs")).href)
	);

// vbs-har's manifest is the one artifact this folder writes: it goes through
// the repo's atomic writer (tmp+rename, docs/d050) rather than a bare
// writeFileSync, so a killed run cannot leave a truncated manifest behind.
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(pathToFileURL(join(LIB_DIR, "artifact.mjs")).href)
);

// Every tool in this folder prints a machine-consumed payload on stdout
// (audit's JSON report, search-references' results, vbs-har's manifest,
// local-changes' --json) — logs go to stderr so the two streams stay
// separable; `2>&1 | jq` still yields one jsonlines stream (docs/d045).
setLogStream("stderr");

export { logError, logInfo, logWarn, setLogTool, writeArtifact };

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
 * The environment every `git()` child inherits — the fail-fast contract for
 * the whole mirror fleet (docs/d075). Without it a missing credential or a
 * deleted upstream repo makes git ask for a username on the operator's
 * terminal, and an unanswered prompt hangs the run: one repo's dead token
 * would block the other 775 mirrors instead of becoming that repo's logged
 * fetch failure.
 *
 * `GIT_TERMINAL_PROMPT` is the load-bearing entry: verified that
 * `GIT_ASKPASS=/usr/bin/false` alone does NOT stop the hang — git reports the
 * dead askpass and falls back to its terminal prompt anyway. The askpass
 * entries only close the askpass channel, and `GCM_INTERACTIVE` is what stops
 * Git Credential Manager's GUI dialog on the `maintain.ps1` Windows path
 * (docs/d062), which `GIT_TERMINAL_PROMPT` never reaches. None of these
 * disable any already-stored credential (helper/store/manager answers come
 * first), so a healthy configured host keeps working unchanged.
 *
 * `GIT_SSH_COMMAND` fills the UNSET case only — an operator's own value
 * carries their ssh wiring (identity file, port, jump host) and is not this
 * library's to clobber. BatchMode is what turns ssh's prompts (host key
 * confirmation, key passphrase, keyboard-interactive) into failures, since
 * `GIT_TERMINAL_PROMPT` covers git's https prompts exclusively — so a
 * first-contact host must be in known_hosts (ssh-keyscan) beforehand.
 *
 * `/usr/bin/false` need not exist on the host: a missing askpass binary only
 * fails the askpass attempt, whose terminal fallback is already disabled —
 * the net result is a fast error either way.
 *
 * Computed at call time, not import time: the fallback must answer "is
 * GIT_SSH_COMMAND set NOW", whatever set it.
 * @returns {NodeJS.ProcessEnv}
 */
function noninteractiveGitEnv() {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/usr/bin/false",
		SSH_ASKPASS: "/usr/bin/false",
		GCM_INTERACTIVE: "Never",
		GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
	};
}

/**
 * Run `git -C cwd args…`. NEVER throws unless `must` is true: the mirror
 * tooling is a best-effort fleet operation, one broken remote must not abort
 * the other 775 repos. Every child runs with `noninteractiveGitEnv()` — a
 * fleet sweep must fail one repo, never hang on its prompt (docs/d075).
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
			{
				encoding: "utf-8",
				maxBuffer: 256 * 1024 * 1024,
				env: noninteractiveGitEnv(),
			},
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
		if (depth > maxDepth) {
			return;
		}
		/** @type {import("node:fs").Dirent[]} */
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (hasGitDir(entries)) {
			out.push(dir);
		}
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".")) {
				continue;
			}
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
		if (depth > maxDepth) {
			return;
		}
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
			if (!e.isDirectory() || e.name.startsWith(".")) {
				continue;
			}
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
				const item = items[i];
				// i >= items.length is the exit; the undefined check is its
				// type-gate form (same fact, a shape the flag can verify).
				if (i >= items.length || item === undefined) {
					return;
				}
				results[i] = await worker(item, i);
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
 *
 * BOTH sides are read in `/` spelling: `path.relative()` yields `\\`-separated
 * subjects on Windows while the operator-facing globs are documented in `/`.
 * A backslash is not this glob's escape character, so normalizing both sides
 * changes no match a POSIX farm sees — while on Windows an `--exclude` that
 * never matched would spare nothing, and `migrate-to-bare.mjs
 * --delete-originals` acts on that answer (docs/d062). Normalization is only
 * for the test: the caller's strings pass through untouched, so
 * `filterByGlobs` results still compare equal to the caller's own
 * `relative()` output.
 * @param {string} glob
 * @returns {(s: string) => boolean}
 */
export function globMatcher(glob) {
	const pattern = glob.replaceAll("\\", "/");
	let re = "";
	for (let i = 0; i < pattern.length; i += 1) {
		const c = pattern[i];
		// The loop condition guarantees a value; the check is the type gate's
		// form of that fact.
		if (c === undefined) {
			break;
		}
		if (c === "*") {
			if (pattern[i + 1] === "*") {
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
	return (s) => rx.test(s.replaceAll("\\", "/"));
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
		if (onlyFns.length > 0 && !onlyFns.some((f) => f(r))) {
			return false;
		}
		if (excludeFns.some((f) => f(r))) {
			return false;
		}
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
	await setOptimizationConfig(repo);
	await writePickaxePack(repo);
}

/**
 * The pack/commit-graph sequence every optimizing pass ends with — the WHY of
 * its order and flags lives on optimizeMirror, and docs/d089 keeps the pass
 * ladder apart.
 * @param {string} repo absolute path to a bare repo
 * @returns {Promise<void>}
 */
async function writePickaxePack(repo) {
	await git(repo, ["repack", "-adb", "--write-bitmap-index"]);
	await git(repo, ["commit-graph", "write", "--reachable", "--changed-paths"]);
}

/**
 * Config every optimizing pass sets before its git work: gc.writeCommitGraph
 * is what makes the deep pass's own gc write a graph at all, and
 * fetch.writeCommitGraph keeps later plain fetches current (docs/d089).
 * @param {string} repo absolute path to a bare repo
 * @returns {Promise<void>}
 */
async function setOptimizationConfig(repo) {
	await git(repo, ["config", "core.commitGraph", "true"]);
	await git(repo, ["config", "gc.writeCommitGraph", "true"]);
	await git(repo, ["config", "fetch.writeCommitGraph", "true"]);
}

/**
 * The deep pass (docs/d089): a forced delta recomputation (window/depth 250) —
 * the storage win for slow-moving mirrors on constrained cold storage that the
 * delta-reusing routine pass can never produce on its own. gc's own
 * commit-graph write carries no --changed-paths guarantee and its bitmap write
 * is conditional, so the routine sequence re-runs over the fresh pack: noise
 * against the forced repack, and it pins the end-state every optimizing pass
 * must leave the mirror in.
 * @param {string} repo absolute path to a bare repo
 * @returns {Promise<void>}
 */
export async function deepOptimizeMirror(repo) {
	await setOptimizationConfig(repo);
	await git(repo, ["gc", "--aggressive"]);
	await writePickaxePack(repo);
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

/**
 * Serialize gated work and leave `intervalMs` of idle time after each call —
 * the JS counterpart of `-vbs-mirror-all.sh`'s `sleep $VBS_THROTTLE` between
 * repos. Serializing matters as much as the gap: a pool worker starting a
 * fetch while another is still in flight would still be two concurrent
 * requests to the forge, which is exactly what the software-forge tenant
 * rate-limits even at `--jobs 1` (docs/d044). `intervalMs <= 0` returns a
 * pass-through so a public-forge-only sweep pays nothing.
 *
 * @param {number} intervalMs idle milliseconds after each gated call
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
export function createMinIntervalGate(intervalMs) {
	if (intervalMs <= 0) {
		return (fn) => fn();
	}
	let tail = Promise.resolve();
	return (fn) => {
		const run = tail.then(async () => {
			try {
				return await fn();
			} finally {
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
			}
		});
		// `tail` must never reject, or a failing mirror would skip the turn of
		// every later gate call and the sweep would burst after it.
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}
