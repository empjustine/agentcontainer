/**
 * @fileoverview sources.mjs — THE one data source: the provider's own
 * `/models` listing.
 *
 * Why one source (the pi-synthetic verdict, docs/d096, applied here):
 * models.dev carries no verboo row at all (catalogOptional in the fleet,
 * docs/d057) — the listing was ALWAYS the only lineup there is, so the
 * extension reads it directly and nothing else. The fleet's facts cache of
 * it (coding-agent/verboo-facts.json) is the committed last-good snapshot
 * the same design already uses.
 *
 * The route machinery never existed here. This reads the fact-table row's
 * CANONICAL upstream (docs/d070) directly and relies on the environment's
 * forward proxy — `NODE_USE_ENV_PROXY=1` is set for every generator run by
 * the repo-root npm-run.sh wrapper and `coding-agent/run.sh` forwards
 * `HTTP(S)_PROXY` (docs/d074) — so the third-generation tunnel carries the
 * request with no client-side routing code at all (docs/d100).
 *
 * Contracts:
 *   - `fetchListing` is the ONLY network call. Injectable fetch for tests;
 *     no environment variable exists to redirect it.
 *   - A failure THROWS. The committed artifact is the offline fallback, and
 *     the generator's atomic writer means a failed run leaves it untouched.
 *   - The listing is AUTH-GATED (verified: 401 "missing or invalid token"
 *     without a key), so a regeneration needs `VERBOO_API_KEY` — unlike
 *     hyper, a keyless run cannot refresh the catalog, and the committed
 *     pair simply stands until a keyed one does.
 *   - No fetch URL is ever recorded (docs/d086).
 *
 * Env: nothing (docs/d113).
 */

import { logDebug, setLogTool } from "./log.mjs";

setLogTool("pi-verboo/sources");

/**
 * The fact-table row this folder exists for (docs/d024): the ONE place the
 * upstream URL and the key env are declared, and the source of the canonical
 * URL the committed artifact carries (docs/d070).
 *
 * Why a one-row literal instead of a shared table: the table used to be
 * repo-wide (docs/d024's one-edit law), but every consumer of it is now a
 * copy unit of its own — the coding-agent generators (all rows), estige (the
 * allowlist, in Go) and each pi-* extension (exactly one row each). A
 * one-row copy says what the extension actually depends on, and editing
 * another provider's row cannot break this one. `baseUrl` is the provider's
 * REAL endpoint: the upstream the deployed estige allowlist keys on (its
 * HOST — docs/d047), the URL committed artifacts embed verbatim (docs/d070),
 * and the source for the fact-table facts endpoint. The row-level WHY rides
 * the row as `note`, so the reasoning travels with the data.
 */
const VERBOO = Object.freeze({
	/** @type {string} the provider id pi namespaces model ids under. */
	id: "verboo",
	/** @type {string} human-readable name. */
	label: "Verboo",
	/**
	 * @type {string} env var holding the provider's real key, used for the
	 * facts-refresh bearer and the `${env.*}` reference emitted layers carry —
	 * never inlined into an emitted artifact.
	 */
	apiKeyEnv: "VERBOO_API_KEY",
	/** @type {string} the provider's canonical upstream (docs/d070). */
	baseUrl: "https://code.verboo.ai/router/v1",
	/** @type {string} docs/d064's promise for this row. */
	support: "first-class",
	note: "The FULL real base, path suffix included (docs/d027): the upstream serves its OpenAI surface under /router/v1, and the client route carries that path client-side (providerRouteUrl, docs/d047) — the allowlist row itself is the host root only. Also the ONE fact-table provider with no models.dev catalog row at all, and catwalk does not carry it either — the vendored catalog is replaced wholesale on every refresh, so a hand-added row would be transient (docs/d032 F1). Its lineup therefore comes from coding-agent/catalog-facts.mjs's cache of the provider's own `<base>/models` listing, which also makes this row the one whose baseUrl — not a catalog `api` — is the facts endpoint (catalogOptional, docs/d057).",
});

/** @type {string} the provider's canonical upstream. */
export const VERBOO_BASE_URL = VERBOO.baseUrl;
/** @type {string} the env var holding the real key. */
export const VERBOO_API_KEY_ENV = VERBOO.apiKeyEnv;
/** @type {string} the provider id pi namespaces model ids under. */
export const VERBOO_PROVIDER_ID = VERBOO.id;

const REQUEST_TIMEOUT_MS = 15_000;
const MODEL_STORE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * The model-listing URL — the canonical upstream plus the path the provider
 * serves its OpenAI-compatible listing under, derived in ONE place so the
 * generator and the extension cannot disagree about where the catalog lives.
 * @returns {string}
 */
export function listingUrl() {
	return `${VERBOO_BASE_URL}/models`;
}

/**
 * A row of the provider's listing, as far as this folder reads it. Every
 * field is optional except `id`: the provider may stop publishing any of
 * them and the shaping downstream degrades field by field rather than
 * throwing. `default_effort` is declared for shape honesty and deliberately
 * unread — pi's model shape has no home for a default effort (the
 * thinkingLevelMap is a level → wire-value map, not a default), so carrying
 * it would mean inventing one.
 * @typedef {object} ListingRow
 * @property {string} id
 * @property {number} [context_window]
 * @property {boolean} [vision]
 * @property {{ effort_levels?: string[], default_effort?: string }} [reasoning]
 *   the presence of the object itself is the reasoning declaration; its
 *   `effort_levels` is the published effort enum — the ONLY source of
 *   thinking levels
 */

/**
 * One listing fetch. Returns the RAW rows; all interpretation belongs to
 * merge.mjs, so a parse change is a shaping change in one place.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl] injected by tests
 * @param {string} [options.url] injected by tests
 * @returns {Promise<ListingRow[]>}
 * @throws {Error} on a transport failure, a non-2xx answer, or a payload
 *   with no usable rows — the caller has nothing to publish, and the
 *   committed artifact is the fallback rather than a silently stale
 *   regeneration
 */
export async function fetchListing({
	signal,
	fetchImpl = fetch,
	url = listingUrl(),
} = {}) {
	const key = process.env[VERBOO_API_KEY_ENV]?.trim();
	const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
	logDebug("fetching model listing", { url: VERBOO_BASE_URL });
	const res = await fetchImpl(url, {
		...(headers ? { headers } : {}),
		signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(
			`model listing answered ${res.status} — nothing to publish`,
		);
	}
	const payload = /** @type {unknown} */ (await res.json());
	// The provider serves the OpenAI shape ({data: [...]}); a bare array is
	// tolerated because OpenAI-compatible gateways do that, and accepting it
	// costs nothing.
	const payloadRows = Array.isArray(payload)
		? payload
		: Array.isArray(/** @type {{data?: unknown}} */ (payload)?.data)
			? /** @type {unknown[]} */ (
					/** @type {{data?: unknown}} */ (payload).data
				)
			: [];
	const rows = /** @type {{id?: unknown}[]} */ (payloadRows);
	/** @type {ListingRow[]} */
	const kept = [];
	for (const row of rows) {
		if (typeof row?.id !== "string") {
			continue;
		}
		kept.push(/** @type {ListingRow} */ (row));
	}
	if (kept.length === 0) {
		throw new Error("model listing carried no usable rows");
	}
	logDebug("model listing answered", { rows: kept.length });
	return kept;
}

/**
 * Whether a persisted model store is still inside the refresh TTL.
 * @param {number} checkedAt epoch ms of the stored catalog
 * @returns {boolean}
 */
export function storeIsFresh(checkedAt) {
	return Date.now() - checkedAt < MODEL_STORE_TTL_MS;
}
