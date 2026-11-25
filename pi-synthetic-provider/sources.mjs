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
 * — `NODE_USE_ENV_PROXY=1` is set for every generator run (the repo root's
 * `node-run.sh`) and in the coding-agent image, and `coding-agent/run.sh`
 * forwards `HTTP(S)_PROXY` (docs/d074) — so the third-generation tunnel
 * carries the request with no client-side routing code at all. That is why there is no
 * `REVERSE_PROXY_BASE_URLS`/relay-candidate handling here: this folder is not a
 * third hand-rolled client of the proxy.
 *
 * Contracts:
 *   - `fetchListing` is the ONLY network call. It takes an injectable fetch so
 *     tests exercise the parse and the shaping with no network, and no
 *     environment variable exists to redirect it.
 *   - A failure THROWS. There is no stale-copy fallback because there is no
 *     second copy: the committed artifact is the fallback for a host that
 *     cannot reach the network, and the generator's atomic write (in this
 *     folder's `generate.mjs`) means a failed run leaves it untouched.
 *   - The category tiers (`syn:*`) are an API contract, not catalog data: a
 *     listing that omits one fails the refresh rather than publishing a lineup
 *     with a hole (docs/d190).
 *
 * Env: nothing (docs/d113).
 */

/**
 * The provider facts this folder exists for (docs/d024): the ONE place the
 * upstream URL and the key env are declared, and the source of the canonical
 * URL committed artifacts carry (docs/d070).
 *
 * A frozen literal rather than a loaded fact table: an extension serves
 * exactly one provider, so a row here cannot be missing and nothing has to
 * guard for that. `support` is docs/d064's tier for this row — how much
 * lineup/liveness work the generators do for it — carried with the data so
 * the folder still states it. (The fact table's per-row `note` is not carried:
 * it argued for the multi-catalog cascade this folder deleted in docs/d096.)
 * @type {Readonly<{
 *   id: string,
 *   label: string,
 *   apiKeyEnv: string,
 *   baseUrl: string,
 *   support: string,
 * }>}
 */
export const SYNTHETIC = Object.freeze({
	id: "synthetic",
	label: "Synthetic",
	apiKeyEnv: "SYNTHETIC_API_KEY",
	// The FULL base, path suffix included (docs/d027): the upstream serves its
	// OpenAI surface under /openai/v1, so no drift whitelist applies.
	baseUrl: "https://api.synthetic.new/openai/v1",
	support: "first-class",
});

/**
 * The upstream this unit uses (the base-url schema, coding-agent/DESIGN.md):
 * `<KEY>_BASE_URL` derived from the key env the way Azure OpenAI spells the
 * pair, absolute http(s) only, trailing slashes trimmed. Unset or empty keeps
 * the row's canonical URL. A malformed value throws at load: a loud extension
 * error beats silently using the upstream the operator did not choose.
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
	return override.replace(/\/+$/, "");
}

/** @type {string} this unit's effective upstream (the row's canonical by default). */
export const SYNTHETIC_BASE_URL = /** @type {string} */ (
	baseUrlFromEnv(SYNTHETIC.apiKeyEnv, SYNTHETIC.baseUrl, process.env)
);
/** @type {string} the env var holding the real key. */
export const SYNTHETIC_API_KEY_ENV = SYNTHETIC.apiKeyEnv;
/** @type {string} the provider id pi namespaces model ids under. */
export const SYNTHETIC_PROVIDER_ID = SYNTHETIC.id;

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The request signal: the CALLER's cancellation composed with this folder's own
 * deadline. Both, never either — `signal ?? AbortSignal.timeout(…)` was the
 * first shape here and it silently dropped the ceiling on every real refresh,
 * because pi always hands a concrete signal (pi-ai's RefreshModelsContext): a
 * revoked refresh then waited on an upstream that never answers, which is the
 * hang d045 says the step owning the I/O must report instead.
 * @param {AbortSignal} [caller] pi's signal, when the caller has one
 * @returns {AbortSignal}
 */
function requestSignal(caller) {
	return caller
		? AbortSignal.any([caller, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
		: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}
const MODEL_STORE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * The provider's CATEGORY TIERS: ids that never move while the model behind
 * them rotates ("the current best model for this category").
 *
 * This is the provider's API CONTRACT, not catalog data: a listing that omits
 * one is an endpoint fault the refresh refuses (docs/d190), so pi reports a
 * normal refresh error instead of advertising a lineup with a hole in it.
 * Nothing is invented to fill the gap.
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
 * `syn:*` rows are kept: they are the provider's contract tiers.
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

/**
 * @typedef {import("@earendil-works/pi-coding-agent").ProviderModelConfig} ProviderModelConfig
 * @typedef {Parameters<NonNullable<import("@earendil-works/pi-coding-agent").ProviderConfig["refreshModels"]>>[0]} RefreshModelsContext
 * @typedef {NonNullable<Parameters<RefreshModelsContext["publish"]>[0]["persist"]>} PersistedCatalog
 */

/**
 * The lineup pi stored for this provider on its last verified read, or
 * `undefined` when nothing usable is there.
 *
 * pi runs `refreshModels` twice per cycle: a cache-only phase (`allowNetwork:
 * false`) whose whole purpose is this restore, then the network phase this
 * folder's TTL gate guards (pi-ai's `Models.refresh` — the phase order is why
 * nothing needs re-publishing on the TTL path). The store is a file, so the
 * rows are re-narrowed to what a model list can render: a row without `input`
 * crashes pi's own `--list-models` formatter, and a row without an id names
 * nothing.
 * @param {RefreshModelsContext["stored"]} stored
 * @returns {ProviderModelConfig[]|undefined}
 */
export function storedLineup(stored) {
	const rows = stored?.models;
	if (!Array.isArray(rows)) {
		return;
	}
	const kept = rows.filter(
		(row) => typeof row?.id === "string" && Array.isArray(row.input),
	);
	return kept.length > 0
		? /** @type {ProviderModelConfig[]} */ (/** @type {unknown} */ (kept))
		: undefined;
}

/**
 * Store this provider's verified lineup so the next process has something to
 * serve during the cache-only phase (the d190 amendment).
 *
 * `checkedAt` is what `storeIsFresh` gates the next read on. The cast: pi types
 * a persisted row as its own `AnyModel`, while the payload stays this folder's
 * model config — the registration owns `api` and `baseUrl`, and both are
 * env-overridable, so a snapshot that froze them would keep sending requests to
 * an upstream the operator moved away from.
 * @param {RefreshModelsContext} context
 * @param {ProviderModelConfig[]} models
 * @returns {Promise<void>}
 */
export async function persistLineup(context, models) {
	await context.publish({
		persist: /** @type {PersistedCatalog} */ (
			/** @type {unknown} */ ({ models, checkedAt: Date.now() })
		),
	});
}
