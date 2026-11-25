/**
 * @fileoverview sources.mjs — THE one data source: the provider's own
 * `/provider` catalog document.
 *
 * Why one source (the pi-synthetic-provider verdict, docs/d096, applied to a provider
 * whose listing is just as authoritative): hyper's `/provider` endpoint
 * publishes the lineup, the metadata and the prices in ONE document, and the
 * fleet's own fetch of it (coding-agent, docs/d033/d057/d191)
 * is already the enrichment source for model-016. A second catalog (models.dev
 * carries hyper too) can only lag or contradict it — for the EXTENSION the
 * listing alone is the catalog, because pi does not build this provider in
 * and nothing else can supply the dialect.
 *
 * The route machinery never existed here. This reads the fact table's
 * CANONICAL upstream (docs/d070) directly and relies on the environment's
 * forward proxy — `NODE_USE_ENV_PROXY=1` is set for every generator run
 * (the repo root's `node-run.sh`) and `coding-agent/run.sh` forwards
 * `HTTP(S)_PROXY` (docs/d074) — so the third-generation tunnel carries the
 * request with no client-side routing code at all (docs/d100).
 *
 * Contracts:
 *   - `fetchCatalog` is the ONLY network call. It takes an injectable fetch
 *     so tests exercise the parse with no network, and no environment
 *     variable exists to redirect it.
 *   - A failure THROWS. There is no stale-copy branch: the committed
 *     artifact is the offline fallback, and the atomic writer (in this
 *     folder's `generate.mjs`) means a failed run leaves it untouched.
 *   - The listing is PUBLIC (verified: 200 unauthenticated). The bearer is
 *     sent when a key exists for parity with the fleet's facts refresh, not
 *     because the catalog needs it.
 *
 * Env: nothing (docs/d113).
 */

/**
 * The provider facts this folder exists for (docs/d024): the ONE place the
 * upstream URL and the key env are declared, and the source of the canonical
 * URL the committed artifact carries (docs/d070).
 *
 * A frozen literal rather than a loaded fact table: an extension serves
 * exactly one provider, so a row here cannot be missing and nothing has to
 * guard for that. `support` is docs/d064's tier for this row — how much
 * lineup/liveness work the generators do for it — carried with the data so
 * the folder still states it.
 * @type {Readonly<{
 *   id: string,
 *   label: string,
 *   apiKeyEnv: string,
 *   baseUrl: string,
 *   support: string,
 * }>}
 */
export const HYPER = Object.freeze({
	id: "hyper",
	label: "Charm Hyper",
	apiKeyEnv: "HYPER_API_KEY",
	baseUrl: "https://hyper.charm.land/v1",
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
export const HYPER_BASE_URL = /** @type {string} */ (
	baseUrlFromEnv(HYPER.apiKeyEnv, HYPER.baseUrl, process.env)
);
/** @type {string} the env var holding the real key. */
export const HYPER_API_KEY_ENV = HYPER.apiKeyEnv;
/** @type {string} the provider id pi namespaces model ids under. */
export const HYPER_PROVIDER_ID = HYPER.id;

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
 *   pi-synthetic-provider/TODO.md)
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
	const res = await fetchImpl(url, {
		...(headers ? { headers } : {}),
		signal: requestSignal(signal),
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
