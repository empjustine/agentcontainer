/**
 * @fileoverview sources.mjs — THE one data source: the provider's own
 * `/v1/models` listing, plus the one-row fact table that says where it lives
 * and which key env it reads.
 *
 * Why one source (docs/d096/d057 applied here): the listing publishes the
 * lineup, prices, limits, modalities and the reasoning contract, so it is also
 * the only place any of those may come from — models.dev is not consulted
 * (d191's no-catalog rule) and no fact cache is kept.
 *
 * The route machinery never existed here. This reads the canonical upstream
 * (docs/d070) directly and relies on the environment's forward proxy
 * (`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY`, docs/d074).
 *
 * Contracts:
 *   - `fetchListing` is the ONLY network call. Injectable fetch for tests; no
 *     environment variable redirects it beyond the base-url pair below.
 *   - A failure THROWS. There is no committed fallback: an unreadable source
 *     means this provider cannot say what it serves today (docs/d190).
 *   - The listing is documented public and keyless ("a missing key degrades to
 *     a shorter list rather than an error"), so the bearer is optional: when
 *     `NEURALWATT_API_KEY` is set the customer catalog comes back, otherwise
 *     the public one. Acting on the returned `scope` is an open item, not a
 *     rule this file invents.
 *
 * Env: `NEURALWATT_API_KEY` (optional here, mandatory at request time — pi
 * resolves `$NEURALWATT_API_KEY` for the provider) and
 * `NEURALWATT_BASE_URL` (optional upstream override).
 */

import { logDebug, setLogTool } from "./log.mjs";

setLogTool("pi-neuralwatt/sources");

/**
 * The fact-table row this folder exists for (docs/d024): the ONE place the
 * upstream URL and the key env are declared. A one-row literal rather than a
 * shared table, because every consumer is a copy unit of its own (docs/d113)
 * and this folder depends on exactly this row.
 *
 * No `support` tier: the fleet has no neuralwatt row, so there is no d064
 * promise to restate — this folder is a pi package, not a fleet provider.
 */
const NEURALWATT = Object.freeze({
	/** @type {string} the vendor the provider ids namespace under. */
	id: "neuralwatt",
	/** @type {string} human-readable name. */
	label: "Neuralwatt",
	/**
	 * @type {string} env var holding the real key — pi reads it for requests,
	 * and this file reads it once for the listing's optional bearer; never
	 * inlined, never logged (docs/d086).
	 */
	apiKeyEnv: "NEURALWATT_API_KEY",
	/** @type {string} the provider's canonical upstream (docs/d070). */
	baseUrl: "https://api.neuralwatt.com/v1",
	note: "Two providers, one vendor and one key (docs/d100's two-registration shape, the pi-opencode precedent): neuralwatt-flex serves the same models at the Flex tier, neuralwatt-standard at the standard tier. /v1/models is public and keyless; the docs' own pi page configures pi against api.neuralwatt.com/v1 with NEURALWATT_API_KEY and requires supportsDeveloperRole: false.",
});

/**
 * The two provider ids pi namespaces model ids under. Symmetric on purpose:
 * the same model id appears under both, so switching tier keeps the wire model
 * name — and therefore the server-side prefix cache — unchanged.
 * @type {Readonly<{flex: string, standard: string}>}
 */
export const PROVIDER_IDS = Object.freeze({
	flex: `${NEURALWATT.id}-flex`,
	standard: `${NEURALWATT.id}-standard`,
});

/**
 * The upstream this unit uses: `<KEY>_BASE_URL` derived from the key env the
 * way Azure OpenAI spells the pair, absolute http(s) only, trailing slashes
 * trimmed. Unset or empty keeps the row's canonical URL. A malformed value
 * throws at load: a loud extension error beats silently using an upstream the
 * operator did not choose.
 * @param {string} apiKeyEnv
 * @param {string|undefined} canonical
 * @param {Record<string, string|undefined>} env
 * @returns {string|undefined}
 */
export function baseUrlFromEnv(apiKeyEnv, canonical, env) {
	const name = apiKeyEnv.endsWith("_API_KEY")
		? `${apiKeyEnv.slice(0, -"_API_KEY".length)}_BASE_URL`
		: null;
	const override = name === null ? undefined : env[name]?.trim();
	if (!override) {
		return canonical;
	}
	let protocol;
	try {
		protocol = new URL(override).protocol;
	} catch {
		protocol = "";
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`${name} is not an absolute http(s) URL: ${override}`);
	}
	return override.replace(/\/+$/u, "");
}

/** @type {string} this unit's effective upstream (the row's canonical by default). */
export const NEURALWATT_BASE_URL = /** @type {string} */ (
	baseUrlFromEnv(NEURALWATT.apiKeyEnv, NEURALWATT.baseUrl, process.env)
);
/** @type {string} the env var holding the real key. */
export const NEURALWATT_API_KEY_ENV = NEURALWATT.apiKeyEnv;

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The request signal: the CALLER's cancellation composed with this folder's
 * deadline. Both, never either — pi always hands a concrete signal, so
 * `signal ?? timeout` would silently drop the ceiling (docs/d045).
 * @param {AbortSignal} [caller]
 * @returns {AbortSignal}
 */
function requestSignal(caller) {
	return caller
		? AbortSignal.any([caller, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
		: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

const MODEL_STORE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * One listing row, as far as this folder reads it. Everything is optional but
 * `id`: a published field can disappear without the register failing, and the
 * shaping degrades field by field (merge.mjs decides what an absent field
 * means).
 *
 * @typedef {object} ListingPricing
 * @property {number|null} [input_per_million]
 * @property {number|null} [output_per_million]
 * @property {number|null} [cached_input_per_million]
 * @property {boolean} [pricing_tbd]
 * @property {"standard"|"flex"} [service_tier]
 * @property {number|null} [flex_discount_multiplier]
 *
 * @typedef {object} ListingCapabilities
 * @property {boolean} [vision]
 * @property {boolean} [reasoning]
 * @property {boolean} [reasoning_effort]
 * @property {boolean} [developer_role]
 * @property {string} [task]
 *
 * @typedef {object} ListingReasoning
 * @property {boolean} [mandatory]
 * @property {string[]} [supported_efforts]
 * @property {string[]} [accepted_efforts]
 * @property {Record<string, string>} [effort_aliases]
 *
 * @typedef {object} ListingLimits
 * @property {number|null} [max_context_length]
 * @property {number|null} [max_output_tokens]
 * @property {number|null} [max_images]
 * @property {number|null} [max_images_total]
 *
 * @typedef {object} ListingMetadata
 * @property {string} [display_name]
 * @property {string|null} [huggingface_id]
 * @property {boolean} [deprecated]
 * @property {ListingPricing} [pricing]
 * @property {ListingCapabilities} [capabilities]
 * @property {ListingReasoning|null} [reasoning]
 * @property {ListingLimits} [limits]
 *
 * @typedef {object} ListingRow
 * @property {string} id
 * @property {number} [max_model_len]
 * @property {{ input_modalities?: string[] }} [architecture]
 * @property {ListingMetadata} [metadata]
 */

/**
 * The listing URL — canonical upstream plus the path the OpenAI surface is
 * served under, derived in ONE place.
 * @returns {string}
 */
export function listingUrl() {
	return `${NEURALWATT_BASE_URL}/models`;
}

/**
 * One listing fetch, returning the RAW rows: interpretation belongs to
 * merge.mjs, so a parse change is a shaping change in one place.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl] injected by tests
 * @param {string} [options.url] injected by tests
 * @returns {Promise<ListingRow[]>}
 * @throws {Error} on a transport failure, a non-2xx answer, or a payload with
 *   no usable rows — the caller has nothing to publish (docs/d190)
 */
export async function fetchListing({
	signal,
	fetchImpl = fetch,
	url = listingUrl(),
} = {}) {
	const key = process.env[NEURALWATT.apiKeyEnv]?.trim();
	const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
	logDebug("fetching model listing", { url: NEURALWATT_BASE_URL });
	const res = await fetchImpl(url, {
		...(headers ? { headers } : {}),
		signal: requestSignal(signal),
	});
	if (!res.ok) {
		throw new Error(
			`model listing answered ${res.status} — nothing to publish`,
		);
	}
	const payload = /** @type {unknown} */ (await res.json());
	const payloadRows = Array.isArray(payload)
		? payload
		: Array.isArray(/** @type {{data?: unknown}} */ (payload)?.data)
			? /** @type {unknown[]} */ (
					/** @type {{data?: unknown}} */ (payload).data
				)
			: [];
	/** @type {ListingRow[]} */
	const kept = [];
	for (const row of payloadRows) {
		const candidate = /** @type {{id?: unknown}} */ (row);
		if (typeof candidate?.id !== "string") {
			continue;
		}
		kept.push(/** @type {ListingRow} */ (candidate));
	}
	if (kept.length === 0) {
		throw new Error("model listing carried no usable rows");
	}
	logDebug("model listing answered", { rows: kept.length });
	return kept;
}

/**
 * Whether a persisted model store is still inside the refresh TTL — the gate
 * that keeps a model-selector open from re-fetching, not a remembered lineup
 * (docs/d190: nothing is registered or committed, and an unreadable source
 * still throws).
 * @param {number} checkedAt epoch ms of the stored catalog
 * @returns {boolean}
 */
export function storeIsFresh(checkedAt) {
	return Date.now() - checkedAt < MODEL_STORE_TTL_MS;
}
