/**
 * @fileoverview migrate-to-bare.mjs — mass-convert non-bare reference clones
 * into bare mirrors. The reference farm at `~/Downloads/references` is/was
 * ~776 full clones: each carries a checked-out working tree, which is most of
 * its disk AND essentially all of its file count (1.66M files → ~39 s of
 * podman `z,U` relabel on every container launch). A bare mirror keeps the
 * exact same history/refs in a handful of packfiles and answers every
 * history/pickaxe question without a checkout. Rationale: non-bare-issues.md.
 *
 * Mirrors land in a SEPARATE root (`--dest`, default `<root>-bare`), not as
 * siblings of the clones. Some reference "owners" are themselves repos that
 * wrap further clones (github/duckdb contains the duckdb/* repos), so a
 * sibling mirror would sit inside another clone's working tree and be deleted
 * with it. The parallel root also makes the farm directly mountable/servable
 * and `--delete-originals` safe.
 *
 * Conversion is IN-PLACE by default and needs no network: it clones the
 * existing `.git` into the mirror root (hardlinking objects across the same
 * filesystem, so it is fast and nearly space-free), then re-points `origin`
 * at the real upstream captured from the old clone. `--redownload` forces a
 * fresh `--mirror` clone from upstream instead. Shallow clones
 * (`.git/shallow`) are ALWAYS re-downloaded — a mirror of a shallow clone is
 * still shallow, which defeats the deep pickaxe this migration exists to
 * enable. Submodules are not mirrored (a submodule's `.git` is a file, not a
 * directory, so discovery ignores it); re-download restores the superproject
 * refs but not submodule objects.
 *
 * Originals are KEPT by default: shrinking disk is a separate, deliberate
 * step (`--delete-originals`), run only after you have verified the mirrors.
 *
 * CAVEAT on prune alignment: a mirror's refspec is `+refs/*:refs/*`, so the
 * later `maintain-mirrors.mjs` run treats upstream as the source of truth and
 * DELETES refs upstream no longer has — including a local-only branch that
 * happened to live in a reference clone. This farm is read-only reference
 * material, so that is the intended "exact replica" semantics; do not run it
 * against clones holding un-pushed work.
 *
 * Usage:
 *   ./git/migrate.sh [--root DIR] [--dest DIR] [--jobs N] [--max-depth N]
 *                    [--redownload] [--delete-originals] [--force]
 *                    [--verify] [--dry-run]
 *
 *   --root DIR            reference root (default $REFERENCES_ROOT else
 *                         ~/Downloads/references)
 *   --dest DIR            bare-mirror root (default $REFERENCES_MIRRORS else
 *                         <root>-bare)
 *   --jobs N              parallel conversions (default 4)
 *   --max-depth N         discovery depth bound (default 5)
 *   --redownload          clone --mirror from the real upstream (network)
 *   --delete-originals    rm -rf each source clone after a successful convert
 *   --force               replace an existing mirror target
 *   --verify              fsck --connectivity-only each new mirror
 *   --only GLOB           convert only clones whose relative path matches
 *                         (repeatable)
 *   --exclude GLOB        skip clones whose relative path matches (repeatable)
 *   --dry-run             print the plan, touch nothing
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
	DEFAULT_DEST,
	DEFAULT_MAX_DEPTH,
	DEFAULT_ROOT,
	filterByGlobs,
	findCloneRoots,
	git,
	logError,
	logInfo,
	logWarn,
	originUrl,
	pool,
	setLogTool,
} from "./git-lib.mjs";

setLogTool("git/migrate-to-bare");

/**
 * @typedef {object} Options
 * @property {string} root
 * @property {string} dest
 * @property {number} jobs
 * @property {number} maxDepth
 * @property {boolean} redownload
 * @property {boolean} deleteOriginals
 * @property {boolean} force
 * @property {boolean} verify
 * @property {string[]} only
 * @property {string[]} exclude
 * @property {boolean} dryRun
 * @property {boolean} help
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
	/** @type {Options} */
	const o = {
		root: DEFAULT_ROOT,
		dest: DEFAULT_DEST,
		jobs: 4,
		maxDepth: DEFAULT_MAX_DEPTH,
		redownload: false,
		deleteOriginals: false,
		force: false,
		verify: false,
		only: [],
		exclude: [],
		dryRun: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		switch (a) {
			case "--root":
				o.root = /** @type {string} */ (argv[++i]);
				break;
			case "--dest":
				o.dest = /** @type {string} */ (argv[++i]);
				break;
			case "--jobs":
				o.jobs = Number(argv[++i]);
				break;
			case "--max-depth":
				o.maxDepth = Number(argv[++i]);
				break;
			case "--redownload":
				o.redownload = true;
				break;
			case "--delete-originals":
				o.deleteOriginals = true;
				break;
			case "--force":
				o.force = true;
				break;
			case "--verify":
				o.verify = true;
				break;
			case "--only":
				o.only.push(/** @type {string} */ (argv[++i]));
				break;
			case "--exclude":
				o.exclude.push(/** @type {string} */ (argv[++i]));
				break;
			case "--dry-run":
				o.dryRun = true;
				break;
			case "-h":
			case "--help":
				o.help = true;
				break;
			default:
				throw new Error(`unknown flag: ${a} (try --help)`);
		}
	}
	return o;
}

/**
 * Remove the remote-tracking refs a `--local` mirror inherits from its source
 * clone (`refs/remotes/origin/*`). A mirror's truth is `refs/heads` +
 * `refs/tags`; leaving the duplicates would make the next pruned fetch churn
 * them. Objects are untouched — they remain reachable from the heads.
 * @param {string} repo
 * @returns {Promise<number>} refs deleted
 */
async function dropRemoteTrackingRefs(repo) {
	const listed = await git(
		repo,
		["for-each-ref", "--format=%(refname)", "refs/remotes"],
		{ must: false },
	);
	const refs = listed.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const ref of refs) {
		await git(repo, ["update-ref", "-d", ref], { must: false });
	}
	return refs.length;
}

/**
 * @param {string} clone
 * @param {Options} o
 * @returns {string} the mirror path for a clone, preserving its relative path
 */
function targetFor(clone, o) {
	return join(o.dest, `${relative(o.root, clone)}.git`);
}

/**
 * Convert one non-bare clone to a bare mirror.
 * @param {string} clone
 * @param {Options} o
 * @returns {Promise<"migrated"|"skipped"|"failed">}
 */
async function convertOne(clone, o) {
	const target = targetFor(clone, o);
	const realUrl = await originUrl(clone);
	const shallow = existsSync(join(clone, ".git", "shallow"));

	if (existsSync(target) && !o.force) {
		logInfo("mirror already exists — skipping", { clone, target });
		return "skipped";
	}
	if (!realUrl) {
		logWarn(
			"no remote.origin.url — mirroring locally; maintenance cannot fetch it",
			{
				clone,
			},
		);
	}
	if (shallow) {
		logWarn(
			"shallow clone — re-downloading from upstream to get full history",
			{
				clone,
			},
		);
	}
	const useDownload = o.redownload || shallow || !realUrl;
	if (o.dryRun) {
		logInfo("would convert", {
			clone,
			target,
			mode: useDownload && realUrl ? "download" : "local",
			origin: realUrl ?? "",
		});
		return "migrated";
	}

	mkdirSync(dirname(target), { recursive: true });
	if (o.force && existsSync(target)) {
		rmSync(target, { recursive: true, force: true });
	}

	try {
		if (useDownload && realUrl) {
			await git(o.root, ["clone", "--mirror", realUrl, target]);
		} else {
			// --local hardlinks objects on the same filesystem, so this is fast
			// and near-space-free; the origin URL is corrected below.
			await git(o.root, ["clone", "--mirror", "--local", clone, target]);
			if (realUrl) {
				await git(target, ["remote", "set-url", "origin", realUrl]);
			}
		}
	} catch (err) {
		logWarn("conversion failed", {
			clone,
			error: /** @type {Error} */ (err).message,
		});
		return "failed";
	}

	const bare = await git(target, ["rev-parse", "--is-bare-repository"], {
		must: false,
	});
	if (bare.stdout.trim() !== "true") {
		logWarn("converted target is not bare — leaving it for inspection", {
			target,
		});
		return "failed";
	}

	if (!(useDownload && realUrl)) {
		const dropped = await dropRemoteTrackingRefs(target);
		if (dropped)
			logInfo("dropped inherited remote-tracking refs", { target, dropped });
	}

	const head = await git(target, ["rev-parse", "--verify", "HEAD"], {
		must: false,
	});
	if (head.code !== 0) {
		logWarn(
			"mirror has an unborn HEAD (upstream empty or default branch missing)",
			{
				target,
			},
		);
	}

	if (o.verify) {
		const fsck = await git(target, ["fsck", "--connectivity-only"], {
			must: false,
		});
		if (fsck.code !== 0) {
			logWarn("fsck --connectivity-only reported problems", {
				target,
				stderr: fsck.stderr.trim().split("\n").slice(-3).join(" | "),
			});
			return "failed";
		}
	}

	if (o.deleteOriginals) {
		rmSync(clone, { recursive: true, force: true });
		logInfo("removed original clone", { clone });
	}

	logInfo("mirror created", {
		clone,
		target,
		mode: useDownload && realUrl ? "download" : "local",
		origin: realUrl ?? "",
	});
	return "migrated";
}

/** @returns {Promise<void>} */
async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"usage: ./git/migrate.sh [--root DIR] [--dest DIR] [--jobs N]\n" +
				"                       [--max-depth N] [--redownload]\n" +
				"                       [--delete-originals] [--force] [--verify]\n" +
				"                       [--only GLOB]... [--exclude GLOB]... [--dry-run]\n",
		);
		return;
	}
	if (!existsSync(o.root)) {
		throw new Error(`reference root not found: ${o.root}`);
	}
	if (o.dest === o.root || o.root.startsWith(`${o.dest}/`)) {
		throw new Error(`--dest must not overlap --root (${o.dest} vs ${o.root})`);
	}

	const discovered = findCloneRoots(o.root, o.maxDepth);
	const rels = discovered.map((p) => relative(o.root, p));
	const kept = new Set(filterByGlobs(rels, o.only, o.exclude));
	const clones = discovered.filter((p) => kept.has(relative(o.root, p)));
	logInfo("discovered non-bare clones", {
		root: o.root,
		dest: o.dest,
		count: clones.length,
		skippedByFilter: discovered.length - clones.length,
		jobs: o.jobs,
		mode: o.redownload ? "redownload" : "local",
		dryRun: o.dryRun ? 1 : 0,
	});
	if (clones.length === 0) return;

	const results = await pool(clones, o.jobs, (clone) => convertOne(clone, o));
	const tally = { migrated: 0, skipped: 0, failed: 0 };
	for (const r of results) tally[r] += 1;

	logInfo("migration summary", {
		discovered: clones.length,
		migrated: tally.migrated,
		skipped: tally.skipped,
		failed: tally.failed,
		deletedOriginals: o.deleteOriginals ? tally.migrated : 0,
		dest: o.dest,
	});
	if (tally.failed) process.exitCode = 1;
}

await main().catch((err) => {
	logError("migration aborted", {
		error: /** @type {Error} */ (err)?.message ?? String(err),
	});
	process.exit(1);
});
