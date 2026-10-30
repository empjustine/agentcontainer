/**
 * @fileoverview sources.mjs — THE one data source: the provider's own
 * `/provider` catalog document.
 *
 * Why one source (the pi-synthetic verdict, docs/d096, applied to a provider
 * whose listing is just as authoritative): hyper's `/provider` endpoint
 * publishes the lineup, the metadata and the prices in ONE document, and the
 * fleet's facts cache of it (coding-agent/hyper-facts.json, docs/d033/d057)
 * is already the enrichment source for model-016. A second catalog (models.dev
 * carries hyper too) can only lag or contradict it — for the EXTENSION the
 * listing alone is the catalog, because pi does not build this provider in
 * and nothing else can supply the dialect.
 *
 * The route machinery never existed here. This reads the fact table's
 * CANONICAL upstream (docs/d070) directly and relies on the environment's
 * forward proxy — `NODE_USE_ENV_PROXY=1` is set for every generator run
 * (`lib/node-run.sh`) and `coding-agent/run.sh` forwards `HTTP(S)_PROXY`
 * (docs/d074) — so the third-generation tunnel carries the request with no
 * client-side routing code at all (docs/d100).
 *
 * Contracts:
 *   - `fetchCatalog` is the ONLY network call. It takes an injectable fetch
 *     so tests exercise the parse with no network, and no environment
 *     variable exists to redirect it.
 *   - A failure THROWS. There is no stale-copy branch: the committed
 *     artifact is the offline fallback, and the atomic writer
 *     (`lib/artifact.mjs`) means a failed run leaves it untouched.
 *   - The listing is PUBLIC (verified: 200 unauthenticated). The bearer is
 *     sent when a key exists for parity with the fleet's facts refresh, not
 *     because the catalog needs it.
 *   - No fetch URL is ever recorded (docs/d086).
 *
 * Env: LIB_DIR (lib/ resolution override, docs/d023). Nothing else.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");

const { logDebug, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);

setLogTool("pi-hyper/sources");

/**
 * The fact-table row this folder exists for (lib/cloud-providers.mjs,
 * docs/d024): the ONE place the upstream URL and the key env are declared,
 * and the source of the canonical URL the committed artifact carries
 * (docs/d070).
 */
const HYPER = CLOUD_PROVIDERS.hyper;

/** @type {string} the provider's canonical upstream. */
export const HYPER_BASE_URL = HYPER.baseUrl;
/** @type {string} the env var holding the real key. */
export const HYPER_API_KEY_ENV = HYPER.apiKeyEnv;
/** @type {string} the provider id pi namespaces model ids under. */
export const HYPER_PROVIDER_ID = HYPER.id;

const REQUEST_TIMEOUT_MS = 15_000;
const MODEL_STORE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * The catalog URL — the canonical upstream plus the path the provider serves
 * its self-description under, derived in ONE place so the generator and the
 * extension cannot disagree about where the catalog lives.
 * @returns {string}
 */
export function catalogUrl() {
	return `${HYPER_BASE_URL}/provider`;
}

/**
 * One model record of the provider's `/provider` document — the subset this
 * folder reads. Every field except `id` is optional: the provider may stop
 * publishing any of them and the shaping downstream degrades field by field
 * rather than throwing.
 * @typedef {object} CatalogRecord
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [can_reason]
 * @property {string[]} [reasoning_levels] the published effort enum — the
 *   ONLY source of thinking levels
 * @property {boolean} [supports_attachments]
 * @property {number} [context_window]
 * @property {number} [default_max_tokens]
 * @property {number} [cost_per_1m_in]
 * @property {number} [cost_per_1m_out]
 * @property {number} [cost_per_1m_in_cached] cached-input price (cache WRITE
 *   on pi's side — the pairing verified against catwalk's own schema,
 *   pi-synthetic/TODO.md)
 * @property {number} [cost_per_1m_out_cached] cached-output price (cache
 *   READ on pi's side)
 */

/**
 * One catalog fetch. Returns the RAW `models` records; all interpretation
 * belongs to merge.mjs, so a parse change is a shaping change in one place.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl] injected by tests
 * @param {string} [options.url] injected by tests
 * @returns {Promise<CatalogRecord[]>}
 * @throws {Error} on a transport failure, a non-2xx answer, or a document
 *   with no usable model rows — the caller has nothing to publish, and the
 *   committed artifact is the fallback rather than a silently stale
 *   regeneration
 */
export async function fetchCatalog({
	signal,
	fetchImpl = fetch,
	url = catalogUrl(),
} = {}) {
	const key = process.env[HYPER_API_KEY_ENV]?.trim();
	const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
	logDebug("fetching provider catalog", { url: HYPER_BASE_URL });
	const res = await fetchImpl(url, {
		headers,
		signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(
			`provider catalog answered ${res.status} — nothing to publish`,
		);
	}
	const payload = /** @type {unknown} */ (await res.json());
	// The document is a provider self-description whose `models` member holds
	// the catalog; a bare array is tolerated because the surrounding fields
	// (name, api_endpoint, ...) are upstream identity this folder never reads.
	const payloadRows = Array.isArray(payload)
		? payload
		: Array.isArray(/** @type {{models?: unknown}} */ (payload)?.models)
			? /** @type {unknown[]} */ (
					/** @type {{models?: unknown}} */ (payload).models
				)
			: [];
	const rows = /** @type {{id?: unknown}[]} */ (payloadRows);
	/** @type {CatalogRecord[]} */
	const kept = [];
	for (const row of rows) {
		if (typeof row?.id !== "string") {
			continue;
		}
		kept.push(/** @type {CatalogRecord} */ (row));
	}
	if (kept.length === 0) {
		throw new Error("provider catalog carried no usable rows");
	}
	logDebug("provider catalog answered", { rows: kept.length });
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
