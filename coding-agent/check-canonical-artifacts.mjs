/**
 * @fileoverview check-canonical-artifacts.mjs — the URL-form verifier for the
 * artifacts this repo installs and commits: every provider URL must be the
 * fact-table upstream for its provider id (docs/d070), never a client route.
 *
 * WHY one direction is enough: the reverse proxy that made "installed form
 * differs from committed form" possible is deprecated as insecure
 * (docs/d108), so artifacts carry the real upstream and reachability is the
 * environment proxy's job (NODE_USE_ENV_PROXY + HTTP(S)_PROXY, docs/d074).
 * A route-form URL left behind by an older generation is now a dead endpoint
 * — which is exactly what this check catches: at launch over the agent dir's
 * models.json (the launcher) and in tests over the committed snapshots.
 *
 * The check is structural and keyed by provider id through the fact table —
 * never substring guesses over the file (docs/d070 Verification). Exit 0 =
 * every URL conforming; exit 1 = violations listed on stderr (one per line).
 *
 * Accepts both artifact shapes: pi's `{ providers: { <id>: { baseUrl } } }`
 * and opencode's `{ provider: { <id>: { options: { baseURL } } } }`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "lib");
const { CLOUD_PROVIDERS, FACT_HOSTS } =
	/** @type {typeof import("./lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);

/**
 * True when any path segment of `url` is a fact-table upstream host — the
 * fingerprint of the retired d047 route form, which spelled the destination
 * as `<base>/<upstream-host>/…`. Needed because one route is otherwise
 * INDISTINGUISHABLE from a canonical URL: the bazzite funnel's host IS the
 * llama-swap fact host, so `https://bazzite…/<mount>/bazzite…/v1` still
 * starts with the fact upstream at a path boundary (docs/d070
 * Consequences).
 * @param {string} url
 * @returns {boolean}
 */
function carriesFactHostSegment(url) {
	try {
		return new URL(url).pathname.split("/").some((seg) => FACT_HOSTS.has(seg));
	} catch {
		return false;
	}
}

/**
 * opencode's one provider-id alias — the only artifact-side name that does not
 * match the fact table: its config calls the local farm `local`, the table
 * calls it `llama-swap`.
 * @type {Readonly<Record<string, string>>}
 */
export const OPENCODE_PROVIDER_FACT_IDS = Object.freeze({
	local: "llama-swap",
});

/**
 * One provider's URL from either artifact shape.
 * @typedef {object} ProviderUrl
 * @property {string} id provider key as the artifact spells it
 * @property {string} [url] the provider's URL, when present
 */

/**
 * Extract `{id, url}` entries from a pi or opencode artifact document.
 * @param {unknown} doc
 * @returns {ProviderUrl[]}
 */
export function providerUrlsOf(doc) {
	const d = /** @type {any} */ (doc) ?? {};
	if (d.providers && typeof d.providers === "object") {
		return Object.entries(d.providers).map(([id, p]) => ({
			id,
			url: /** @type {any} */ (p)?.baseUrl,
		}));
	}
	if (d.provider && typeof d.provider === "object") {
		return Object.entries(d.provider).map(([id, p]) => ({
			id,
			url: /** @type {any} */ (p)?.options?.baseURL,
		}));
	}
	return [];
}

/**
 * Report every URL that is NOT the fact-table upstream for its id (an
 * optional client suffix such as llama-swap's `/v1` is part of the canonical
 * form). An id unknown to the fact table is a violation: artifacts and the
 * table must agree, so a rename on either side fails loudly instead of
 * shipping a URL nobody verified.
 * @param {unknown} doc parsed artifact
 * @returns {readonly string[]} human-readable violations; empty = conforming
 */
export function canonicalViolations(doc) {
	const out = [];
	for (const { id, url } of providerUrlsOf(doc)) {
		if (url === undefined) {
			continue;
		}
		const factId = OPENCODE_PROVIDER_FACT_IDS[id] ?? id;
		const upstream = CLOUD_PROVIDERS[factId]?.baseUrl;
		if (!upstream) {
			out.push(`${id}: no fact-table upstream (docs/d070)`);
			continue;
		}
		if (!url.startsWith(upstream)) {
			out.push(`${id}: not the fact-table upstream ${upstream}: ${url}`);
			continue;
		}
		const suffix = url.slice(upstream.length);
		if (suffix !== "" && !suffix.startsWith("/")) {
			out.push(`${id}: upstream prefix not at a path boundary: ${url}`);
			continue;
		}
		if (carriesFactHostSegment(url)) {
			out.push(
				`${id}: carries a fact-table host as a path segment (the retired d047 route form, docs/d108): ${url}`,
			);
		}
	}
	return out;
}

/**
 * The `node check-canonical-artifacts.mjs <file>` entry. Only reached when
 * this file IS the process entry point: the detector is also imported
 * in-process (tests/artifact-urls.test.mjs), and an unguarded top-level
 * dispatch would parse THEIR argv and could exit out of their middle.
 * @param {string[]} args argv after the script path
 * @returns {void}
 */
function main(args) {
	const path = args[0];
	if (path === undefined) {
		console.error("usage: check-canonical-artifacts.mjs <models-or-opencode-file>");
		process.exit(2);
	}
	/** @type {readonly string[]} */
	let violations = [];
	try {
		violations = canonicalViolations(JSON.parse(readFileSync(path, "utf-8")));
	} catch (err) {
		violations = [`unreadable or invalid JSON: ${String(err)}`];
	}
	if (violations.length > 0) {
		for (const v of violations) {
			console.error(`${path}: ${v}`);
		}
		process.exit(1);
	}
	console.log(`${path}: canonical`);
	process.exit(0);
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	main(process.argv.slice(2));
}
