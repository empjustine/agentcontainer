/**
 * @fileoverview software-forge-mirror.mjs — acquire software-forge
 * repositories into the WORK mirror farm as bare mirrors. This is the
 * work-machine sibling of `-forge-mirror.sh`: that script keys the home farm
 * by an https forge host, but the work farm is one private tenant whose URLs
 * are not `host/owner/repo` at all (see `software-forge-remotes.mjs` for the three
 * shapes). Acquisition here is therefore identity-driven — the same repo is
 * recognized whether it was handed over as an ssh URL, an https URL, or a
 * glass-pane link.
 *
 * Input is either a full clone directory (its `remote.origin.url` is read, the
 * common case when a work repo already exists) or a software-forge fetch URL.
 * The bare
 * mirror lands at `<dest>/<org>/<projectSlug>/<repo>.git`, the layout that
 * mirrors the human identity in the glass UI. An existing mirror is aligned
 * with `remote update --prune`, so re-runs are idempotent — exactly the
 * contract of `-forge-mirror.sh`.
 *
 * Only acquisition lives here. Pickaxe optimization stays with
 * `maintain-mirrors.mjs` (`./git/maintain.sh --root <dest>`), and search
 * indexing is opt-in (`./git/search-references.sh`, docs/d043). For a whole
 * WSL2 tree of existing clones, `migrate-to-bare.mjs` is the bulk path; this
 * script is for one repo at a time or for a repo not yet cloned.
 *
 * Usage:
 *   ./git/-software-forge-mirror.sh <clone-dir|fetch-url>... [--dest DIR]
 *                         [--transport ssh|https] [--dry-run]
 *
 *   --dest DIR       work mirror root (default $WORK_MIRRORS; --dest or
 *                    $WORK_MIRRORS is required — no hard-coded path)
 *   --transport      rebuild each remote in this spelling before cloning
 *                    (default: use the URL as handed over)
 *   --dry-run        print the plan, touch nothing
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";

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

setLogTool("git/software-forge-mirror");

/**
 * Where work mirrors go when `--dest` is not given. There is deliberately no
 * hard-coded path: the original default was the first operator's NTFS profile
 * (docs/d044), which is meaningless on every other host, so `$WORK_MIRRORS`
 * or `--dest` is required.
 * @type {string}
 */
export const DEFAULT_WORK_DEST = process.env.WORK_MIRRORS ?? "";

/**
 * @typedef {object} Options
 * @property {string} dest
 * @property {"ssh"|"https"|null} transport
 * @property {boolean} dryRun
 * @property {boolean} help
 * @property {string[]} inputs
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
	/** @type {Options} */
	const o = {
		dest: DEFAULT_WORK_DEST,
		transport: null,
		dryRun: false,
		help: false,
		inputs: [],
	};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
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
			case "--dry-run":
				o.dryRun = true;
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
				o.inputs.push(a);
		}
	}
	return o;
}

/**
 * Resolve one input to the URL that will actually be fetched and the remote
 * identity it describes. A directory with `.git/` contributes its origin URL
 * (a clone that predates the mirror); anything else is treated as a URL.
 * @param {string} input
 * @returns {Promise<{ fetchUrl: string, source: string }|null>}
 */
async function resolveInput(input) {
	if (existsSync(`${input}/.git`)) {
		const url = await originUrl(input);
		if (!url) {
			logWarn("clone has no remote.origin.url — cannot acquire", { input });
			return null;
		}
		return { fetchUrl: url, source: input };
	}
	return { fetchUrl: input, source: input };
}

/**
 * The URL spelling to clone from: the input verbatim unless `--transport`
 * asks for the canonical rebuild (https survives an IDCS ssh rotation,
 * ssh needs no token — docs/d044).
 * @param {import("./software-forge-remotes.mjs").SoftwareForgeRemote} remote
 * @param {string} fetchUrl
 * @param {"ssh"|"https"|null} transport
 * @returns {string}
 */
function chooseFetchUrl(remote, fetchUrl, transport) {
	if (transport === "https") {
		return softwareForgeHttpsUrl(remote) ?? fetchUrl;
	}
	if (transport === "ssh") {
		return softwareForgeSshUrl(remote) ?? fetchUrl;
	}
	return fetchUrl;
}

/**
 * @param {string} input
 * @param {Options} o
 * @returns {Promise<"ok"|"skipped"|"failed">}
 */
async function mirrorOne(input, o) {
	const resolved = await resolveInput(input);
	if (!resolved) return "failed";
	const remote = parseSoftwareForgeRemote(resolved.fetchUrl);
	if (!remote) {
		logWarn(
			"not a software-forge remote — use ./git/-forge-mirror.sh for public " +
				"forges",
			{
				input,
				origin: resolved.fetchUrl,
			},
		);
		return "failed";
	}
	// A glass link carries only the human slug; the numeric project id lives in
	// the ssh/https fetch URLs, and without it there is nothing to clone.
	if (!remote.projectId) {
		logWarn("glass URL has no project id — pass the ssh or https fetch URL", {
			input,
			glass: softwareForgeGlassUrl(remote) ?? "",
		});
		return "failed";
	}

	const rel = softwareForgeMirrorRelPath(remote);
	const target = `${o.dest}/${rel}`;
	const fetchUrl = chooseFetchUrl(remote, resolved.fetchUrl, o.transport);
	const glass = softwareForgeGlassUrl(remote);

	if (existsSync(target)) {
		if (o.dryRun) {
			logInfo("would align existing mirror", { target, glass: glass ?? "" });
			return "ok";
		}
		const r = await git(target, ["remote", "update", "--prune"], {
			must: false,
		});
		if (r.code !== 0) {
			logWarn("align failed — mirror left as-is", {
				target,
				stderr: r.stderr.trim().split("\n").slice(-2).join(" | "),
			});
			return "failed";
		}
		logInfo("aligned mirror", { target, origin: fetchUrl, glass: glass ?? "" });
		return "ok";
	}

	if (o.dryRun) {
		logInfo("would mirror", {
			source: resolved.source,
			target,
			origin: fetchUrl,
			glass: glass ?? "",
		});
		return "ok";
	}

	mkdirSync(o.dest, { recursive: true });
	const clone = await git(o.dest, ["clone", "--mirror", fetchUrl, target], {
		must: false,
	});
	if (clone.code !== 0) {
		// A half-written mirror would be mistaken for a good one on the next run.
		rmSync(target, { recursive: true, force: true });
		logWarn("git clone --mirror failed", {
			origin: fetchUrl,
			stderr: clone.stderr.trim().split("\n").slice(-3).join(" | "),
		});
		return "failed";
	}
	logInfo("mirrored", {
		source: resolved.source,
		target,
		origin: fetchUrl,
		glass: glass ?? "",
	});
	return "ok";
}

/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"usage: ./git/-software-forge-mirror.sh <clone-dir|fetch-url>... [--dest DIR]\n" +
				"                            [--transport ssh|https] [--dry-run]\n",
		);
		return;
	}
	if (o.inputs.length === 0) {
		throw new Error("no repositories given (try --help)");
	}
	if (!o.dest) {
		throw new Error("no mirror dest: set WORK_MIRRORS or pass --dest DIR");
	}
	// Creating `/mnt/c/...` on a host where the drive is not mounted would
	// silently bury the farm in the WSL2 rootfs, defeating the whole point of
	// the NTFS dest.
	if (/^\/mnt\/[a-z]\//.test(o.dest) && !existsSync(o.dest.slice(0, 6))) {
		throw Object.assign(new Error("dest drive is not mounted"), {
			drive: o.dest,
		});
	}

	logInfo("software-forge work-mirror acquisition", {
		dest: o.dest,
		transport: o.transport ?? "as-given",
		count: o.inputs.length,
		dryRun: o.dryRun ? 1 : 0,
	});

	const tally = { ok: 0, skipped: 0, failed: 0 };
	for (const input of o.inputs) {
		const result = await mirrorOne(input, o);
		tally[result] += 1;
	}

	logInfo("acquisition summary", {
		requested: o.inputs.length,
		ok: tally.ok,
		failed: tally.failed,
		dest: o.dest,
	});
	if (tally.failed) process.exitCode = 1;
}

await main().catch((err) => {
	logError("software-forge-mirror aborted", {
		error: err,
	});
	process.exit(1);
});
