/**
 * @fileoverview sources.mjs — THE one data source: the provider's own
 * `/models` listing.
 *
 * Why one source (the pi-synthetic-provider verdict, docs/d096, applied here):
 * models.dev carries no verboo row at all (catalogOptional in the fleet,
 * docs/d057) — the listing was ALWAYS the only lineup there is, so the
 * extension reads it directly and nothing else. The fleet reads the same
 * listing live (coding-agent, docs/d191): one fetch per run on either side,
 * no committed snapshot to drift.
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
 *
 * Env: nothing (docs/d113).
 */

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
export const VERBOO_BASE_URL = /** @type {string} */ (
	baseUrlFromEnv(VERBOO.apiKeyEnv, VERBOO.baseUrl, process.env)
);
/** @type {string} the env var holding the real key. */
export const VERBOO_API_KEY_ENV = VERBOO.apiKeyEnv;
/** @type {string} the provider id pi namespaces model ids under. */
export const VERBOO_PROVIDER_ID = VERBOO.id;

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
