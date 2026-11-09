#!/usr/bin/env node
/**
 * @fileoverview farm-tool.mjs — d099's reference-farm tool surface: positional
 * argv, one JSON object on stdout (the payload stream), structured logs on
 * stderr (docs/d045), nothing interpolated into a shell string anywhere. The
 * operator entry is the `farm-tool.sh` shim beside this file.
 *
 * This is the MCP tool surface at its CLI stage: the later stdio MCP server
 * wraps THIS entry verbatim (same argv shape, same envelopes), so the safety
 * posture never forks into two implementations (docs/d099). Read tools are
 * capped-by-construction and cannot mutate (GIT_OPTIONAL_LOCKS=0 plus a
 * scrubbed env, all of it in `lib/farm-posture.mjs`); the two maintenance verbs
 * wrap the existing operator scripts under the farm-wide mutation lock, which
 * those scripts themselves take (docs/d121 — node only names and probes it).
 *
 * What is HERE is the verbs: their argv shapes, their envelopes, their caps and
 * their exit codes. Anything a second tool would also need is in the posture
 * module, so a new verb cannot invent a second rule for it.
 *
 * Exit codes: 0 ok · 1 tool failed (child error, unknown rev/path) ·
 * 2 usage/argv error · 3 not found (repo/rev/path/farm) · 4 refused
 * (fan-out bound) · 5 git failed/timed out.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	clearLockStatus,
	farmMutationLockPath,
	probeFarmMutationLock,
	readLockHolder,
	writeLockStatus,
} from "./lib/farm-lock.mjs";
import {
	CAPS,
	CollectWindow,
	blobLineWindow,
	FarmError,
	emitEnvelope,
	emitHits,
	farmGit,
	farmGitOrNull,
	farmRoot,
	initScratch,
	refuse,
	requireFarm,
	requireGlob,
	requirePath,
	requireRev,
	requireRepoId,
	requireSince,
	requireUint,
	describeEntry,
	resolveRepo,
	selectRepos,
	stripControl,
	stripControlBytes,
} from "./lib/farm-posture.mjs";
import { caseGlob, logError, logWarn, setLogTool } from "./lib/git-core.mjs";

const TOOL = "git/farm-tool";
// Importing git-core above already pointed the logger at stderr; the tool name
// is this file's own fact.
setLogTool(TOOL);

/** The maintenance children are found beside THIS file, never the caller's cwd. */
const DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The requested tool, so a refusal thrown from any depth can still carry the
 * name the caller used (the shell's `$FG_TOOL`). Set once, before dispatch.
 * @type {string}
 */
let currentTool = "";

// --- argv helpers ---------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {number} max
 * @param {string} usage the exact message a caller may already script against
 */
function arity(argv, max, usage) {
	if (argv.length > max) {
		refuse(2, usage);
	}
}

/**
 * @param {string[]} argv
 * @param {number} min
 * @param {number} max
 * @param {string} usage
 */
function arityBetween(argv, min, max, usage) {
	if (argv.length < min || argv.length > max) {
		refuse(2, usage);
	}
}

/**
 * A collect window from the trailing `[CURSOR] [MAX]` pair both listing verbs
 * share, defaulted from the server cap — never from the environment.
 * @param {string|undefined} cursorArg
 * @param {string|undefined} maxArg
 * @returns {CollectWindow}
 */
function beginCollect(cursorArg, maxArg) {
	const cursor = requireUint(cursorArg ?? "0");
	const max = requireUint(maxArg ?? String(CAPS.maxResults));
	return new CollectWindow(cursor, max);
}

/** @param {string} id — validated by selectRepos before it reaches here. */
const logUnreadable = (id) => logWarn("unreadable HEAD — skipped", { repo: id });

/** @param {string} stderr — git's last word on why it failed. */
function lastLine(stderr) {
	return stderr.trim().split("\n").pop() ?? "";
}

/**
 * One `git grep` line (`rev:path:line:text`) as its parts, with the rev the
 * search was pinned to taken off the front. The farm-wide search and the
 * single-rev grep read the same stream, so the parse has one home.
 * @param {string} raw
 * @param {string} sha the rev git grep was given
 * @returns {{ path: string, line: number, text: string }}
 */
function parseGrepLine(raw, sha) {
	const line = raw.startsWith(`${sha}:`) ? raw.slice(sha.length + 1) : raw;
	const firstColon = line.indexOf(":");
	const path = firstColon === -1 ? line : line.slice(0, firstColon);
	const rest = firstColon === -1 ? "" : line.slice(firstColon + 1);
	const secondColon = rest.indexOf(":");
	const lineNo = secondColon === -1 ? rest : rest.slice(0, secondColon);
	const text = secondColon === -1 ? "" : rest.slice(secondColon + 1);
	return {
		path,
		line: /^[0-9]+$/.test(lineNo) ? Number(lineNo) : 0,
		text,
	};
}

/**
 * The commit a REV names, or a not-found refusal. Every rev-taking verb fails
 * the same way, so resolution and its message live in one place.
 * @param {string} repoPath
 * @param {string} id
 * @param {string} rev
 * @returns {Promise<string>}
 */
async function resolveCommit(repoPath, id, rev) {
	const sha = await farmGitOrNull(repoPath, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${rev}^{commit}`,
	]);
	if (sha === null) {
		refuse(3, "no such rev in this mirror", { repo: id, rev });
	}
	return stripControl(sha);
}

// --- read tools -----------------------------------------------------------

/**
 * list_repos [FILTER] [CURSOR] [MAX]
 * The farm as d099 needs it: bare mirrors with the urls the farm itself
 * records, ref counts and default branch for orientation. `matches` stays the
 * count of mirrors whose id matches FILTER even when the window truncates, so
 * a caller can page the whole farm.
 * @param {string[]} argv
 * @param {string} root
 */
async function listRepos(argv, root) {
	arity(argv, 3, "usage: list_repos [FILTER] [CURSOR] [MAX]");
	requireFarm(root);
	const selected = selectRepos(root, argv[0] ?? "*");
	const window = beginCollect(argv[1], argv[2]);
	for (const id of selected.ids) {
		const repoPath = resolveRepo(root, id);
		const url = await farmGitOrNull(repoPath, [
			"config",
			"--get",
			"remote.origin.url",
		]);
		const branch = await farmGitOrNull(repoPath, [
			"symbolic-ref",
			"-q",
			"--short",
			"HEAD",
		]);
		const refs = await farmGit(["-C", repoPath, "for-each-ref", "--format=x"]);
		const refCount = refs.stdout.split("\n").length - 1;
		window.collect({
			id: stripControl(id),
			url: url === null ? null : stripControl(url),
			default_branch: branch === null ? null : stripControl(branch),
			ref_count: refCount,
		});
	}
	emitHits("list_repos", { matches: selected.ids.length }, window);
}

/**
 * list_refs REPO [CURSOR] [MAX]
 * Every ref in one mirror, typed from its name. Remote-tracking and tags are
 * included on purpose: a mirror's whole value is the refs the origin no longer
 * serves.
 * @param {string[]} argv
 * @param {string} root
 */
async function listRefs(argv, root) {
	arityBetween(argv, 1, 3, "usage: list_refs REPO [CURSOR] [MAX]");
	requireFarm(root);
	const repoId = requireRepoId(`${argv[0]}`);
	const repoPath = resolveRepo(root, repoId);
	const window = beginCollect(argv[1], argv[2]);
	// git for-each-ref does NOT expand %x1f (verified on git 2.47), so the
	// separator is a literal unit separator — safe as data because git ref
	// names may not contain control characters.
	const us = "\x1f";
	const res = await farmGit([
		"-C",
		repoPath,
		"for-each-ref",
		`--format=%(refname)${us}%(objectname)`,
	]);
	if (res.code !== 0) {
		refuse(5, "git for-each-ref failed", {
			repo: repoId,
			detail: lastLine(res.stderr),
		});
	}
	for (const line of res.stdout.split("\n")) {
		if (!line) {
			continue;
		}
		// No separator would mean a ref name git could not pair with a sha;
		// the shell then reported the whole line as both halves, and a caller
		// reads that as corrupt data rather than as a silent drop.
		const sep = line.indexOf(us);
		const ref = sep === -1 ? line : line.slice(0, sep);
		const sha = sep === -1 ? line : line.slice(sep + us.length);
		const type = ref.startsWith("refs/heads/")
			? "branch"
			: ref.startsWith("refs/tags/")
				? "tag"
				: ref.startsWith("refs/remotes/")
					? "remote"
					: "other";
		window.collect({
			ref: stripControl(ref),
			type,
			sha: stripControl(sha),
		});
	}
	emitHits("list_refs", {}, window);
}

/**
 * search_code QUERY [REPO_GLOB] [PATH_GLOB] [MODE] [MAX] [CURSOR] [WIDE]
 * d099's rung-1 search: live `git grep` over a bounded repo fan-out, hits
 * pinned to the commit that was actually searched. MODE is fixed (default,
 * `-F`) or regex; PATH_GLOB is a shell glob applied to paths AFTER grep
 * matched (it can never reach an argv as a pattern). WIDE=1 opts in past the
 * fan-out bound — farm-wide scope still needs the Zoekt index (docs/d043), this
 * only refuses less often.
 * @param {string[]} argv
 * @param {string} root
 */
async function searchCode(argv, root) {
	arityBetween(
		argv,
		1,
		7,
		"usage: search_code QUERY [REPO_GLOB] [PATH_GLOB] [MODE] [MAX] [CURSOR] [WIDE]",
	);
	requireFarm(root);
	const query = argv[0];
	if (!query) {
		refuse(2, "empty query");
	}
	const selected = selectRepos(root, argv[1] ?? "*");
	const pathGlob = requireGlob(argv[2] ?? "");
	const mode = argv[3] ?? "fixed";
	if (mode !== "fixed" && mode !== "regex") {
		refuse(2, "MODE must be fixed or regex", { mode });
	}
	const wide = argv[6] ?? "0";
	if (wide !== "0" && wide !== "1") {
		refuse(2, "WIDE must be 0 or 1", { wide });
	}
	if (selected.ids.length > CAPS.grepRepos && wide !== "1") {
		refuse(
			4,
			"live-grep fan-out exceeded — narrow the repo filter, or pass WIDE=1 to attempt it",
			{ repos: selected.ids.length, bound: CAPS.grepRepos },
		);
	}
	const window = beginCollect(argv[5], argv[4]);
	const pathMatches = pathGlob ? caseGlob(pathGlob) : null;
	// Labelled: the full window is discovered deep inside the per-repo grep
	// loop, and it must stop the farm walk, not just this repo's lines.
	outer: for (const id of selected.ids) {
		const repoPath = resolveRepo(root, id);
		const sha = await farmGitOrNull(repoPath, [
			"rev-parse",
			"--verify",
			"--end-of-options",
			"HEAD",
		]);
		if (sha === null) {
			logUnreadable(id);
			continue;
		}
		const grepArgs = ["-C", repoPath, "grep", "-I", "-n", "--no-color"];
		if (mode === "fixed") {
			grepArgs.push("-F");
		}
		// -I: binary files are not matched ("Binary file … matches" is not
		// path:line:text and would corrupt the parsed stream).
		grepArgs.push("-e", query, "--end-of-options", sha);
		const res = await farmGit(grepArgs);
		if (res.code === 1) {
			continue;
		}
		if (res.code === 124) {
			refuse(5, "git grep timed out", { repo: id });
		}
		if (res.code !== 0) {
			refuse(5, "git grep failed", {
				repo: id,
				rc: res.code,
				detail: lastLine(res.stderr),
			});
		}
		for (const raw of res.stdout.split("\n")) {
			if (!raw) {
				continue;
			}
			const hit = parseGrepLine(raw, sha);
			if (pathMatches && !pathMatches(hit.path)) {
				continue;
			}
			window.collect({
				repo: stripControl(id),
				commit_sha: stripControl(sha),
				path: stripControl(hit.path),
				line: hit.line,
				text: stripControl(hit.text),
			});
			if (window.full()) {
				break outer;
			}
		}
	}
	emitHits("search_code", { repos_matched: selected.ids.length }, window);
}

/**
 * search_paths PATH_GLOB [REPO_GLOB] [CURSOR] [MAX]
 * Which files exist by name: `git ls-tree -r` names, glob-filtered HERE — the
 * glob never reaches git as a pathspec, so no magic prefixes and no traversal
 * (d099's path rule). commit_sha pins each row to the HEAD that was walked.
 * @param {string[]} argv
 * @param {string} root
 */
async function searchPaths(argv, root) {
	arityBetween(
		argv,
		1,
		4,
		"usage: search_paths PATH_GLOB [REPO_GLOB] [CURSOR] [MAX]",
	);
	requireFarm(root);
	const pathGlob = requireGlob(argv[0] ?? "");
	if (!pathGlob) {
		refuse(2, "empty path glob");
	}
	const selected = selectRepos(root, argv[1] ?? "*");
	const window = beginCollect(argv[2], argv[3]);
	const pathMatches = caseGlob(pathGlob);
	outer: for (const id of selected.ids) {
		const repoPath = resolveRepo(root, id);
		const sha = await farmGitOrNull(repoPath, [
			"rev-parse",
			"--verify",
			"--end-of-options",
			"HEAD",
		]);
		if (sha === null) {
			logUnreadable(id);
			continue;
		}
		// core.quotepath=false keeps non-ASCII names raw so the glob sees real
		// bytes instead of "quoted" escapes.
		const tree = await farmGit([
			"-c",
			"core.quotepath=false",
			"-C",
			repoPath,
			"ls-tree",
			"-r",
			"--name-only",
			"--end-of-options",
			"HEAD",
		]);
		if (tree.code !== 0) {
			logWarn("ls-tree failed — skipped", { repo: id });
			continue;
		}
		for (const path of tree.stdout.split("\n")) {
			if (!path || !pathMatches(path)) {
				continue;
			}
			window.collect({
				repo: stripControl(id),
				commit_sha: stripControl(sha),
				path: stripControl(path),
			});
			if (window.full()) {
				break outer;
			}
		}
	}
	emitHits("search_paths", { repos_matched: selected.ids.length }, window);
}

// --- read_file ------------------------------------------------------------

/**
 * read_file REPO REV PATH [OFFSET] [LIMIT]
 * Chunked, capped blob read against a PINNED commit (d099: a read never moves
 * under the consumer — HEAD drift cannot re-page the file). OFFSET is 1-based,
 * LIMIT is lines; both are also byte-capped, and truncated is set when the
 * window or the byte cap cut the blob short.
 * @param {string[]} argv
 * @param {string} root
 */
async function readFile(argv, root) {
	arityBetween(argv, 3, 5, "usage: read_file REPO REV PATH [OFFSET] [LIMIT]");
	requireFarm(root);
	const repoId = requireRepoId(argv[0] ?? "");
	const repoPath = resolveRepo(root, repoId);
	const rev = requireRev(argv[1] ?? "");
	const path = requirePath(argv[2] ?? "");
	const offset = requireUint(argv[3] ?? "1");
	if (offset < 1) {
		refuse(2, "OFFSET is 1-based", { offset });
	}
	const limit = requireUint(argv[4] ?? String(CAPS.readLines));
	if (limit < 1) {
		refuse(2, "LIMIT must be at least 1", { limit });
	}
	const commitSha = await farmGitOrNull(repoPath, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		rev,
	]);
	if (commitSha === null) {
		refuse(3, "unknown rev", { rev, repo: repoId });
	}
	// The rev:path split is unambiguous because both halves were
	// allowlist-validated: the rev side carries no colon, the path carries no
	// colon and cannot be option-shaped.
	const blob = await farmGitOrNull(repoPath, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${commitSha}:${path}`,
	]);
	if (blob === null) {
		refuse(3, "no such path at rev", { repo: repoId, rev, path });
	}
	const type =
		(await farmGitOrNull(repoPath, ["cat-file", "-t", blob])) ?? "unknown";
	if (type !== "blob") {
		refuse(3, "not a blob", { repo: repoId, path, type });
	}
	const blobBytes = await farmGit(
		["-C", repoPath, "cat-file", "blob", blob],
		{ buffer: true },
	);
	const { chunk, more } = blobLineWindow(blobBytes.bytes, offset, limit);
	const filtered = stripControlBytes(chunk);
	// The cap is applied to the control-stripped bytes, exactly where the
	// shell measured them: `tr` ran before `head -c` and before `wc -c`.
	const truncated = filtered.length >= CAPS.maxBytes || more;
	const content = filtered.subarray(0, CAPS.maxBytes).toString("utf8");
	emitEnvelope({
		tool: "read_file",
		ok: true,
		repo: stripControl(repoId),
		commit_sha: stripControl(commitSha),
		path: stripControl(path),
		offset,
		limit,
		truncated,
		content,
	});
}

// --- repo_info / list_tree / path_info / grep -----------------------------

/**
 * repo_info REPO
 * One mirror as a caller must pin it: the url the farm records, the tip and
 * its date, and whether this id IS the mirror or an alias beside it. It is the
 * orientation call — the tip row a Re-verify table needs — and it never
 * fetches, so a stale mirror reports the stale sha instead of silently
 * updating itself.
 * @param {string[]} argv
 * @param {string} root
 */
async function repoInfo(argv, root) {
	arity(argv, 1, "usage: repo_info REPO");
	requireFarm(root);
	const id = requireRepoId(argv[0] ?? "");
	const { path: repoPath, entry, aliasTarget } = describeEntry(root, id);
	const url = await farmGitOrNull(repoPath, [
		"config",
		"--get",
		"remote.origin.url",
	]);
	const branch = await farmGitOrNull(repoPath, [
		"symbolic-ref",
		"-q",
		"--short",
		"HEAD",
	]);
	const head = await farmGitOrNull(repoPath, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		"HEAD",
	]);
	const meta =
		head === null
			? null
			: await farmGitOrNull(repoPath, [
					"log",
					"-1",
					"--format=%cI\u001f%s",
					"--end-of-options",
					head,
				]);
	const [headDate, headSubject] =
		meta === null ? [null, null] : meta.split("\u001f");
	const refs = await farmGit(["-C", repoPath, "for-each-ref", "--format=x"]);
	emitEnvelope({
		tool: "repo_info",
		ok: true,
		repo: stripControl(id),
		entry,
		alias_target: aliasTarget === null ? null : stripControl(aliasTarget),
		url: url === null ? null : stripControl(url),
		default_branch: branch === null ? null : stripControl(branch),
		head_sha: head === null ? null : stripControl(head),
		head_date: headDate === null ? null : stripControl(headDate),
		head_subject: headSubject === null ? null : stripControl(headSubject),
		ref_count: refs.stdout.split("\n").length - 1,
	});
}

/**
 * list_tree REPO REV [PATH_GLOB] [CURSOR] [MAX]
 * One mirror's files at ONE rev — the call that replaces `git ls-tree` against
 * the mirror directory, and the only listing that can be pinned to the tip a
 * document cited after HEAD has moved. Sizes ride along because the same walk
 * has them; non-blobs report null.
 * @param {string[]} argv
 * @param {string} root
 */
async function listTree(argv, root) {
	arityBetween(
		argv,
		2,
		5,
		"usage: list_tree REPO REV [PATH_GLOB] [CURSOR] [MAX]",
	);
	requireFarm(root);
	const id = requireRepoId(argv[0] ?? "");
	const rev = requireRev(argv[1] ?? "");
	const pathGlob = requireGlob(argv[2] ?? "");
	const repoPath = resolveRepo(root, id);
	const sha = await resolveCommit(repoPath, id, rev);
	const window = beginCollect(argv[3], argv[4]);
	const pathMatches = pathGlob ? caseGlob(pathGlob) : null;
	// -z so a path with non-ASCII bytes arrives unquoted, the same reason
	// search_paths turns quotepath off.
	const tree = await farmGit([
		"-C",
		repoPath,
		"ls-tree",
		"-r",
		"-l",
		"-z",
		"--end-of-options",
		sha,
	]);
	if (tree.code !== 0) {
		refuse(5, "git ls-tree failed", {
			repo: id,
			rc: tree.code,
			detail: lastLine(tree.stderr),
		});
	}
	for (const record of tree.stdout.split("\u0000")) {
		if (!record) {
			continue;
		}
		const tab = record.indexOf("\t");
		if (tab === -1) {
			continue;
		}
		const meta = record.slice(0, tab).split(/\s+/);
		const path = record.slice(tab + 1);
		if (pathMatches && !pathMatches(path)) {
			continue;
		}
		const size = meta[3] ?? "-";
		window.collect({
			repo: stripControl(id),
			commit_sha: sha,
			path: stripControl(path),
			size: /^[0-9]+$/.test(size) ? Number(size) : null,
		});
		if (window.full()) {
			break;
		}
	}
	emitHits(
		"list_tree",
		{ commit_sha: sha, paths_matched: window.hits.length },
		window,
	);
}

/**
 * path_info REPO REV PATH
 * Whether a citation's `repo:path` target exists at that rev, and what it is.
 * Absent is an ANSWER (ok with `exists:false`), not a failure: a doc check must
 * not read "the file is gone" and "the tool broke" as the same result.
 * @param {string[]} argv
 * @param {string} root
 */
async function pathInfo(argv, root) {
	arity(argv, 3, "usage: path_info REPO REV PATH");
	requireFarm(root);
	const id = requireRepoId(argv[0] ?? "");
	const rev = requireRev(argv[1] ?? "");
	const path = requirePath(argv[2] ?? "");
	const repoPath = resolveRepo(root, id);
	const sha = await resolveCommit(repoPath, id, rev);
	const spec = `${sha}:${path}`;
	const type = await farmGitOrNull(repoPath, ["cat-file", "-t", spec]);
	const size = type === "blob" ? await farmGitOrNull(repoPath, ["cat-file", "-s", spec]) : null;
	emitEnvelope({
		tool: "path_info",
		ok: true,
		repo: stripControl(id),
		rev: stripControl(rev),
		path: stripControl(path),
		commit_sha: sha,
		exists: type !== null,
		type: type === null ? null : stripControl(type),
		size: size !== null && /^[0-9]+$/.test(size) ? Number(size) : null,
	});
}

/**
 * grep REPO REV QUERY [PATH_GLOB] [MODE] [MAX]
 * search_code's per-mirror half at a pinned rev. A citation check has to read
 * the tree the document cited, and HEAD is usually past it, so the rev is an
 * argument rather than a default.
 * @param {string[]} argv
 * @param {string} root
 */
async function grep(argv, root) {
	arityBetween(
		argv,
		3,
		6,
		"usage: grep REPO REV QUERY [PATH_GLOB] [MODE] [MAX]",
	);
	requireFarm(root);
	const id = requireRepoId(argv[0] ?? "");
	const rev = requireRev(argv[1] ?? "");
	const query = argv[2];
	if (!query) {
		refuse(2, "empty query");
	}
	const pathGlob = requireGlob(argv[3] ?? "");
	const mode = argv[4] ?? "fixed";
	if (mode !== "fixed" && mode !== "regex") {
		refuse(2, "MODE must be fixed or regex", { mode });
	}
	const repoPath = resolveRepo(root, id);
	const sha = await resolveCommit(repoPath, id, rev);
	const window = beginCollect("0", argv[5]);
	const pathMatches = pathGlob ? caseGlob(pathGlob) : null;
	const grepArgs = ["-C", repoPath, "grep", "-I", "-n", "--no-color"];
	if (mode === "fixed") {
		grepArgs.push("-F");
	}
	grepArgs.push("-e", query, "--end-of-options", sha);
	const res = await farmGit(grepArgs);
	if (res.code === 124) {
		refuse(5, "git grep timed out", { repo: id });
	}
	if (res.code !== 0 && res.code !== 1) {
		refuse(5, "git grep failed", {
			repo: id,
			rc: res.code,
			detail: lastLine(res.stderr),
		});
	}
	for (const raw of res.stdout.split("\n")) {
		if (!raw) {
			continue;
		}
		const hit = parseGrepLine(raw, sha);
		if (pathMatches && !pathMatches(hit.path)) {
			continue;
		}
		window.collect({
			repo: stripControl(id),
			path: stripControl(hit.path),
			line: hit.line,
			text: stripControl(hit.text),
		});
		if (window.full()) {
			break;
		}
	}
	emitHits("grep", { repo: stripControl(id), commit_sha: sha }, window);
}

// --- search_history -------------------------------------------------------

/**
 * search_history QUERY [REPO_GLOB] [PATH_GLOB] [SINCE] [CURSOR] [MAX]
 * d099's phase 3 (the only search whose engine is native git, not Zoekt):
 * literal pickaxe (-S) across commits, with an optional changed-paths glob and
 * a date floor. The log stream is record-separated (%x1e) with field-separated
 * (%x1f) header data so subjects and paths are never split on a character they
 * may contain.
 * @param {string[]} argv
 * @param {string} root
 */
async function searchHistory(argv, root) {
	arityBetween(
		argv,
		1,
		6,
		"usage: search_history QUERY [REPO_GLOB] [PATH_GLOB] [SINCE] [CURSOR] [MAX]",
	);
	requireFarm(root);
	const query = argv[0];
	if (!query) {
		refuse(2, "empty query");
	}
	const selected = selectRepos(root, argv[1] ?? "*");
	const pathGlob = requireGlob(argv[2] ?? "");
	let since = argv[3] ?? "";
	if (since) {
		since = requireSince(since);
	}
	const window = beginCollect(argv[4], argv[5]);
	// One past the window: a commit beyond the cap is exactly what "truncated"
	// means, so the walk asks for just enough to prove it.
	const want = window.skip + window.remaining + 1;
	const pathMatches = pathGlob ? caseGlob(pathGlob) : null;
	const rs = "\x1e";
	const us = "\x1f";
	for (const id of selected.ids) {
		const repoPath = resolveRepo(root, id);
		const sha = await farmGitOrNull(repoPath, [
			"rev-parse",
			"--verify",
			"--end-of-options",
			"HEAD",
		]);
		if (sha === null) {
			logUnreadable(id);
			continue;
		}
		const logArgs = [
			"-C",
			repoPath,
			"log",
			`--max-count=${want}`,
			`--format=${rs}%H${us}%aI${us}%s`,
			"--name-only",
			`-S${query}`,
		];
		if (since) {
			logArgs.push(`--since=${since}`);
		}
		logArgs.push("--end-of-options", "HEAD");
		const res = await farmGit(logArgs);
		if (res.code === 124) {
			refuse(5, "git log timed out", { repo: id });
		}
		if (res.code !== 0) {
			refuse(5, "git log failed", {
				repo: id,
				rc: res.code,
				detail: lastLine(res.stderr),
			});
		}
		/** @type {{sha: string, date: string, subject: string, matched: boolean}|null} */
		let open = null;
		const flush = () => {
			if (open?.matched) {
				window.collect({
					repo: stripControl(id),
					commit_sha: stripControl(open.sha),
					date: stripControl(open.date),
					subject: stripControl(open.subject),
				});
			}
		};
		for (const line of res.stdout.split("\n")) {
			if (line.startsWith(rs)) {
				// A record boundary flushes the previous commit; the line
				// carries its header fields after the marker.
				flush();
				const rest = line.slice(rs.length);
				const firstUs = rest.indexOf(us);
				const sha1 = firstUs === -1 ? rest : rest.slice(0, firstUs);
				const afterSha = firstUs === -1 ? "" : rest.slice(firstUs + us.length);
				const secondUs = afterSha.indexOf(us);
				open = {
					sha: sha1,
					date: secondUs === -1 ? afterSha : afterSha.slice(0, secondUs),
					subject: secondUs === -1 ? "" : afterSha.slice(secondUs + us.length),
					// Without a path filter every commit the pickaxe returns
					// matched; with one, a changed path must still prove it.
					matched: pathMatches === null,
				};
			} else if (open && pathMatches && line && pathMatches(line)) {
				// Every other line is a changed path of the open record.
				open.matched = true;
			}
			if (window.full()) {
				break;
			}
		}
		flush();
		if (window.full()) {
			break;
		}
	}
	emitHits("search_history", { repos_matched: selected.ids.length }, window);
}

// --- diff -----------------------------------------------------------------

/**
 * diff REPO REV_A REV_B [PATH] [MAX]
 * Unified patch between two pins, byte-capped with visible truncation. PATH is
 * a shell glob expanded AGAINST THE DIFF'S OWN NAME LIST, and the matching
 * names go back to git as literal pathspecs — the glob itself never reaches an
 * argv, and an unmatched glob yields an EMPTY patch rather than the whole repo
 * (the keep-all trap, git/tests/git-glob.test.mjs).
 * @param {string[]} argv
 * @param {string} root
 */
async function diff(argv, root) {
	arityBetween(argv, 3, 5, "usage: diff REPO REV_A REV_B [PATH] [MAX]");
	requireFarm(root);
	const repoId = requireRepoId(argv[0] ?? "");
	const repoPath = resolveRepo(root, repoId);
	const revA = requireRev(argv[1] ?? "");
	const revB = requireRev(argv[2] ?? "");
	const path = argv[3] ? requireGlob(argv[3] ?? "") : "";
	const cap = requireUint(argv[4] ?? String(CAPS.maxBytes));
	if (cap > CAPS.maxBytes) {
		refuse(2, "MAX may not exceed the server cap", {
			cap,
			server_cap: CAPS.maxBytes,
		});
	}
	const shaA = await farmGitOrNull(repoPath, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		revA,
	]);
	if (shaA === null) {
		refuse(3, "unknown rev", { rev: revA, repo: repoId });
	}
	const shaB = await farmGitOrNull(repoPath, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		revB,
	]);
	if (shaB === null) {
		refuse(3, "unknown rev", { rev: revB, repo: repoId });
	}
	/** @type {string[]} */
	let specs = [];
	if (path) {
		const names = await farmGit([
			"-C",
			repoPath,
			"diff",
			"--name-only",
			"--no-color",
			shaA,
			shaB,
		]);
		if (names.code !== 0) {
			refuse(5, "git diff --name-only failed", { repo: repoId });
		}
		const pathMatches = caseGlob(path);
		specs = names.stdout.split("\n").filter((p) => p && pathMatches(p));
		if (specs.length > CAPS.maxPaths) {
			refuse(4, "diff path glob expands past the bound — narrow it", {
				paths: specs.length,
				bound: CAPS.maxPaths,
			});
		}
		if (specs.length === 0) {
			// Zero pathspecs after `--` means NO restriction — an unmatched
			// glob must be an empty patch, never the repo.
			emitEnvelope({
				tool: "diff",
				ok: true,
				repo: stripControl(repoId),
				commit_sha_a: stripControl(shaA),
				commit_sha_b: stripControl(shaB),
				truncated: false,
				patch: "",
			});
			return;
		}
	}
	const res = await farmGit(
		[
			"-C",
			repoPath,
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			shaA,
			shaB,
			"--",
			...specs,
		],
		{ buffer: true },
	);
	// A diff of exactly cap bytes is not truncated; one byte more is. The
	// comparison is on the raw bytes, the same place `head -c $((cap + 1))`
	// measured them.
	const truncated = res.bytes.length > cap;
	const patch = stripControlBytes(res.bytes.subarray(0, cap)).toString("utf8");
	emitEnvelope({
		tool: "diff",
		ok: true,
		repo: stripControl(repoId),
		commit_sha_a: stripControl(shaA),
		commit_sha_b: stripControl(shaB),
		truncated,
		patch,
	});
}

// --- maintenance tools ----------------------------------------------------

/**
 * Run an operator script as the child that mutates the farm, with its stdout
 * folded into OUR stderr: stdout stays a single JSON object (docs/d045), and
 * the human-readable progress the operator expects still reaches the terminal.
 * @param {string} script
 * @param {string[]} args
 * @returns {number} the child's exit status (1 when it died on a signal)
 */
function runChild(script, args) {
	const res = spawnSync(script, args, { stdio: ["ignore", 2, 2] });
	return res.status ?? 1;
}

/**
 * upsert_repo URL
 * d099's write tool: a bare mirror of URL under the farm. The wrapper is the
 * thin part BY DESIGN — forge-mirror.mjs owns URL validation (the safety
 * boundary: d099's decision to reuse it rather than fork it) and the
 * acquisition script owns the flock. Serialized with the other verbs because
 * -forge-mirror.sh takes the same lock maintain.sh does.
 * @param {string[]} argv
 */
async function upsertRepo(argv) {
	if (argv.length !== 1) {
		refuse(2, "usage: upsert_repo URL");
	}
	const url = argv[0];
	if (!url) {
		refuse(2, "empty url");
	}
	// Option-shaped argv is rejected HERE: a bare `-h` would make the child
	// print help and exit 0, which would read as success. URL SHAPE stays
	// forge-mirror.mjs's rule — one validator, not two.
	if (url.startsWith("-")) {
		refuse(2, "invalid url (leading -)", { url });
	}
	const lock = farmMutationLockPath();
	// Written BEFORE the child blocks on flock, so "queued" is visible too.
	writeLockStatus(lock, { tool: TOOL, detail: `upsert_repo ${url}` });
	let child = 0;
	try {
		child = runChild(join(DIR, "-forge-mirror.sh"), [url]);
	} finally {
		clearLockStatus(lock);
	}
	if (child !== 0) {
		refuse(1, "acquisition failed (see the stderr log)", {
			url,
			child_exit: child,
		});
	}
	emitEnvelope({ tool: "upsert_repo", ok: true, url: stripControl(url) });
}

/**
 * compact_repo REPO [MODE=optimize|deep]
 * d099's second verb: the same maintain-mirrors.mjs the operator cron runs,
 * narrowed to one repo by --only and pinned to a single mutation at a time via
 * the farm lock. --no-fetch keeps compaction pure housekeeping — the verb may
 * never pull new data (that is upsert_repo's job).
 * @param {string[]} argv
 * @param {string} root
 */
async function compactRepo(argv, root) {
	arityBetween(argv, 1, 2, "usage: compact_repo REPO [MODE=optimize|deep]");
	requireFarm(root);
	const repoId = requireRepoId(argv[0] ?? "");
	resolveRepo(root, repoId);
	const mode = argv[1] ?? "optimize";
	if (mode !== "optimize" && mode !== "deep") {
		refuse(2, "MODE must be optimize or deep", { mode });
	}
	const lock = farmMutationLockPath();
	writeLockStatus(lock, {
		tool: TOOL,
		detail: `compact_repo ${repoId} mode=${mode}`,
	});
	let child = 0;
	try {
		const args = ["--root", root, "--only", `${repoId}.git`, "--no-fetch"];
		if (mode === "deep") {
			args.push("--deep-optimize");
		}
		child = runChild(join(DIR, "maintain.sh"), args);
	} finally {
		clearLockStatus(lock);
	}
	if (child !== 0) {
		refuse(1, "compaction failed (see the stderr log)", {
			repo: repoId,
			child_exit: child,
		});
	}
	emitEnvelope({
		tool: "compact_repo",
		ok: true,
		repo: stripControl(repoId),
		mode,
	});
}

/**
 * maintenance_status
 * What holds the mutation mutex and since when (d099). The probe is the TRUTH
 * — it asks flock directly instead of trusting a file's existence
 * (lib/farm-lock.mjs) — and the status file beside the lock is only the
 * holder's own description, deliberately OUTSIDE the farm so reads stay
 * byte-identical.
 * @param {string[]} argv
 */
async function maintenanceStatus(argv) {
	if (argv.length > 0) {
		refuse(2, "usage: maintenance_status");
	}
	const lock = farmMutationLockPath();
	const state = probeFarmMutationLock(lock);
	if (state === "unknown") {
		// Without flock(1) there is no mutex — unknown is more honest than
		// inferring one from a file's existence.
		logWarn("flock missing — lock state unknown");
	}
	const locked = state === "unknown" ? null : state === "held";
	emitEnvelope({
		tool: "maintenance_status",
		ok: true,
		lock_path: stripControl(lock),
		locked,
		holder: locked === true ? readLockHolder(lock) : null,
	});
}

// --- dispatch -------------------------------------------------------------

/**
 * Usage names the SHIM, not this file: telling a caller to run the .mjs would
 * send them around the node-version pin the shim exists to apply.
 */
const USAGE = `usage: ./node-run.sh git/farm-tool.mjs TOOL [ARGS...]

d099's reference-farm tool surface as a POSIX CLI: positional argv, one
JSON object on stdout, structured logs on stderr. The later stdio MCP
server wraps this same entry verbatim, so the safety posture lives in one
place (git/lib/farm-posture.mjs).

read tools (capped, read-only by construction):
  list_repos     [FILTER] [CURSOR] [MAX]
  list_refs      REPO [CURSOR] [MAX]
  search_code    QUERY [REPO_GLOB] [PATH_GLOB] [MODE] [MAX] [CURSOR] [WIDE]
  search_paths   PATH_GLOB [REPO_GLOB] [CURSOR] [MAX]
  read_file      REPO REV PATH [OFFSET] [LIMIT]
  search_history QUERY [REPO_GLOB] [PATH_GLOB] [SINCE] [CURSOR] [MAX]
  diff           REPO REV_A REV_B [PATH] [MAX]
  repo_info      REPO
  list_tree      REPO REV [PATH_GLOB] [CURSOR] [MAX]
  path_info      REPO REV PATH
  grep           REPO REV QUERY [PATH_GLOB] [MODE] [MAX]

maintenance tools (farm-wide mutation lock, git/farm-lock.sh):
  upsert_repo        URL
  compact_repo       REPO [MODE=optimize|deep]
  maintenance_status

MODE is fixed (default) or regex; globs are shell case-globs (* and ? only);
REPO ids are farm-relative mirror paths with .git stripped (see list_repos).
exit: 0 ok · 1 tool failed · 2 usage · 3 not found · 4 refused · 5 git failed
`;

/** @type {Record<string, (argv: string[], root: string) => Promise<void>>} */
const VERBS = {
	list_repos: listRepos,
	list_refs: listRefs,
	search_code: searchCode,
	search_paths: searchPaths,
	read_file: readFile,
	search_history: searchHistory,
	diff,
	repo_info: repoInfo,
	list_tree: listTree,
	path_info: pathInfo,
	grep,
	upsert_repo: upsertRepo,
	compact_repo: compactRepo,
	maintenance_status: maintenanceStatus,
};

/**
 * @param {string[]} argv
 */
async function main(argv) {
	if (argv.length === 0) {
		process.stderr.write(USAGE);
		process.exitCode = 2;
		return;
	}
	currentTool = argv[0] ?? "";
	if (currentTool === "-h" || currentTool === "--help" || currentTool === "help") {
		process.stdout.write(USAGE);
		return;
	}
	const verb = VERBS[currentTool];
	if (!verb) {
		refuse(2, "unknown tool (try --help)", { name: currentTool });
	}
	initScratch();
	await verb(argv.slice(1), farmRoot());
}

main(process.argv.slice(2)).catch((err) => {
	if (err instanceof FarmError) {
		// The one failure shape: the payload on stdout (a machine caller never
		// parses logs), the same fact as a structured log on stderr (d045), and
		// d099's exit code. `call`, not `tool`: the logger already stamps every
		// line with the tool name, and a second key would duplicate it.
		//
		// Field values are STRINGS here, exactly as the shell emitted them
		// (`"cap":"262144"`, not `"cap":262144`): this envelope's shape is
		// frozen so a caller's parse does not change under the port, and the
		// typed version belongs with the MCP façade, which will own a schema
		// (docs/d121).
		const fields = Object.fromEntries(
			Object.entries(err.fields).map(([k, v]) => [k, stripControl(String(v))]),
		);
		emitEnvelope({
			tool: currentTool,
			ok: false,
			error: err.message,
			...fields,
		});
		logError(err.message, { call: currentTool, ...fields });
		process.exit(err.code);
	}
	logError("tool aborted", { error: err });
	process.exit(1);
});
