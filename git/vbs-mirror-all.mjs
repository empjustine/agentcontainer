#!/usr/bin/env node
/**
 * @fileoverview vbs-mirror-all.mjs — mirror EVERY git repository reachable in
 * a Visual Builder Studio (VBS) tenant. The operator entry is the
 * `-vbs-mirror-all.sh` shim beside this file.
 *
 * One input mode, one mirror loop (docs/d044):
 *
 *   manifest  read a JSON inventory produced by `vbs-har.mjs` (a HAR export).
 *             No HTTP, no secrets.
 *
 * The manifest is the stable seam: the fragile, authenticated part is a browser
 * HAR capture, and this half is deterministic and secret-free:
 *
 *   { generatedAt, base, org, repositories: [ { projectId, projectSlug,
 *     repo, httpsUrl, sshUrl } ] }
 *
 * Bulk-mirroring the tenant earns a rate limit (the forge answers with 403/429
 * or a dropped connection), so a failing repo is retried with exponential
 * backoff + jitter, the sweep is paced between repos, and a run of consecutive
 * failures triggers a cooldown — nothing is silently dropped. That policy lives
 * in `lib/retry.mjs`, shared with anything else that sweeps a tenant; this file
 * only decides WHEN to apply it.
 *
 * What a run IS and DOES comes from its argv and its manifest, never from the
 * caller's environment (docs/d060): the manifest carries the tenant (base, org,
 * repos), the mirror root and the clone identity are flags, and the retry and
 * pacing knobs are flags-or-constants — so no exported shell variable can
 * re-point a sweep or quietly turn off its rate limiting. `WORK_MIRRORS` is the
 * one external read left: this machine's mirror root, the same host state
 * `git/*.mjs` default from (docs/d044). Credentials are the other thing that
 * has to stay in the environment — this tool takes none: the HAR capture is the
 * auth, and a username on argv is visible but not secret (docs/d044).
 *
 * Exit status is 1 when any repo failed to mirror, so a cron wrapper sees a
 * sweep that half-worked as a failure.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseFlags, runEntry } from "./lib/cli.mjs";
import {
	caseGlob,
	git,
	logError,
	logInfo,
	logWarn,
	setLogTool,
} from "./lib/git-core.mjs";
import { backoffSeconds, classifyFailure, sleepSeconds } from "./lib/retry.mjs";

// The operator enters through the shim, so the usage text must name the shim,
// not this file — a message telling a user to run vbs-mirror-all.mjs would send
// them around the node-version pin the shim exists to apply.
const PROG = "-vbs-mirror-all.sh";

const USAGE = `usage: ${PROG} --manifest FILE [--dest DIR] [--list] [--only GLOB]

Mirrors every repository in the VBS tenant as a bare repo.

Inputs (flags; the caller's environment is not a config surface — docs/d060):
  # export a HAR capture from the browser, convert it with vbs-har.sh, then
  # mirror from the manifest — it carries the tenant origin and org
  ${PROG} --manifest vbs-manifest.json --dest DIR

  --dest DIR        mirror root (default \${WORK_MIRRORS:-unset})
  --transport T     ssh (ssh|https)
  --ssh-user USER   unset
  --http-user USER  unset

Rate limiting (the defaults shown; flags are the only way to move them):
  --throttle N   seconds between repositories (default 60)
  --retries N    retries per repo after the first failure (default 10)
  --cooldown N   pause after 5 consecutive failures (default 60s)
`;

/**
 * The tenant's rate-limit contract: fixed policy with three flag overrides for
 * the knobs an operator actually tunes (docs/d044).
 *
 * `failStreak` and `cooldown` are the sweep-wide answer to a systemic limit;
 * `rateDelay` is deliberately a different ladder from `retryDelay` because a
 * throttle needs a longer first pause than a dropped connection.
 */
const POLICY = {
	retries: 10,
	retryDelay: 60,
	rateDelay: 60,
	backoffMax: 300,
	throttle: 60,
	failStreak: 5,
	cooldown: 60,
};

/**
 * The parsed flags. Every field is optional in the type because the table
 * leaves a flag that never appeared at its default — which the runtime defaults
 * above make concrete, but the type cannot (docs/d121's "no interface change").
 * @type {{ manifest?: string, dest?: string, transport?: string,
 *   sshUser?: string, httpUser?: string, only?: string, list?: boolean,
 *   throttle?: number, retries?: number, cooldown?: number }}
 */
let flags = {};

/**
 * The manifest's origin and org — the manifest is the input file, so it, not
 * the environment, names the tenant (docs/d060).
 * @param {any} doc
 * @returns {{ base: string, org: string }}
 */
function tenantOf(doc) {
	const base = typeof doc?.base === "string" ? doc.base : "";
	const org = typeof doc?.org === "string" ? doc.org : "";
	return { base: base.replace(/\/$/, ""), org };
}

/**
 * jq's `tostring`, near enough: a string passes through, an object/array is
 * compact JSON, everything else is its primitive spelling.
 * @param {unknown} v
 * @returns {string}
 */
function stringOf(v) {
	if (typeof v === "string") {
		return v;
	}
	if (v !== null && typeof v === "object") {
		return JSON.stringify(v);
	}
	return String(v);
}

/**
 * The first field that exists, in jq `//` order — an absent field is absent,
 * not "". The SPA endpoints are undocumented, so the extractor accepts the
 * handful of envelope shapes such shapes use (bare array, `repositories`, or a
 * name-keyed object map) and the handful of field spellings each carries; the
 * shape is a property of the HAR converter's output, not of the caller
 * (docs/d060).
 * @param {any} obj
 * @param {string[]} keys
 * @returns {string}
 */
function fieldOf(obj, keys) {
	for (const key of keys) {
		const v = obj?.[key];
		// `null` and `false` are what jq's `//` skips; "" is a real value.
		if (v !== undefined && v !== null && v !== false) {
			return stringOf(v);
		}
	}
	return "";
}

/**
 * The manifest document IS the envelope: rows live in `repositories`. The jq
 * extractor also accepted a bare array, but that branch was unreachable — a
 * bare array carries no `base`, so the tenant check below always refused it
 * first ("no tenant origin"), in the shell as much as here (docs/d121).
 * @param {any} doc
 * @returns {{ projectId: string, projectSlug: string, repo: string, https: string, ssh: string }[]}
 */
function extractRepos(doc) {
	/** @type {any[]} */
	const rows = Array.isArray(doc?.repositories) ? doc.repositories : [];
	return rows.map((/** @type {any} */ row) => ({
		projectId: fieldOf(row, ["projectId", "projectGuid"]),
		projectSlug: fieldOf(row, ["projectSlug", "project", "slug"]),
		repo: fieldOf(row, ["repo", "name"]),
		https: fieldOf(row, ["httpsUrl", "httpUrl"]),
		ssh: fieldOf(row, ["sshUrl"]),
	}));
}

/**
 * `projectId` is `<org>_<slug>_<numeric>`; the glass directory is the slug.
 * @param {string} projectId
 * @param {string} org
 * @returns {string}
 */
function slugFromProjectId(projectId, org) {
	const prefix = `${org}_`;
	const rest = projectId.startsWith(prefix)
		? projectId.slice(prefix.length)
		: projectId;
	const cut = rest.lastIndexOf("_");
	if (cut < 0) {
		return rest;
	}
	const base = rest.slice(0, cut);
	const tail = rest.slice(cut + 1);
	return /^[0-9]+$/.test(tail) ? base : rest;
}

/**
 * Insert userinfo into a URL that lacks it. HAR clone URLs are userinfo-less;
 * the configured identity supplies it, while a URL that already carries one is
 * untouched.
 * @param {string} url
 * @param {string} userinfo may be empty
 * @returns {string}
 */
function injectUser(url, userinfo) {
	if (!userinfo) {
		return url;
	}
	const schemeEnd = url.indexOf("://");
	if (schemeEnd < 0) {
		return url;
	}
	const afterScheme = url.slice(schemeEnd + 3);
	if (afterScheme.includes("@")) {
		return url;
	}
	// Preserve the URL's own protocol: the ssh branch calls this with an ssh://
	// URL, and hardcoding https here once rewrote ssh clones to https.
	return `${url.slice(0, schemeEnd)}://${userinfo}@${afterScheme}`;
}

/**
 * @param {string} base
 * @returns {string} the host, with the scheme and any trailing slash stripped
 */
function vbsHost(base) {
	return base.replace(/^.*?:\/\//, "").replace(/\/$/, "");
}

/**
 * @param {{ projectId: string, repo: string, https: string, ssh: string }} row
 * @param {{ base: string, org: string }} tenant
 * @returns {string}
 */
function cloneUrl(row, tenant) {
	const host = vbsHost(tenant.base);
	if (flags.transport === "ssh") {
		if (row.ssh) {
			return injectUser(row.ssh, flags.sshUser ?? "");
		}
		const auth = flags.sshUser ? `${flags.sshUser}@` : "";
		return `ssh://${auth}${host}/${row.projectId}/${row.repo}.git`;
	}
	if (row.https) {
		return injectUser(row.https, flags.httpUser ?? "");
	}
	const auth = flags.httpUser ? `${flags.httpUser}@` : "";
	return `https://${auth}${host}/${tenant.org}/s/${row.projectId}/scm/${row.repo}.git`;
}

/**
 * @param {number} code
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 * @returns {never}
 */
function die(code, msg, fields = {}) {
	logError(msg, fields);
	process.exit(code);
}

/**
 * @param {number} seconds
 * @returns {Promise<void>}
 */
function pace(seconds) {
	return seconds > 0 ? sleepSeconds(seconds) : Promise.resolve();
}

/**
 * One repo, retried until it mirrors or the failure is provably not going to
 * clear. A half-written mirror is removed before any retry: it would be
 * mistaken for a good one on the next run.
 * @param {string} url
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function mirrorOne(url, target) {
	for (let attempt = 1; ; attempt += 1) {
		let phase;
		let failure = "";
		if (isDirectory(target)) {
			phase = "align";
			const res = await git(target, ["remote", "update", "--prune"], {
				must: false,
			});
			if (res.code === 0) {
				logInfo("aligned", { target });
				return true;
			}
			failure = `${res.stdout}${res.stderr}`;
		} else {
			phase = "clone";
			mkdirSync(dirname(target), { recursive: true });
			const res = await git(dirname(target), ["clone", "--mirror", url, target], {
				must: false,
			});
			if (res.code === 0) {
				logInfo("mirrored", { target });
				return true;
			}
			failure = `${res.stdout}${res.stderr}`;
			rmSync(target, { recursive: true, force: true });
		}

		const kind = classifyFailure(failure);
		const output = failure.trimEnd().split("\n").slice(-3).join("\n");
		if (kind === "hard") {
			// A bad path, a deleted repo, a real auth failure: report it and move
			// on without burning the rate budget.
			logError("step failed", { phase, url, output });
			return false;
		}
		if (attempt > (flags.retries ?? POLICY.retries)) {
			logError(
				kind === "rate-limited" ? "step failed rate-limited" : "step failed transient",
				{
					phase,
					url,
					attempt,
					retries: flags.retries,
					output,
				},
			);
			return false;
		}
		const base = kind === "rate-limited" ? POLICY.rateDelay : POLICY.retryDelay;
		const delay = backoffSeconds(attempt, base, { max: POLICY.backoffMax });
		logWarn(
			kind === "rate-limited"
				? "rate limited — sleeping"
				: "transient failure — sleeping",
			{ phase, delay, attempt, retries: flags.retries },
		);
		await sleepSeconds(delay);
	}
}

/**
 * `-d`, spelled so an absent path is simply not a directory: an existing FILE
 * where a mirror belongs is treated as a clone (it fails, gets removed, and the
 * next attempt starts clean), which is what `[ -d ]` gave the shell.
 * @param {string} target
 * @returns {boolean}
 */
function isDirectory(target) {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/**
 * @param {string} manifestPath
 * @returns {any}
 */
function loadManifest(manifestPath) {
	if (!existsSync(manifestPath)) {
		die(1, "manifest not found", { manifest: manifestPath });
	}
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		die(1, "could not parse manifest (shape not one the extractor knows)");
	}
}

async function main() {
	const { values, help } = parseFlags(
		process.argv.slice(2),
		{
			manifest: { kind: "string" },
			dest: { kind: "string" },
			transport: { kind: "string", default: "ssh" },
			sshUser: { names: ["--ssh-user"], kind: "string" },
			httpUser: { names: ["--http-user"], kind: "string" },
			only: { kind: "string" },
			list: { kind: "bool", default: false },
			throttle: { kind: "number", default: POLICY.throttle },
			retries: { kind: "number", default: POLICY.retries },
			cooldown: { kind: "number", default: POLICY.cooldown },
		},
		"reject",
	);
	if (help) {
		process.stdout.write(USAGE);
		return;
	}
	flags = values;
	if (!flags.manifest) {
		die(1, "no manifest: --manifest FILE (a vbs-har.sh export carries base + org)");
	}
	const doc = loadManifest(flags.manifest);
	const tenant = tenantOf(doc);
	if (!tenant.base) {
		// Without an origin there is nothing to clone; fail loud rather than
		// half-run.
		die(1, "no tenant origin: manifest has no base field");
	}
	if (flags.dest === undefined) {
		const fromEnv = process.env.WORK_MIRRORS;
		if (fromEnv !== undefined) {
			flags.dest = fromEnv;
		}
	}
	if (!flags.dest) {
		die(1, "no mirror dest: pass --dest DIR (or set WORK_MIRRORS)");
	}
	tenant.org ||= vbsHost(tenant.base).split(".")[0] ?? "";
	if (flags.transport !== "ssh" && flags.transport !== "https") {
		die(1, "--transport must be ssh or https", {
			transport: flags.transport,
		});
	}

	// Creating /mnt/... where the drive is not mounted would bury the farm in
	// the WSL2 rootfs, defeating the entire reason the dest is on NTFS
	// (docs/d044).
	const mount = /^\/mnt\/([^/]+)\//.exec(/** @type {string} */ (flags.dest));
	if (mount && !existsSync(`/mnt/${mount[1]}`)) {
		die(1, "dest drive is not mounted", { mount: `/mnt/${mount[1]}` });
	}
	if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) {
		die(1, "git not found");
	}
	// A GET config would silently use ssh's default user; the tenant needs the
	// IDCS userinfo, so make the missing credential loud instead of mysterious.
	if (flags.transport === "ssh" && !flags.sshUser && !flags.list) {
		logWarn("ssh user is empty — ssh clones may fail; pass --ssh-user");
	}

	const dest = resolve(/** @type {string} */ (flags.dest));
	logInfo("mirroring tenant", {
		base: tenant.base,
		org: tenant.org,
		dest,
		transport: flags.transport,
	});
	if (flags.list) {
		logInfo("list-only: no git writes");
	}
	logInfo("mirroring from manifest", { manifest: flags.manifest });
	const rows = extractRepos(doc);
	logInfo("repositories loaded", { rows: rows.length });
	if (rows.length === 0) {
		die(1, "manifest has no repositories");
	}

	const only = flags.only ? caseGlob(flags.only) : null;
	let ok = 0;
	let failed = 0;
	let streak = 0;
	/** @param {boolean} success */
	const noteResult = async (success) => {
		if (success) {
			streak = 0;
			return;
		}
		streak += 1;
		if (streak < POLICY.failStreak) {
			return;
		}
		logWarn("consecutive failures — cooling down", {
			streak,
			cooldown: flags.cooldown,
			cause: "likely rate limited",
		});
		await sleepSeconds(flags.cooldown ?? POLICY.cooldown);
		streak = 0;
	};

	for (const raw of rows) {
		if (!raw.repo) {
			continue;
		}
		const repo = raw.repo.replace(/\.git$/, "");
		let slug = raw.projectSlug;
		if (!slug && raw.projectId) {
			slug = slugFromProjectId(raw.projectId, tenant.org);
		}
		slug ||= "unknown";
		const identity = `${tenant.org}/${slug}/${repo}`;
		if (only && !only(identity)) {
			continue;
		}
		const url = cloneUrl({ ...raw, repo }, tenant);
		if (flags.list) {
			// The payload stream: stdout carries the TSV rows, logs go to stderr
			// (docs/d045), so `... --list > repos.tsv` is unambiguous.
			process.stdout.write(`${identity}\t${url}\n`);
			continue;
		}
		const target = join(dest, tenant.org, slug, `${repo}.git`);
		const mirrored = await mirrorOne(url, target);
		if (mirrored) {
			ok += 1;
		} else {
			failed += 1;
		}
		await noteResult(mirrored);
		// Gentle pacing: a bulk mirror is what earns the rate limit in the
		// first place.
		await pace(flags.throttle ?? POLICY.throttle);
	}

	if (flags.list) {
		return;
	}
	logInfo("summary", { mirrored: ok, failed });
	// A half-worked sweep is a failure to a cron wrapper, so the status has to
	// say so (the shell's `[ "$FAILED" -eq 0 ]` exit).
	process.exitCode = failed === 0 ? 0 : 1;
}

setLogTool("git/-vbs-mirror-all");
await runEntry("vbs-mirror-all", main);
