/**
 * @fileoverview sources.mjs — THE one data source: the provider's own model
 * listing.
 *
 * Why one source and not three (docs/d096, and PENDING.md's measured finding):
 * a live listing and the two vendored catalogs (models.dev, catwalk) were
 * compared field by field, and the vendored rungs changed ZERO emitted values
 * while contributing four models the provider had already rotated away — and
 * omitting the `syn:*` tiers it does serve. A second catalog cannot make a
 * broken network work, and it silently made the committed artifact contradict
 * its own upstream. So the ladder is gone: the provider's `/models` response
 * is the lineup, the metadata, and the prices.
 *
 * The route machinery is gone with it. This reads the fact table's CANONICAL
 * upstream (docs/d070) directly and relies on the environment's forward proxy
 * — `NODE_USE_ENV_PROXY=1` is set for every generator run (`lib/node-run.sh`)
 * and in the coding-agent image, and `coding-agent/run.sh` forwards
 * `HTTP(S)_PROXY` (docs/d074) — so the third-generation tunnel carries the
 * request with no client-side routing code at all. That is why there is no
 * `REVERSE_PROXY_BASE_URLS`/relay-candidate handling here: this folder is not a
 * third hand-rolled client of the proxy.
 *
 * Contracts:
 *   - `fetchListing` is the ONLY network call. It takes an injectable fetch so
 *     tests exercise the parse and the shaping with no network, and no
 *     environment variable exists to redirect it.
 *   - A failure THROWS. There is no stale-copy fallback because there is no
 *     second copy: the committed artifact is the fallback for a host that
 *     cannot reach the network, and the generator's atomic write
 *     (`lib/artifact.mjs`) means a failed run leaves it untouched.
 *   - No fetch URL is ever recorded (docs/d086): the canonical upstream is not
 *     a secret, but logs that echo a URL are how a rotatable capability ends up
 *     in a log stream. Provenance is the source id and the row counts.
 *
 * Env: LIB_DIR (lib/ resolution override, docs/d023). Nothing else.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");

const { logDebug, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);

setLogTool("pi-synthetic/sources");

/**
 * The fact-table row this folder exists for (lib/cloud-providers.mjs,
 * docs/d024): the ONE place the upstream URL and the key env are declared, and
 * the source of the canonical URL committed artifacts carry (docs/d070).
 */
const SYNTHETIC = CLOUD_PROVIDERS.synthetic;

/** @type {string} the provider's canonical upstream. */
export const SYNTHETIC_BASE_URL = SYNTHETIC.baseUrl;
/** @type {string} the env var holding the real key. */
export const SYNTHETIC_API_KEY_ENV = SYNTHETIC.apiKeyEnv;
/** @type {string} the provider id pi namespaces model ids under. */
export const SYNTHETIC_PROVIDER_ID = SYNTHETIC.id;

const REQUEST_TIMEOUT_MS = 15_000;
const MODEL_STORE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * The provider's CATEGORY TIERS: ids that never move while the model behind
 * them rotates ("the current best model for this category").
 *
 * This is an API CONTRACT, not catalog data — but it is not injected into the
 * artifact either. The listing is the only source of truth, so a tier is
 * emitted when the provider serves it; these ids are here to NAME what is
 * missing when one goes absent, which turns a silent lineup regression into a
 * warning in the generation log. Nothing is invented to fill the gap.
 * @type {readonly string[]}
 */
export const ALIAS_TIER_IDS = Object.freeze([
	"syn:large:text",
	"syn:small:text",
	"syn:large:vision",
	"syn:small:vision",
]);

/**
 * The listing's own id families.
 *
 * `infinite:*` is a second routing family (the provider's print/mesh tiers)
 * that this OpenAI surface does not serve, so those rows are dropped.
 * `syn:*` rows are kept: they are the contract tiers above.
 * @type {readonly string[]}
 */
const UNSUPPORTED_ID_PREFIXES = Object.freeze(["infinite:"]);

/**
 * The model-listing URL — the canonical upstream plus the path the provider
 * serves its OpenAI-compatible listing under, derived in ONE place so the
 * generator and the extension cannot disagree about where the catalog lives.
 * @returns {string}
 */
export function listingUrl() {
	return `${SYNTHETIC_BASE_URL}/models`;
}

/**
 * A row of the provider's listing, as far as this folder reads it. Every field
 * is optional except `id`: the provider is free to stop publishing any of them
 * and the shaping downstream degrades field by field rather than throwing.
 * @typedef {object} ListingRow
 * @property {string} id
 * @property {string} [display_name]
 * @property {string} [hugging_face_id] the model this row SERVES, when the row
 *   is an alias for one (the `syn:*` tiers)
 * @property {string[]} [input_modalities]
 * @property {string[]} [output_modalities]
 * @property {number} [context_length]
 * @property {number} [max_output_length]
 * @property {string[]} [supported_features]
 * @property {{ efforts?: string[] }} [reasoning_parameters]
 * @property {Record<string, unknown>} [pricing]
 * @property {string} [alias_of] present on alias rows, but a display STRING
 *   ("DeepSeek V4.1 Flash 10/17") — it cannot name a catalog row, so nothing
 *   reads it. Declared so the fixture shape is honest about the wire.
 */

/**
 * One listing fetch. Returns the RAW rows (filtered to the supported id
 * families); all interpretation belongs to merge.mjs, so a parse change is a
 * shaping change in one place.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl] injected by tests
 * @param {string} [options.url] injected by tests
 * @returns {Promise<ListingRow[]>}
 * @throws {Error} on a transport failure, a non-2xx answer, or a payload with
 *   no usable rows — the caller has nothing to publish, and the committed
 *   artifact is the fallback rather than a silently stale regeneration
 */
export async function fetchListing({
	signal,
	fetchImpl = fetch,
	url = listingUrl(),
} = {}) {
	const key = process.env[SYNTHETIC_API_KEY_ENV]?.trim();
	const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
	logDebug("fetching model listing", { url: SYNTHETIC_BASE_URL });
	const res = await fetchImpl(url, {
		headers,
		signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(
			`model listing answered ${res.status} — nothing to publish`,
		);
	}
	const payload = /** @type {unknown} */ (await res.json());
	// The provider serves `{data: [...]}`; a bare array is tolerated because
	// OpenAI-compatible gateways do that, and the shape costs nothing to accept.
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
		const id = row?.id;
		if (typeof id !== "string") {
			continue;
		}
		if (UNSUPPORTED_ID_PREFIXES.some((p) => id.startsWith(p))) {
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
 * Warn about a contract tier the listing did not carry. The tiers are the one
 * family this folder makes a promise about, so their absence is worth a log
 * line — but it is a WARNING, not a failure and not an invented row: the
 * provider is the only source of truth here, and a tier it stops serving is a
 * tier this folder stops publishing.
 * @param {readonly string[]} ids every id in the shaped lineup
 * @returns {string[]} the missing tier ids (what was warned about)
 */
export function warnOnMissingTiers(ids) {
	const missing = ALIAS_TIER_IDS.filter((tier) => !ids.includes(tier));
	if (missing.length > 0) {
		logWarn("provider listing omitted a contract tier", { missing });
	}
	return missing;
}

/**
 * Whether a persisted model store is still inside the refresh TTL.
 * @param {number} checkedAt epoch ms of the stored catalog
 * @returns {boolean}
 */
export function storeIsFresh(checkedAt) {
	return Date.now() - checkedAt < MODEL_STORE_TTL_MS;
}
