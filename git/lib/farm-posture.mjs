/**
 * @fileoverview farm-posture.mjs — d099's safety posture for the reference
 * farm, in ONE place, so no tool in this folder can re-decide it. This is the
 * node half of what `farm-tool-lib.sh` was; `farm-tool.mjs` keeps the verbs.
 *
 * Everything d099 makes load-bearing lives here:
 *
 *   - git spawns argv-only under a scrubbed environment: empty HOME,
 *     GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL cut every config source except
 *     the mirror's own, so no repo config can name a pager/textconv/driver to
 *     execute (d099's "the server must be unable to run code named inside the
 *     data it searches").
 *   - revs/paths/globs are allowlist-validated BEFORE they reach an argv, and
 *     every read spawn sits behind `--literal-pathspecs` (plus
 *     `--end-of-options` where operands follow options) — an option-shaped
 *     payload is inert by construction.
 *   - every output axis carries a cap, and capping is VISIBLE (`truncated` +
 *     `cursor`), never silent (d099's result contract).
 *   - repo bytes reach stdout only as JSON-escaped data — never as
 *     instructions (d045's posture).
 *
 * A refusal is a `FarmError` carrying d099's exit code and the fields the
 * envelope reports; `farm-tool.mjs` turns it into the one failure shape at the
 * top level. Nothing here writes to stdout, so a verb that throws has emitted
 * no partial payload.
 */

import { execFile, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";

import { caseGlob, findBareMirrors } from "./git-core.mjs";

/**
 * Caps, not environment knobs: d060's rule (a run IS what its argv says) and
 * d099's "bounded on every axis" — the MCP layer surfaces these as tool-schema
 * defaults, never as env state.
 */
export const CAPS = Object.freeze({
	/** seconds per read-side git call; a hung git must not wedge the run */
	deadline: 60,
	/** default matches/refs/paths/commits per response */
	maxResults: 200,
	/** bytes of git payload folded into one response */
	maxBytes: 262_144,
	/** live-grep fan-out bound (d099's rung-1 ladder) */
	grepRepos: 64,
	/** diff pathspec expansion bound */
	maxPaths: 256,
	/** default read_file chunk, lines */
	readLines: 200,
});

/**
 * The farm's nesting limit for discovery — the same rule the shell's
 * `find -maxdepth 6` used (the root is depth 0), expressed through the shared
 * walk. Deeper than git-core's generic default, because a reference farm nests
 * `host/owner/group/repo.git` (docs/d121).
 */
const FARM_MAX_DEPTH = 6;

/** One refusal: d099's exit code plus the fields the envelope carries. */
export class FarmError extends Error {
	/**
	 * @param {number} code 2 usage · 3 not found · 4 refused · 5 git failed
	 * @param {string} message
	 * @param {Record<string, unknown>} [fields]
	 */
	constructor(code, message, fields = {}) {
		super(message);
		this.name = "FarmError";
		this.code = code;
		this.fields = fields;
	}
}

/**
 * A verb's refusal is a THROW, not an exit: the shell's `fg_error` exited from
 * an arbitrary depth, which in node would mean printing half an envelope
 * first. The entry catches this one type and prints the failure shape.
 * @param {number} code
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 * @returns {never}
 */
export function refuse(code, message, fields = {}) {
	throw new FarmError(code, message, fields);
}

// --- the payload envelope -------------------------------------------------

/**
 * C0 control characters other than tab/newline cannot appear in a JSON string
 * anyway; the shell dropped them with `tr` so a binary blob could still be
 * reported as text. Kept identical, because read_file's byte accounting is
 * downstream of it.
 * @param {string} s
 * @returns {string}
 */
export function stripControl(s) {
	// Dropping these exact bytes IS the contract with the shell's `tr`: the rule's
	// usual hazard (an accidental control character in a pattern) is the point.
	// oxlint's disable rides the code line (trailing) so neither tool's
	// directive sits between the other's and the regex it covers.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the C0 range is the target
	return s.replace(/[\u0000-\u0008\u000b-\u001f]/g, ""); // eslint-disable-line no-control-regex — matching these bytes IS the contract with the shell's `tr`
}

/**
 * The same drop, on raw bytes, for the paths that must count bytes before they
 * decode (read_file's chunk, diff's patch): the shell measured `wc -c` AFTER
 * `tr`, so filtering first and decoding second is what keeps the two runs'
 * truncation flags equal.
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
export function stripControlBytes(bytes) {
	/** @type {number[]} */
	const kept = [];
	for (const byte of bytes) {
		if (byte <= 0x08 || (byte >= 0x0b && byte <= 0x1f)) {
			continue;
		}
		kept.push(byte);
	}
	return Buffer.from(kept);
}

/**
 * The one machine payload: a single JSON object on stdout (docs/d045 — logs go
 * to stderr, so a caller never parses prose off the payload stream).
 * @param {Record<string, unknown>} envelope
 */
export function emitEnvelope(envelope) {
	process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * The shared success envelope around a collect window: the accumulated
 * objects, `total` = how many objects THIS response carries, the truncated
 * flag, and whatever facts the window cannot report (the full farm count).
 * @param {string} tool
 * @param {Record<string, unknown>} extra members inserted before `total`
 * @param {CollectWindow} window
 */
export function emitHits(tool, extra, window) {
	emitEnvelope({
		tool,
		ok: true,
		...extra,
		total: window.hits.length,
		truncated: window.truncated,
		results: window.hits,
	});
}

// --- scratch HOME ---------------------------------------------------------

/** @type {string[]} */
const scratchDirs = [];
let scratchHome = "";
let scratchTmpDir = "";

/**
 * The load-bearing scrub: git probes HOME, so it must exist as a directory,
 * and it must be THIS process's so it dies with the run. Called once by the
 * entry, before the first spawn.
 */
export function initScratch() {
	scratchHome = mkdtempSync(join(tmpdir(), "farm-home-"));
	scratchTmpDir = mkdtempSync(join(tmpdir(), "farm-tmp-"));
	scratchDirs.push(scratchHome, scratchTmpDir);
	// One hook, so a refusal thrown from any depth still cleans up.
	process.on("exit", () => {
		for (const dir of scratchDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

/** @returns {string} the run's temp dir (verbs never make their own). */
export function scratchTmp() {
	return scratchTmpDir;
}

// --- the farm root --------------------------------------------------------

/**
 * The farm this run operates on. It is host state — the same fact
 * git-core.mjs's DEFAULT_ROOT reads as REFERENCES_ROOT — so the env override
 * name is shared with the node side, and the fallback re-derives the
 * xdg-DOWNLOAD + /references path `-forge-mirror.sh` writes by default.
 * @param {{ env?: Record<string, string|undefined> }} [o]
 * @returns {string}
 */
export function farmRoot({ env = process.env } = {}) {
	if (env.REFERENCES_ROOT) {
		return env.REFERENCES_ROOT;
	}
	const xdg = spawnSync("xdg-user-dir", ["DOWNLOAD"], { encoding: "utf8" });
	let dir = xdg.error || xdg.status !== 0 ? "" : xdg.stdout.trim();
	const home = env.HOME ?? homedir();
	if (dir === home) {
		dir = "";
	}
	return `${dir || `${home}/Downloads`}/references`;
}

// --- git choke point ------------------------------------------------------

/**
 * The ONLY way a read tool spawns git. Argv-only (no shell string ever),
 * scrubbed env, `--no-pager` (the caller's PAGER must not page a captured
 * stream), `-c core.fsmonitor=false` (a repo-configured fsmonitor hook is an
 * execution primitive), `--literal-pathspecs` (repo content must not conjure
 * pathspec magic), and a per-call deadline — a hung git must not wedge the run
 * (docs/d099).
 * @param {string[]} args git args AFTER the global options
 * @param {{ buffer?: boolean }} [o] buffer reads a blob/patch byte-exactly
 * @returns {Promise<{ code: number, stdout: string, stderr: string,
 *   bytes: Buffer }>} `stdout` is "" in buffer mode; `bytes` is always set
 */
export function farmGit(args, { buffer = false } = {}) {
	return new Promise((resolve) => {
		execFile(
			"git",
			["--no-pager", "-c", "core.fsmonitor=false", "--literal-pathspecs", ...args],
			{
				env: {
					...process.env,
					HOME: scratchHome,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_OPTIONAL_LOCKS: "0",
					GIT_TERMINAL_PROMPT: "0",
					GIT_PAGER: "cat",
					GIT_ASKPASS: "/usr/bin/false",
				},
				encoding: buffer ? "buffer" : "utf8",
				maxBuffer: 256 * 1024 * 1024,
				timeout: CAPS.deadline * 1000,
			},
			(err, stdout, stderr) => {
				const out = /** @type {Buffer|string} */ (stdout ?? "");
				const bytes = Buffer.isBuffer(out) ? out : Buffer.from(out, "utf8");
				const text = Buffer.isBuffer(out) ? "" : out;
				const errtext = Buffer.isBuffer(stderr)
					? /** @type {Buffer} */ (stderr).toString("utf8")
					: String(stderr ?? "");
				if (!err) {
					resolve({ code: 0, stdout: text, stderr: errtext, bytes });
					return;
				}
				// `timeout(1)`'s 124 is the shell's own spelling for "killed by
				// the deadline", and the grep/log verbs branch on it.
				const raw = /** @type {any} */ (err).code;
				const code = err.signal
					? 124
					: typeof raw === "number"
						? raw
						: 1;
				resolve({ code, stdout: text, stderr: errtext, bytes });
			},
		);
	});
}

/**
 * One `git -C repo …` whose stdout is wanted as trimmed text, or null when the
 * probe fails (an absent ref, an absent remote) — the shell's `if x=$(...)`.
 * @param {string} repoPath
 * @param {string[]} args
 * @returns {Promise<string|null>}
 */
export async function farmGitOrNull(repoPath, args) {
	const res = await farmGit(["-C", repoPath, ...args]);
	return res.code === 0 ? res.stdout.replace(/\n+$/, "") : null;
}

// --- the blob line window -------------------------------------------------

/**
 * The k-th (1-based) line's byte range in a blob. A blob's last line may carry
 * no trailing newline, and a chunk must round-trip byte-exactly, so the window
 * is expressed as byte offsets and sliced from the raw buffer — the shell's
 * `sed -n` piped through `head -c`.
 *
 * It lives beside the cap rules rather than in the verb because the two are one
 * decision: `read_file` counts bytes BEFORE control-stripping, so a window and a
 * cap reasoned about separately could disagree with the shell at a boundary.
 * @param {Buffer} bytes
 * @param {number} offset 1-based first line
 * @param {number} limit lines
 * @returns {{ chunk: Buffer, more: boolean }} `more` = a further NON-EMPTY line
 *   exists past the window (the shell tested one byte of it; a blank line
 *   therefore read as "nothing more", and that spelling is kept)
 */
export function blobLineWindow(bytes, offset, limit) {
	/** @type {number[]} */
	const starts = [0];
	for (let i = 0; i < bytes.length; i += 1) {
		if (bytes[i] === 0x0a) {
			starts.push(i + 1);
		}
	}
	// A trailing newline opens no new line: `printf 'a\n'` is one line.
	if (starts.length > 1 && starts.at(-1) === bytes.length) {
		starts.pop();
	}
	const lineCount = starts.length;
	if (offset > lineCount) {
		return { chunk: Buffer.alloc(0), more: false };
	}
	const from = /** @type {number} */ (starts[offset - 1]);
	const to =
		offset - 1 + limit < lineCount
			? /** @type {number} */ (starts[offset - 1 + limit])
			: bytes.length;
	const chunk = bytes.subarray(from, Math.min(to, bytes.length));
	const nextIndex = offset - 1 + limit;
	if (nextIndex >= lineCount) {
		return { chunk, more: false };
	}
	const nextEnd =
		nextIndex + 1 < lineCount
			? /** @type {number} */ (starts[nextIndex + 1])
			: bytes.length;
	// The next line's own terminator is not content: the shell read ONE byte of
	// it, which is empty for a blank line and for a line that is only its
	// newline.
	const terminated = bytes[nextEnd - 1] === 0x0a ? 1 : 0;
	const nextLength =
		nextEnd - /** @type {number} */ (starts[nextIndex]) - terminated;
	return { chunk, more: nextLength > 0 };
}

// --- validation -----------------------------------------------------------

/**
 * Validators are allowlists, and each returns its value instead of setting a
 * global: an option-shaped or traversal-shaped payload can never reach an
 * argv, and a caller cannot forget which variable holds the checked form.
 */

/**
 * @param {string} value
 * @returns {number} a non-negative integer — these become line ranges, page
 *   arithmetic and `--max-count` values
 */
export function requireUint(value) {
	if (!/^[0-9]+$/.test(value)) {
		refuse(2, "expected a non-negative integer", { value });
	}
	return Number(value);
}

/**
 * A farm-relative mirror path with `.git` stripped (d099's identifier).
 * Rejections all mean "could name something outside one mirror": traversal,
 * absolute paths, option-shaped ids — plus glob metacharacters, because
 * `compact_repo`'s `--only` glob must select EXACTLY this repo (a
 * forge-derived id never carries them).
 * @param {string} value
 * @returns {string}
 */
export function requireRepoId(value) {
	if (
		value === "" ||
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.includes("..") ||
		value.includes(" ") ||
		value.includes("\\") ||
		value.includes(":")
	) {
		refuse(2, "invalid repo id", { id: value });
	}
	if (/[[\]*?]/.test(value)) {
		refuse(2, "invalid repo id (glob metacharacter)", { id: value });
	}
	return value;
}

/**
 * A single tree-ish: no leading `-` (the `--upload-pack=` as a rev injection)
 * and nothing outside the refspec/SHA alphabet, so nothing option-shaped or
 * shell-shaped survives to argv. A composed `rev:path` spec is built only from
 * a validated rev and a validated path, so the colon split is unambiguous.
 * @param {string} value
 * @returns {string}
 */
export function requireRev(value) {
	if (value === "" || value.startsWith("-") || /[^A-Za-z0-9._/@{}^~-]/.test(value)) {
		refuse(2, "invalid rev", { rev: value });
	}
	return value;
}

/**
 * A repo-relative path for read_file: the repo id's traversal rules plus `:`
 * (it would split a rev:path spec).
 * @param {string} value
 * @returns {string}
 */
export function requirePath(value) {
	if (
		value === "" ||
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.includes("..") ||
		value.includes(":")
	) {
		refuse(2, "invalid path", { path: value });
	}
	return value;
}

/**
 * A shell case-glob for repo/path filters, allowlisted so a pattern can never
 * be option-shaped, and `[`/`]` excluded (they would let a caller match MORE
 * than they can see — `*` and `?` are the documented operators). Empty is
 * legal and means "no filter" for path globs; callers default repo globs to
 * `*` themselves.
 * @param {string} value
 * @returns {string}
 */
export function requireGlob(value) {
	if (value.startsWith("-")) {
		refuse(2, "invalid glob (leading -)", { glob: value });
	}
	if (/[^A-Za-z0-9._*?/@+~ -]/.test(value)) {
		refuse(2, "invalid glob (allowlist)", { glob: value });
	}
	return value;
}

/**
 * git `--since` date text: allowlisted, and always passed as ONE argv already
 * prefixed `--since=` so it can never be mistaken for an option.
 * @param {string} value
 * @returns {string}
 */
export function requireSince(value) {
	if (value === "" || value.startsWith("-") || /[^A-Za-z0-9:._+ -]/.test(value)) {
		refuse(2, "invalid since value", { since: value });
	}
	return value;
}

// --- farm discovery / resolution ------------------------------------------

/**
 * The farm root must exist before anything scans it.
 * @param {string} root
 */
export function requireFarm(root) {
	if (!isDirectory(root)) {
		refuse(3, "farm root not found", { root });
	}
}

/** @param {string} path */
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Every mirror id in the farm, sorted. Discovery is git-core's structural rule
 * (a bare mirror directly containing HEAD + objects + refs) restricted to
 * `*.git` directories — the farm's own naming — instead of a second copy of a
 * `find` pipeline; `git/tests/git-farm-posture.test.mjs` pins that the two
 * agree on a fixture farm.
 *
 * Two rules the shell's `find` spelled as flags stay explicit here: depth 6
 * (see FARM_MAX_DEPTH) and `-mindepth 2` — a farm mirror always sits under the
 * owner/group that names it, so a stray top-level `x.git` is not a farm member
 * and must not appear as an id.
 *
 * Sorted, where the shell's `find` order was the filesystem's: a cursor is only
 * a promise if the sequence behind it is stable across calls (docs/d121).
 * @param {string} root
 * @returns {string[]}
 */
export function listRepoIds(root) {
	return findBareMirrors(root, FARM_MAX_DEPTH)
		.filter((dir) => basename(dir).endsWith(".git"))
		.map((dir) => relative(root, dir).split(sep).join("/").replace(/\.git$/, ""))
		.filter((id) => id.includes("/"))
		.sort();
}

/**
 * A mirror's path in the farm, or a refusal when it is absent — so a verb
 * never builds a path it has not checked.
 * @param {string} root
 * @param {string} id
 * @returns {string}
 */
export function resolveRepo(root, id) {
	const repoId = requireRepoId(id);
	const path = join(root, `${repoId}.git`);
	if (!existsAsMirror(path)) {
		refuse(3, "no such mirror in the farm", { repo: repoId, root });
	}
	return path;
}

/** @param {string} path */
function existsAsMirror(path) {
	try {
		return statSync(join(path, "HEAD")).isFile();
	} catch {
		return false;
	}
}

/**
 * A mirror id as stored, plus whether the entry at that path IS the mirror or a
 * symlink to another one (docs/d158). Aliases keep a name a document or an
 * upstream used to have resolvable without a lookup table a caller must read
 * first; they are deliberately not farm members, so no sweep counts one mirror
 * twice.
 * @param {string} root
 * @param {string} id
 * @returns {{ path: string, entry: "mirror"|"alias", aliasTarget: string|null }}
 */
export function describeEntry(root, id) {
	const path = resolveRepo(root, id);
	try {
		if (!lstatSync(path).isSymbolicLink()) {
			return { path, entry: "mirror", aliasTarget: null };
		}
		const real = realpathSync(path);
		const rel = relative(root, real);
		if (rel.startsWith("..")) {
			// A link out of the farm is not an alias of a farm mirror; report it as
			// an entry with no farm target rather than inventing one.
			return { path, entry: "alias", aliasTarget: null };
		}
		return {
			path,
			entry: "alias",
			aliasTarget: rel.split(sep).join("/").replace(/\.git$/, ""),
		};
	} catch {
		return { path, entry: "mirror", aliasTarget: null };
	}
}

/**
 * The fan-out a verb scans, read in one place so `matches` and the scan cannot
 * disagree: the caller's pattern (default `*`) selects from the farm's ids.
 * @param {string} root
 * @param {string} [pattern]
 * @returns {{ glob: string, ids: string[] }}
 */
export function selectRepos(root, pattern = "*") {
	const glob = requireGlob(pattern);
	const matcher = caseGlob(glob);
	const ids = listRepoIds(root).filter((id) => matcher(id));
	// Discovery walks past symlinks, so the name a doc cites (an alias beside
	// the mirror it points at) matches nothing and the verb answers "no
	// matches" instead of the mirror behind it. Only an EXACT id qualifies: a
	// pattern that matches nothing stays empty, or a wildcard would resolve to
	// whatever happened to exist.
	if (
		ids.length === 0 &&
		!/[*?]/.test(glob) &&
		!glob.startsWith("/") &&
		!glob.includes("..") &&
		existsAsMirror(join(root, `${glob}.git`))
	) {
		ids.push(glob);
	}
	return { glob, ids };
}

// --- capped collection state ----------------------------------------------

/**
 * The cursor/cap trio every listing tool shares: `skip` counts down the
 * caller's cursor, `remaining` what may still be appended, `truncated` flips
 * the moment one more result existed. ONE model, so every response's
 * truncated/cursor pair means the same thing (docs/d099).
 */
export class CollectWindow {
	/**
	 * @param {number} cursor
	 * @param {number} max
	 */
	constructor(cursor, max) {
		this.skip = cursor;
		this.remaining = max;
		/**
		 * A cursor skip is NOT truncation: the caller chose to pass those
		 * results (it knows they exist). Truncated means the window refused
		 * something the caller never saw.
		 */
		this.truncated = false;
		/** @type {unknown[]} */
		this.hits = [];
	}

	/** @param {unknown} hit */
	collect(hit) {
		if (this.skip > 0) {
			this.skip -= 1;
			return;
		}
		if (this.remaining === 0) {
			this.truncated = true;
			return;
		}
		this.remaining -= 1;
		this.hits.push(hit);
	}

	/** @returns {boolean} true once the window has refused something */
	full() {
		return this.remaining === 0 && this.truncated;
	}
}
