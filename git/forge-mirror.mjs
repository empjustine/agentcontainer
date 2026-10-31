/**
 * @fileoverview forge-mirror.mjs — the ONE hand-run acquisition tool for both
 * reference farms. It replaces three host-specific predecessors, one per
 * failure they were born from:
 *
 *   - `-github-clone.sh` hardcoded github.com and wrote non-bare clones into
 *     the legacy `references/github/` layout — the shape the farm migrated
 *     away from (git/non-bare-issues.md).
 *   - `-software-forge-mirror.sh`/`software-forge-mirror.mjs` existed because
 *     the work tenant's URLs are not `host/owner/repo` at all (docs/d044).
 *     Their one genuine difference — the IDENTITY-keyed layout — is now a
 *     branch here, decided by `parseSoftwareForgeRemote()` in
 *     `software-forge-remotes.mjs`, which stays the single home of the three
 *     URL shapes.
 *
 * Two layouts, one per URL shape:
 *
 *   public forge (https only)      <dest>/<host>/<path>.git
 *   software-forge tenant          <dest>/<org>/<project>/<repo>.git
 *
 * Everything else is the shared contract both predecessors promised:
 * idempotent (an existing mirror gets `remote update --prune`), bare mirrors
 * only, non-interactive (docs/d075 env via git-lib's spawn choke point), and
 * a half-written mirror is removed rather than left to be mistaken for a good
 * one. This is also the script d099's `upsert_repo` wraps — its URL
 * validation IS the MCP maintenance surface's safety boundary, so the checks
 * below are load-bearing, not courtesy.
 *
 * Usage:
 *   ./git/-forge-mirror.sh <https-url|software-forge-url|clone-dir>... [--dest DIR]
 *                          [--transport ssh|https]
 *
 *   --dest DIR       mirror root (default: $WORK_MIRRORS, else the xdg
 *                    DOWNLOAD dir + /references — the home farm's path).
 *                    No hard-coded operator path (docs/d044).
 *   --transport      software-forge remotes only: rebuild the canonical ssh
 *                    or https spelling before cloning (https survives an IDCS
 *                    identity rotation, ssh needs no token — docs/d044).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	git,
	logError,
	logInfo,
	logWarn,
	originUrl,
	setLogTool,
} from "./git-lib.mjs";
import {
	parseSoftwareForgeRemote,
	softwareForgeGlassUrl,
	softwareForgeHttpsUrl,
	softwareForgeMirrorRelPath,
	softwareForgeSshUrl,
} from "./software-forge-remotes.mjs";

setLogTool("git/forge-mirror");

/**
 * Where mirrors go when `--dest` is not given. `$WORK_MIRRORS` is the one
 * env read (docs/d044): the work farm's root is host state no flag can
 * default portably; the home farm falls back to the same xdg-DOWNLOAD
 * resolution the deleted `-forge-mirror.sh` used.
 * @type {string}
 */
export const DEFAULT_DEST =
	process.env.WORK_MIRRORS ?? join(downloadsDir(), "references");

/**
 * The user's download dir, resolved the way the deleted `-forge-mirror.sh`
 * resolved it — the home farm has always lived under it: xdg's answer when
 * the helper exists and names a real directory, else `$HOME/Downloads`.
 * @returns {string}
 */
function downloadsDir() {
	try {
		const dir = execFileSync("xdg-user-dir", ["DOWNLOAD"], {
			encoding: "utf-8",
		}).trim();
		if (dir && dir !== homedir() && existsSync(dir)) {
			return dir;
		}
	} catch {
		// no xdg helper — the fallback below is the answer
	}
	return join(homedir(), "Downloads");
}

/**
 * @typedef {object} Options
 * @property {string} dest
 * @property {"ssh"|"https"|null} transport
 * @property {boolean} help
 * @property {string[]} inputs
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
	/** @type {Options} */
	const o = { dest: DEFAULT_DEST, transport: null, help: false, inputs: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		// The loop condition guarantees a value; the check is the type gate's
		// form of that fact.
		if (a === undefined) {
			break;
		}
		switch (a) {
			case "--dest":
				o.dest = /** @type {string} */ (argv[++i]);
				break;
			case "--transport": {
				const value = /** @type {string} */ (argv[++i]);
				if (value !== "ssh" && value !== "https") {
					throw Object.assign(new Error("--transport must be ssh or https"), {
						value,
					});
				}
				o.transport = value;
				break;
			}
			case "-h":
			case "--help":
				o.help = true;
				break;
			default:
				// Anything flag-shaped is rejected rather than guessed at: this
				// script is d099's upsert_repo boundary, and an option-shaped URL
				// must die here, never in git's argv.
				if (a.startsWith("-")) {
					throw Object.assign(new Error("unknown flag (try --help)"), {
						flag: a,
					});
				}
				o.inputs.push(a);
		}
	}
	return o;
}

/**
 * Validate a public-forge https URL down to its farm-relative directory.
 * The checks are deliberately stricter than URL parsing alone: https-only,
 * a dot-bearing domain, at least `owner/repo`, no empty/`.`/`..` segments,
 * no query/fragment/space, and no embedded credentials (the old sh script
 * silently turned `user@host` into a DIRECTORY name — a userinfo URL is
 * either a software-forge remote, handled by that branch, or a mistake).
 * @param {string} raw
 * @returns {{ host: string, rel: string }|null} null = reject, with the
 * reason logged by the caller's shape
 */
function parsePublicForgeUrl(raw) {
	/** @type {URL} */
	let url;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") {
		return null;
	}
	if (url.username || url.password) {
		return null;
	}
	if (url.search || url.hash) {
		return null;
	}
	const host = url.hostname.toLowerCase();
	if (!host.includes(".")) {
		return null;
	}

	// The pathname after URL parsing is already backslash-normalized and
	// percent-preserving; keep it raw so a `%2E%2E` cannot be decoded into a
	// traversal after the segment checks below.
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 2) {
		return null;
	}
	for (const seg of segments) {
		if (seg === "." || seg === "..") {
			return null;
		}
		if (/[\s?#\\]/.test(seg)) {
			return null;
		}
	}
	// `?? ""` exists only to satisfy the optional-element type; the real
	// rejection is the guard after the `.git` strip (a final segment of
	// ".git" alone leaves nothing to identify a repo by).
	let last = segments.at(-1) ?? "";
	if (last.endsWith(".git")) {
		last = last.slice(0, -".git".length);
	}
	if (!last) {
		return null;
	}
	segments[segments.length - 1] = last;
	return { host, rel: `${host}/${segments.join("/")}.git` };
}

/**
 * A directory input contributes the URL of its origin (the common case when
 * a repo already exists as a clone); anything else is treated as a URL.
 * @param {string} input
 * @returns {Promise<string>}
 */
async function resolveInputToUrl(input) {
	if (existsSync(`${input}/.git`)) {
		const url = await originUrl(input);
		if (!url) {
			throw Object.assign(new Error("clone has no remote.origin.url"), {
				input,
			});
		}
		return url;
	}
	return input;
}

/**
 * @param {string} input
 * @param {Options} o
 * @returns {Promise<void>}
 */
async function mirrorOne(input, o) {
	const url = await resolveInputToUrl(input);
	const softwareForge = parseSoftwareForgeRemote(url);

	/** @type {string} */
	let fetchUrl;
	/** @type {string} */
	let rel;
	if (softwareForge) {
		if (o.transport && softwareForge.kind === "glass") {
			throw Object.assign(
				new Error("--transport needs a fetch URL, not a glass link"),
				{ input },
			);
		}
		// A glass link carries only the human slug; nothing can be cloned
		// without the numeric project id the ssh/https spellings carry.
		if (!softwareForge.projectId) {
			throw Object.assign(
				new Error(
					"glass URL has no project id — pass the ssh or https fetch URL",
				),
				{ input, glass: softwareForgeGlassUrl(softwareForge) ?? "" },
			);
		}
		rel = softwareForgeMirrorRelPath(softwareForge);
		if (o.transport === "https") {
			fetchUrl = softwareForgeHttpsUrl(softwareForge) ?? url;
		} else if (o.transport === "ssh") {
			fetchUrl = softwareForgeSshUrl(softwareForge) ?? url;
		} else {
			fetchUrl = url;
		}
	} else {
		if (o.transport) {
			throw Object.assign(
				new Error("--transport applies only to software-forge remotes"),
				{ input },
			);
		}
		const parsed = parsePublicForgeUrl(url);
		if (!parsed) {
			throw Object.assign(
				new Error(
					"not a software-forge remote and not an https forge URL " +
						"(https, host/owner/repo shape, no userinfo/query/fragment)",
				),
				{ input, origin: url },
			);
		}
		rel = parsed.rel;
		fetchUrl = url;
	}

	const target = `${o.dest}/${rel}`;
	if (existsSync(target)) {
		const r = await git(target, ["remote", "update", "--prune"], {
			must: false,
		});
		if (r.code !== 0) {
			throw Object.assign(new Error("aligning existing mirror failed"), {
				target,
				stderr: r.stderr.trim().split("\n").slice(-2).join(" | "),
			});
		}
		logInfo("aligned mirror", { target, origin: fetchUrl });
		return;
	}

	mkdirSync(o.dest, { recursive: true });
	const clone = await git(o.dest, ["clone", "--mirror", fetchUrl, target], {
		must: false,
	});
	if (clone.code !== 0) {
		// A half-written mirror would be mistaken for a good one on the next
		// run, so remove it before the caller can retry.
		rmSync(target, { recursive: true, force: true });
		throw Object.assign(new Error("git clone --mirror failed"), {
			origin: fetchUrl,
			stderr: clone.stderr.trim().split("\n").slice(-3).join(" | "),
		});
	}
	logInfo("mirrored", {
		source: input,
		target,
		origin: fetchUrl,
		glass: softwareForge ? (softwareForgeGlassUrl(softwareForge) ?? "") : "",
	});
}

/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"usage: ./git/-forge-mirror.sh <https-url|software-forge-url|clone-dir>... [--dest DIR]\n" +
				"                            [--transport ssh|https]\n",
		);
		return;
	}
	if (o.inputs.length === 0) {
		throw new Error("no repositories given (try --help)");
	}
	// Creating `/mnt/c/...` on a host where the drive is not mounted would
	// silently bury the farm in the WSL2 rootfs, defeating the whole point of
	// the NTFS dest (docs/d044).
	if (/^\/mnt\/[a-z]\//.test(o.dest) && !existsSync(o.dest.slice(0, 6))) {
		throw Object.assign(new Error("dest drive is not mounted"), {
			drive: o.dest,
		});
	}

	logInfo("forge mirror acquisition", {
		dest: o.dest,
		transport: o.transport ?? "as-given",
		count: o.inputs.length,
	});

	let failed = 0;
	for (const input of o.inputs) {
		try {
			await mirrorOne(input, o);
		} catch (err) {
			failed += 1;
			logWarn("mirror failed", {
				input,
				error: err instanceof Error ? err.message : String(err),
				detail:
					err instanceof Error && "stderr" in err ? String(err.stderr) : "",
			});
		}
	}
	if (failed) {
		throw new Error(`${failed} of ${o.inputs.length} inputs failed`);
	}
}

await main().catch((err) => {
	logError("forge-mirror aborted", {
		error: err instanceof Error ? err.message : String(err),
		detail: err instanceof Error && "stderr" in err ? String(err.stderr) : "",
	});
	process.exit(1);
});
