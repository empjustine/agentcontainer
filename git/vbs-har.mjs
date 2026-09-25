/**
 * @fileoverview vbs-har.mjs — build a mirror manifest from a captured Visual
 * Builder Studio (VBS) HAR export — the
 * working extraction path (docs/d044). A HAR exported with response bodies
 * needs no live session, no CSRF, and no rolling-token dance, because the app
 * already made every authenticated call.
 *
 * The HAR carries two bodies that matter:
 *   POST /{org}/api2/v2/projects/list           -> array of projects
 *   GET  /{org}/s2/{projectId}/scm/api/repository -> {"scmRepositoryList":[…]}
 *
 * Fields are the tenant's own, verified against a real capture: a project is
 * keyed by `identifier` (id) / `urlId` (slug) / `name`; a repository carries
 * `name` (with `.git`), `url` (https clone) and `alternateUrl` (ssh clone,
 * WITHOUT a userinfo — the shell half injects VBS_SSH_USER).
 *
 * Output is the manifest schema `./git/-vbs-mirror-all.sh --manifest FILE`
 * consumes. Projects the capture never opened are listed under
 * `missingProjects` (ignored by the shell) so the gap is explicit rather than
 * silent.
 *
 * Usage:
 *   ./git/vbs-har.sh <har-file> [--out manifest.json] [--base URL] [--org ORG]
 */

import { readFileSync, writeFileSync } from "node:fs";

import { logError, logInfo, setLogTool } from "./git-lib.mjs";

setLogTool("git/vbs-har");

/**
 * Accept the envelope shapes these endpoints use (bare array, named lists,
 * name-keyed map) without assuming any one.
 * @param {unknown} data
 * @returns {Record<string, unknown>[]}
 */
function asArray(data) {
	if (Array.isArray(data)) return data;
	if (data && typeof data === "object") {
		const obj = /** @type {Record<string, unknown>} */ (data);
		for (const key of [
			"scmRepositoryList",
			"items",
			"projects",
			"repositories",
			"repository",
			"data",
			"rows",
		]) {
			if (Array.isArray(obj[key])) {
				return /** @type {Record<string, unknown>[]} */ (obj[key]);
			}
		}
		const entries = Object.entries(obj);
		if (
			entries.length &&
			entries.every(([, v]) => v && typeof v === "object")
		) {
			return entries.map(([key, value]) => ({
				__key: key,
				.../** @type {Record<string, unknown>} */ (value),
			}));
		}
	}
	return [];
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {string}
 */
function pick(obj, ...keys) {
	for (const key of keys) {
		const value = obj?.[key];
		if (value !== undefined && value !== null && value !== "") {
			return String(value);
		}
	}
	return "";
}

/**
 * `identifier` is `<org>_<slug>_<numeric>`; the glass directory is the slug.
 * @param {string} id
 * @param {string} org
 * @returns {string}
 */
function slugFromId(id, org) {
	if (!id) return "";
	const rest = id.startsWith(`${org}_`) ? id.slice(org.length + 1) : id;
	const match = /^(.*)_\d+$/.exec(rest);
	return match ? match[1] : rest;
}

/**
 * @typedef {object} HarManifestOptions
 * @property {string} [base]
 * @property {string} [org]
 */

/**
 * @typedef {object} HarEntry
 * @property {{ url?: string }} [request]
 * @property {{ content?: { text?: string, encoding?: string } }} [response]
 */

/**
 * @typedef {object} Har
 * @property {{ entries?: HarEntry[] }} [log]
 */

/**
 * Turn a HAR into the mirror manifest (and the list of projects whose repo
 * list the capture never contained).
 * @param {Har} har
 * @param {HarManifestOptions} [opts]
 * @returns {{
 *   generatedAt: string, base: string, org: string, projects: number,
 *   repositories: object[], missingProjects: object[]
 * }}
 */
export function harToManifest(har, opts = {}) {
	const entries = har?.log?.entries ?? [];
	/** @type {Record<string, unknown>[]|null} */
	let projects = null;
	let base = null;
	let org = null;
	/** @type {Map<string, unknown>} */
	const repoBodies = new Map();

	for (const entry of entries) {
		const url = entry?.request?.url ?? "";
		if (!base) {
			const match = /^(https?:\/\/[^/]+)\/([^/]+)\//.exec(url);
			if (match) {
				base = match[1];
				org = match[2];
			}
		}
		const content = entry?.response?.content ?? {};
		let text = content.text;
		if (typeof text !== "string") continue;
		if (content.encoding === "base64") {
			text = Buffer.from(text, "base64").toString("utf8");
		}
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			continue;
		}
		if (/\/api2\/v2\/projects\/list/.test(url)) {
			const list = asArray(data);
			if (list.length) projects = list;
		}
		const match = /\/s2\/([^/]+)\/scm\/api\/repository/.exec(url);
		if (match) repoBodies.set(decodeURIComponent(match[1]), data);
	}

	const resolvedOrg = opts.org || org || "";
	const projectList = /** @type {{id:string,slug:string,name:string}[]} */ (
		(projects ?? [])
			.map((project) => {
				const id = pick(
					project,
					"identifier",
					"id",
					"projectId",
					"projectGuid",
					"uuid",
					"__key",
				);
				return {
					id: id,
					slug:
						pick(project, "urlId", "slug", "projectSlug", "key") ||
						slugFromId(id, resolvedOrg),
					name: pick(project, "name", "displayName", "projectName"),
				};
			})
			.filter((project) => project.id)
	);
	if (!projectList.length) {
		for (const id of repoBodies.keys()) {
			projectList.push({
				id: id,
				slug: slugFromId(id, resolvedOrg),
				name: "",
			});
		}
	}

	/** @type {object[]} */
	const repositories = [];
	/** @type {object[]} */
	const missingProjects = [];
	for (const project of projectList) {
		const body = repoBodies.get(project.id);
		if (body === undefined) {
			missingProjects.push({
				projectId: project.id,
				projectSlug: project.slug,
				projectName: project.name,
			});
			continue;
		}
		for (const repo of asArray(body)) {
			const name = pick(
				repo,
				"name",
				"repoName",
				"repositoryName",
				"displayName",
				"id",
				"repo",
				"__key",
			);
			if (!name) continue;
			repositories.push({
				projectId: project.id,
				projectSlug: project.slug,
				projectName: project.name,
				repo: name.replace(/\.git$/, ""),
				httpsUrl: pick(
					repo,
					"url",
					"httpUrl",
					"httpsUrl",
					"httpCloneUrl",
					"cloneUrl",
				),
				sshUrl: pick(repo, "alternateUrl", "sshUrl", "sshCloneUrl"),
			});
		}
	}

	return {
		generatedAt: new Date().toISOString(),
		base: opts.base || base || "",
		org: resolvedOrg,
		projects: projectList.length,
		repositories: repositories,
		missingProjects: missingProjects,
	};
}

/**
 * @param {string[]} argv
 * @returns {{ file: string, out: string, base: string, org: string, help: boolean }}
 */
function parseArgs(argv) {
	const o = { file: "", out: "", base: "", org: "", help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		switch (a) {
			case "--out":
				o.out = /** @type {string} */ (argv[++i]);
				break;
			case "--base":
				o.base = /** @type {string} */ (argv[++i]);
				break;
			case "--org":
				o.org = /** @type {string} */ (argv[++i]);
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
				o.file = a;
		}
	}
	return o;
}

/** @returns {void} */
function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"usage: ./git/vbs-har.sh <har-file> [--out manifest.json] [--base URL] [--org ORG]\n",
		);
		return;
	}
	if (!o.file) throw new Error("no HAR file given (try --help)");

	const har = /** @type {Har} */ (JSON.parse(readFileSync(o.file, "utf8")));
	const manifest = harToManifest(har, { base: o.base, org: o.org });
	const text = `${JSON.stringify(manifest, null, 2)}\n`;

	if (o.out) {
		writeFileSync(o.out, text);
		logInfo("manifest written", {
			out: o.out,
			repositories: manifest.repositories.length,
		});
	} else {
		process.stdout.write(text);
	}
	logInfo("har summary", {
		base: manifest.base,
		org: manifest.org,
		projects: manifest.projects,
		repositories: manifest.repositories.length,
		missingProjects: manifest.missingProjects.length,
	});
}

try {
	main();
} catch (err) {
	logError("vbs-har aborted", {
		error: err,
	});
	process.exit(1);
}
