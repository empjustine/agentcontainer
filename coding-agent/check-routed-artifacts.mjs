/**
 * @fileoverview check-routed-artifacts.mjs — the d070 URL-form verifier, the
 * ONE implementation of "is this artifact in the right URL shape" for both
 * launch time and tests:
 *
 *   - `--installed <file>`: with the configured base known (`--base` or
 *     the vault env) every provider URL must live under it — anything else
 *     (including a fact-table upstream) is an artifact that escaped route
 *     substitution (d070 §5). Without a base it falls back to the
 *     upstream-prefix check, with one carve-out: the v2 route form always
 *     embeds the upstream host as a path segment, which is how a base whose
 *     HOST equals a fact row's host (the bazzite funnel and the bazzite
 *     llama-swap row) stays distinguishable from a canonical URL.
 *     run.sh runs this against the agent dir's models.json on every launch.
 *   - `--committed <file>`: every provider URL MUST be the fact-table
 *     upstream for its provider id (d070 §1 + Verification) — the static
 *     opposite direction, used by tests/artifact-urls.test.mjs over the
 *     committed artifacts.
 *
 * Both modes are exact structural checks keyed by provider id through the
 * fact table — never substring guesses over the file (d070 Verification).
 * Exit 0 = every URL conforming; exit 1 = violations listed on stderr.
 *
 * Accepts both artifact shapes: pi's `{ providers: { <id>: { baseUrl } } }`
 * and opencode's `{ provider: { <id>: { options: { baseURL } } } }`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { reverseProxyBaseUrls } from "./route-probe.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);

/**
 * opencode's one provider-id alias (same mapping generate.mjs substitutes
 * with): its config names the local farm `local`, the fact table
 * `llama-swap`.
 * @type {Readonly<Record<string, string>>}
 */
const OPENCODE_PROVIDER_FACT_IDS = Object.freeze({ local: "llama-swap" });

/** @type {readonly string[]} */
const FACT_UPSTREAMS = Object.freeze(
	Object.values(CLOUD_PROVIDERS).map((f) => f.baseUrl),
);

/**
 * The fact upstreams' hostnames — the v2 route form embeds the upstream
 * host as a path segment (`<base>/<host>/…`, docs/d047), so a matching
 * segment is the structural marker that a URL under a colliding base host
 * is routed, not canonical.
 * @type {ReadonlySet<string>}
 */
const FACT_HOSTS = new Set(
	FACT_UPSTREAMS.map((u) => new URL(u).host),
);

/**
 * True when any path segment of `url` is a fact-upstream hostname — the
 * v2 route marker described on FACT_HOSTS.
 * @param {string} url
 * @returns {boolean}
 */
function hasFactHostSegment(url) {
	try {
		return new URL(url)
			.pathname.split("/")
			.some((seg) => FACT_HOSTS.has(seg));
	} catch {
		return false;
	}
}

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
 * d070 §5, installed direction: report every provider URL that escaped
 * route substitution. With the configured base known, the rule is the
 * shape d070 §3 installs: under `<base>/` at a path boundary, everything
 * else flagged (a fact-table upstream is named in the message). Without a
 * base the check degrades to the upstream-prefix check — a URL starting
 * with a fact upstream at a path boundary is flagged UNLESS it carries the
 * v2 route marker (FACT_HOSTS): the bazzite funnel base shares its HOST
 * with the llama-swap fact row, so a bare prefix check would flag every
 * routed URL on that base. Non-URL values are violations either way — the
 * installed shape is exactly one form or the other.
 * @param {unknown} doc parsed installed artifact
 * @param {string} [base] the configured reverse-proxy base, when known
 * @returns {readonly string[]} human-readable violations; empty = conforming
 */
export function installedViolations(doc, base) {
	const out = [];
	for (const { id, url } of providerUrlsOf(doc)) {
		if (url === undefined) continue;
		try {
			new URL(url);
		} catch {
			out.push(`${id}: not a URL: ${JSON.stringify(url)}`);
			continue;
		}
		const canonical = FACT_UPSTREAMS.find(
			(upstream) => url === upstream || url.startsWith(`${upstream}/`),
		);
		if (base !== undefined) {
			if (!url.startsWith(`${base}/`)) {
				out.push(
					canonical !== undefined
						? `${id}: still carries canonical upstream ${canonical}: ${url}`
						: `${id}: not under the configured base ${base}: ${url}`,
				);
			}
			continue;
		}
		if (canonical !== undefined && !hasFactHostSegment(url)) {
			out.push(`${id}: still carries canonical upstream ${canonical}: ${url}`);
		}
	}
	return out;
}

/**
 * d070 §1, committed direction: report every URL that is NOT the
 * fact-table upstream for its id (an optional client suffix such as
 * llama-swap's `/v1` is part of the canonical form). An id unknown to the
 * fact table is a violation: artifacts and the table must agree.
 * @param {unknown} doc parsed committed artifact
 * @returns {readonly string[]} human-readable violations; empty = conforming
 */
export function committedViolations(doc) {
	const out = [];
	for (const { id, url } of providerUrlsOf(doc)) {
		if (url === undefined) continue;
		const factId = OPENCODE_PROVIDER_FACT_IDS[id] ?? id;
		const upstream = CLOUD_PROVIDERS[factId]?.baseUrl;
		if (!upstream) {
			out.push(`${id}: no fact-table upstream (docs/d070 §1)`);
			continue;
		}
		if (!url.startsWith(upstream)) {
			out.push(`${id}: not the fact-table upstream ${upstream}: ${url}`);
			continue;
		}
		const suffix = url.slice(upstream.length);
		if (suffix !== "" && !suffix.startsWith("/")) {
			out.push(`${id}: upstream prefix not at a path boundary: ${url}`);
		}
	}
	return out;
}

// --- CLI ---------------------------------------------------------------------
const args = process.argv.slice(2);
/**
 * The first configured base for `--installed` without `--base` — the
 * SHARED env reader (route-probe.mjs), so this verifier applies the same
 * unusable-entry drop as generation and a degenerate base can never turn
 * the check into a `startsWith("https:/")` pass-everything.
 * @returns {string|undefined}
 */
function configuredBase() {
	return reverseProxyBaseUrls()[0];
}

if (args.length >= 2 && (args[0] === "--installed" || args[0] === "--committed")) {
	const mode = args[0];
	const path = args[1];
	// readonly: both detectors return the frozen no-assignment array they were
	// given (see their @returns) — widening it to a mutable type here would be
	// a promise no branch keeps.
	/** @type {readonly string[]} */
	let violations = [];
	try {
		const doc = JSON.parse(readFileSync(path, "utf-8"));
		if (mode === "--installed") {
			const flagBase = args.includes("--base")
				? args[args.indexOf("--base") + 1]
				: configuredBase();
			violations = installedViolations(doc, flagBase);
		} else {
			violations = committedViolations(doc);
		}
	} catch (err) {
		violations = [`unreadable or invalid JSON: ${String(err)}`];
	}
	if (violations.length) {
		for (const v of violations) console.error(`${mode} ${path}: ${v}`);
		process.exit(1);
	}
	console.log(`${mode} ${path}: conforming`);
	process.exit(0);
}
