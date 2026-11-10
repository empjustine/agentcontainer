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
 *     `lib/forge-remotes.mjs`, which stays the single home of the three
 *     URL shapes.
 *
 * Two layouts, one per URL shape:
 *
 *   public forge (https only)      <dest>/<host>/<path>.git
 *   software-forge tenant          <dest>/<org>/<project>/<repo>.git
 *
 * Everything else is the shared contract both predecessors promised:
 * idempotent (an existing mirror gets `remote update --prune` — the one step
 * this tool takes the farm mutation lock for, docs/d166), bare mirrors
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
 *   --lock-timeout   whole seconds an align may wait on the farm mutation
 *                    lock (0 = indefinitely), default 1800: an align queues
 *                    behind a sweep because both mutate the same farm, while
 *                    every other wait in the folder defaults to 10 s
 *                    (docs/d166).
 *
 * The entry also has one mode an operator does not type:
 *   --align TARGET --dest DIR   align ONE mirror that already exists, while
 *                    -forge-mirror.sh holds the farm mutation lock. This file
 *                    spawns that entry for it, which is how the lock stays in
 *                    shell — flock on an fd is the one mechanism (docs/d121),
 *                    so run the align through the entry, never past it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFlags, runEntry } from "./lib/cli.mjs";
import {
	git,
	logInfo,
	logWarn,
	originUrl,
	setLogTool,
} from "./lib/git-core.mjs";
import {
	parseSoftwareForgeRemote,
	softwareForgeGlassUrl,
	softwareForgeHttpsUrl,
	softwareForgeMirrorRelPath,
	softwareForgeSshUrl,
} from "./lib/forge-remotes.mjs";

setLogTool("git/forge-mirror");

/** @type {string} */
const DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The entry an align runs through — flock lives in that shell, so node reaches
 * the lock only by spawning it (docs/d121/d166).
 * @type {string}
 */
const ENTRY_SH = join(DIR, "-forge-mirror.sh");

/**
 * The wait an align inherits when nobody said otherwise (seconds). An align is
 * the mutation that queues: a sweep mutates the same mirrors, so an
 * acquisition waits one out instead of failing in the operator's face — the
 * queue half of docs/d166's timeout policy (the shell's own default, for a
 * wait nobody queued, is 10 s).
 * @type {number}
 */
const QUEUE_LOCK_TIMEOUT_S = 1800;

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
 * @property {string|null} align internal: the absolute path of ONE existing
 *   mirror to align, handed by this file to -forge-mirror.sh --align (the
 *   locked sub-run, docs/d166); null on every normal run
 * @property {number|null} lockTimeout seconds the align may wait on that lock
 *   (--lock-timeout); null = fall back to FG_FARM_MUTATION_LOCK_TIMEOUT_S,
 *   then the queue default
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
	const { values: v, positionals, help } = parseFlags(
		argv,
		{
			dest: { default: DEFAULT_DEST },
			transport: {},
			"lock-timeout": { kind: "number" },
			align: {},
		},
		// Anything flag-shaped is rejected rather than guessed at: this script
		// is d099's upsert_repo boundary, and an option-shaped URL must die
		// here, never in git's argv. The policy above gives that for free.
		"list",
	);
	const transport = v.transport ?? null;
	if (transport !== null && transport !== "ssh" && transport !== "https") {
		throw Object.assign(new Error("--transport must be ssh or https"), {
			value: transport,
		});
	}
	/** @type {Options} */
	return {
		dest: v.dest,
		transport,
		help,
		inputs: positionals,
		align: v.align ?? null,
		lockTimeout: v["lock-timeout"] ?? null,
	};
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
 * What one input plans: the fetch URL it resolves to, the mirror path it maps
 * to under --dest, and the glass link to log beside it. Planning reads
 * nothing but the input, so a whole batch can be planned before the first
 * clone — which is what puts every lock-free clone ahead of the first lock
 * wait (docs/d166).
 * @typedef {{input: string, fetchUrl: string, target: string,
 *   glass: string}} MirrorPlan
 */

/**
 * @param {string} input
 * @param {Options} o
 * @returns {Promise<MirrorPlan>}
 */
async function planMirror(input, o) {
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

	return {
		input,
		fetchUrl,
		target: `${o.dest}/${rel}`,
		glass: softwareForge ? (softwareForgeGlassUrl(softwareForge) ?? "") : "",
	};
}

/**
 * Clone one fresh mirror. The farm lock is not part of it: no farm process
 * can know the path before it exists, so there is nothing to queue behind
 * (docs/d166).
 * @param {MirrorPlan} plan
 * @param {Options} o
 * @returns {Promise<void>}
 */
async function cloneMirrored(plan, o) {
	mkdirSync(o.dest, { recursive: true });
	const clone = await git(
		o.dest,
		["clone", "--mirror", plan.fetchUrl, plan.target],
		{
			must: false,
		},
	);
	if (clone.code !== 0) {
		// A half-written mirror would be mistaken for a good one on the next
		// run, so remove it before the caller can retry.
		rmSync(plan.target, { recursive: true, force: true });
		throw Object.assign(new Error("git clone --mirror failed"), {
			origin: plan.fetchUrl,
			stderr: clone.stderr.trim().split("\n").slice(-3).join(" | "),
		});
	}
	logInfo("mirrored", {
		source: plan.input,
		target: plan.target,
		origin: plan.fetchUrl,
		glass: plan.glass,
	});
}

/**
 * How long the align sub-run may wait on the farm mutation lock: the
 * --lock-timeout flag when given, else FG_FARM_MUTATION_LOCK_TIMEOUT_S, else
 * the queue default. Resolved HERE because the wait happens in a shell that
 * never sees argv, and validated here so a bad value dies as this entry's own
 * error instead of a child's exit status (docs/d166).
 * @param {Options} o
 * @returns {number} whole seconds; 0 waits indefinitely
 */
function resolveLockTimeout(o) {
	const flag = o.lockTimeout;
	const raw = flag === null ? process.env.FG_FARM_MUTATION_LOCK_TIMEOUT_S : String(flag);
	if (raw === undefined || raw === "") {
		return QUEUE_LOCK_TIMEOUT_S;
	}
	const seconds = Number(raw);
	if (!Number.isInteger(seconds) || seconds < 0) {
		throw Object.assign(
			new Error("lock timeout must be a whole number of seconds"),
			{ value: raw },
		);
	}
	return seconds;
}

/**
 * Run the align through the entry that owns the lock: `-forge-mirror.sh
 * --align TARGET --dest DIR` wraps this run in with_farm_mutation_lock, so
 * the wait, the holder report and the give-up code (75) all stay the
 * shell's (docs/d166), and node still only names, probes and describes the
 * lock (docs/d121).
 *
 * spawnSync on purpose: the align is this run's step in flight (docs/d164),
 * so a signal finishes it rather than landing between a fetch and its report,
 * and inherited streams mean the sub-run's log lines go where this entry's
 * own would — farm-tool's runChild has already pointed both at its stderr.
 * @param {string} target
 * @param {Options} o
 * @returns {void}
 */
function alignUnderFarmLock(target, o) {
	const res = spawnSync(ENTRY_SH, ["--align", target, "--dest", o.dest], {
		stdio: ["ignore", "inherit", "inherit"],
		env: {
			...process.env,
			FG_FARM_MUTATION_LOCK_TIMEOUT_S: String(resolveLockTimeout(o)),
		},
	});
	if (res.error) {
		throw res.error;
	}
	const code = res.status ?? 1;
	if (code === 75) {
		// farm-lock.sh already printed the holder, the hold-back and both ways
		// out; this is what the caller's report carries.
		throw Object.assign(
			new Error("align queue timed out on the farm mutation lock (see stderr)"),
			{ target, exit: code },
		);
	}
	if (code !== 0) {
		throw Object.assign(new Error("aligning existing mirror failed"), {
			target,
			exit: code,
		});
	}
}

/**
 * The locked sub-run's own work: align ONE mirror that already exists, with
 * the farm mutation lock held by the shell entry around this process
 * (docs/d166). Containment against --dest is checked HERE — the flag is
 * spawned by this file, but an argv mistake must still not turn into a fetch
 * into a path outside the farm, and nothing downstream checks it.
 * @param {Options} o
 * @returns {Promise<void>}
 */
async function alignExisting(o) {
	if (o.align === null) {
		throw new Error("--align needs the mirror's absolute path");
	}
	const target = resolve(o.align);
	const dest = resolve(o.dest);
	if (target !== dest && !target.startsWith(`${dest}/`)) {
		throw Object.assign(new Error("--align target is outside --dest"), {
			target,
			dest,
		});
	}
	if (!existsSync(target)) {
		throw Object.assign(
			new Error("--align target does not exist — clone it, do not align it"),
			{ target },
		);
	}
	const r = await git(target, ["remote", "update", "--prune"], {
		must: false,
	});
	if (r.code !== 0) {
		throw Object.assign(new Error("aligning existing mirror failed"), {
			target,
			stderr: r.stderr.trim().split("\n").slice(-2).join(" | "),
		});
	}
	logInfo("aligned mirror", {
		target,
		origin: (await originUrl(target)) ?? "",
	});
}

/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"usage: ./git/-forge-mirror.sh <https-url|software-forge-url|clone-dir>... [--dest DIR]\n" +
				"                            [--transport ssh|https] [--lock-timeout SECONDS]\n",
		);
		return;
	}
	// Creating `/mnt/c/...` on a host where the drive is not mounted would
	// silently bury the farm in the WSL2 rootfs, defeating the whole point of
	// the NTFS dest (docs/d044).
	if (/^\/mnt\/[a-z]\//.test(o.dest) && !existsSync(o.dest.slice(0, 6))) {
		throw Object.assign(new Error("dest drive is not mounted"), {
			drive: o.dest,
		});
	}
	// Ahead of the "no repositories given" gate: the locked sub-run names its
	// target in --align, never in positionals (docs/d166).
	if (o.align !== null) {
		await alignExisting(o);
		return;
	}
	if (o.inputs.length === 0) {
		throw new Error("no repositories given (try --help)");
	}

	logInfo("forge mirror acquisition", {
		dest: o.dest,
		transport: o.transport ?? "as-given",
		count: o.inputs.length,
	});

	let failed = 0;
	// One reporting path for the three passes below: a plan, a clone and an
	// align all fail as one more failed input, so the final count stays
	// honest no matter which pass caught it (docs/d166).
	/** @param {string} input @param {() => Promise<void>|void} work
	 * @returns {Promise<void>} */
	const attempt = async (input, work) => {
		try {
			await work();
		} catch (err) {
			failed += 1;
			logWarn("mirror failed", {
				input,
				error: err instanceof Error ? err.message : String(err),
				detail:
					err instanceof Error && "stderr" in err ? String(err.stderr) : "",
			});
		}
	};

	// The fresh/existing split is frozen while planning, before the first
	// clone: a mirror cloned in this run is current by construction and is
	// never aligned again (docs/d166).
	/** @type {Array<MirrorPlan & {fresh: boolean}>} */
	const plans = [];
	for (const input of o.inputs) {
		await attempt(input, async () => {
			const plan = await planMirror(input, o);
			plans.push({ ...plan, fresh: !existsSync(plan.target) });
		});
	}

	// Clones are lock-free, so every fresh mirror is created before any align
	// can wait on — or give up on — the farm mutation lock: a held lock costs
	// the fresh mirrors nothing, and the complaint about it comes last. The
	// exists check catches the same input twice in one batch — the earlier
	// clone in this pass already made that target (docs/d166).
	for (const plan of plans) {
		if (!plan.fresh || existsSync(plan.target)) {
			continue;
		}
		await attempt(plan.input, () => cloneMirrored(plan, o));
	}
	for (const plan of plans) {
		if (plan.fresh) {
			continue;
		}
		await attempt(plan.input, () => alignUnderFarmLock(plan.target, o));
	}
	if (failed) {
		throw new Error(`${failed} of ${o.inputs.length} inputs failed`);
	}
}

await runEntry("forge-mirror", main, {
	report: (err) => ({
		error: err instanceof Error ? err.message : String(err),
		detail: err instanceof Error && "stderr" in err ? String(err.stderr) : "",
	}),
});
