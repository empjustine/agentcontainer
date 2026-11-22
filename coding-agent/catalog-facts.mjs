/**
 * @fileoverview catalog-facts.mjs — the LIVE secondary catalogs the pi and
 * opencode generators read: Charm's multi-provider catwalk listing
 * (https://catwalk.charm.land/v2/providers) and one provider's own model
 * listing on its base URL (docs/d191).
 *
 * Both are fetched per run and handed over in memory. NO cache file is
 * written, read or committed, and a failed fetch returns `null` — the caller
 * publishes nothing rather than a copy of what the source answered some other
 * day. The corpus is why: the committed models.dev copy had fallen 235→330
 * providers behind the live catalog, and each per-provider facts cache kept
 * republishing ids its provider had already rotated away (docs/d189, d190).
 *
 * Fetching: `upstreamCandidates` (route-probe.mjs) addresses the canonical
 * upstream and reaches it through the environment proxy (docs/d074, d108).
 * This module reads no env and no table: the fact row, its key and the runtime
 * TLS state are parameters, so a fetch is reproducible from its arguments.
 *
 * TLS: an https route under NODE_TLS_REJECT_UNAUTHORIZED=0 is skipped outright
 * (route-probe's fail-closed rule, docs/d033) — no request bytes, credentials
 * or otherwise, reach whoever terminated the handshake.
 *
 * Record shapes stay RAW, unnormalized: each consumer owns its rendering (the
 * pi generator's per-provider factsMapper, the catwalk id map). No fetch URL
 * reaches an ARTIFACT (docs/d086): the winning candidate is capability-bearing
 * (the tunnel mount IS the credential) and rotates with it, so only a local
 * `warn` line may name one — nothing written here is ever committed.
 */

import { logInfo, logWarn } from "./lib/log.mjs";
import { tlsUnverifiable, upstreamCandidates } from "./route-probe.mjs";

const CATWALK_PATH_AND_QUERY = "/v2/providers";
/** The catwalk listing is a large document; provider /models lists are small. */
const CATWALK_TIMEOUT_MS = 10_000;
const FACTS_TIMEOUT_MS = 8000;

/**
 * The raw provider records a per-provider facts fetch holds — only `id` is
 * contractual here, because the fields are provider-specific (hyper's
 * `can_reason` vs verboo's `reasoning.effort_levels`) and each consumer's
 * mapper reads the rest.
 * @typedef {object} ProviderFactsModel
 * @property {string} id
 */

/**
 * A raw catwalk provider model record.
 * @typedef {object} CatwalkModel
 * @property {string} id
 * @property {string} [name]
 * @property {number} [cost_per_1m_in]
 * @property {number} [cost_per_1m_out]
 * @property {number} [cost_per_1m_in_cached]
 * @property {number} [cost_per_1m_out_cached]
 * @property {number} [context_window]
 * @property {number} [default_max_tokens]
 * @property {boolean} [can_reason]
 * @property {string[]} [reasoning_levels]
 * @property {string} [default_reasoning_effort]
 * @property {boolean} [supports_attachments]
 */

/**
 * A raw catwalk provider record.
 * @typedef {object} CatwalkProvider
 * @property {string} id
 * @property {string} [name]
 * @property {CatwalkModel[]} models
 */

/**
 * Where one provider's facts live, relative to its base URL. `listKey` is the
 * JSON key holding the array: hyper serves `{models:[…]}`, verboo the
 * OpenAI-shaped `{object:"list", data:[…]}`.
 * @typedef {object} FactsEndpoint
 * @property {string} path suffix appended to the provider base URL
 * @property {string} [listKey]
 */

// --- shared plumbing --------------------------------------------------------

/**
 * Walk a candidate chain and return the first usable JSON payload.
 * @param {object} options
 * @param {readonly string[]} options.candidates URLs in preference order
 *   (upstreamCandidates)
 * @param {string} options.label log context — the catalog name / provider id
 * @param {number} options.timeoutMs per-caller fetch budget
 * @param {Record<string, string>} [options.headers] provider bearer when present
 * @param {boolean} options.tlsDisabled the runtime TLS state, from the caller
 * @returns {Promise<unknown>} the payload, or undefined when every candidate
 *   failed — `null` stays a real payload the caller can reject on shape
 */
async function relayFetch({
	candidates,
	label,
	timeoutMs,
	headers,
	tlsDisabled,
}) {
	for (const url of candidates) {
		if (tlsUnverifiable(url, tlsDisabled)) {
			logWarn(`${label} route https unverifiable — skipping (TLS disabled)`, {
				url,
			});
			continue;
		}
		try {
			const res = await fetch(url, {
				...(headers ? { headers } : {}),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (res.ok) {
				return await res.json();
			}
			logWarn(`${label} route returned non-2xx`, { status: res.status, url });
		} catch (err) {
			logWarn(`${label} fetch failed`, { error: err, url });
		}
	}
	return;
}

// --- catwalk ----------------------------------------------------------------

/**
 * Pi provider ID → catwalk provider ID. Every pi id absent here has no catwalk
 * view at all (nvidia, mistral, cline-pass, hyper, inferx, verboo), which is
 * why `getCatwalkModels` returns null rather than an empty list.
 * @type {Readonly<Record<string, string>>}
 */
export const PROVIDER_MAP = Object.freeze({
	openrouter: "openrouter",
	opencode: "opencode-zen",
	"opencode-go": "opencode-go",
	google: "gemini",
});

/**
 * Fetch catwalk's full /v2/providers catalog.
 * @param {string|undefined} url explicit URL = operator override of the chain
 * @param {boolean} tlsDisabled the runtime TLS state, from the caller
 * @returns {Promise<CatwalkProvider[]|null>} null when no candidate delivered
 */
export async function fetchCatwalkFacts(url, tlsDisabled) {
	const candidates = url
		? [url]
		: upstreamCandidates("catwalk.charm.land", CATWALK_PATH_AND_QUERY);
	const payload = await relayFetch({
		candidates,
		label: "catwalk",
		timeoutMs: CATWALK_TIMEOUT_MS,
		tlsDisabled,
	});
	if (!Array.isArray(payload) || payload.length === 0) {
		logWarn("catwalk did not deliver a provider list", {
			reason:
				payload === undefined
					? "no candidate delivered"
					: "catalog answered without a providers array",
		});
		return null;
	}
	logInfo("catwalk listing fetched", { providers: payload.length });
	return /** @type {CatwalkProvider[]} */ (payload);
}

/**
 * Get catwalk models for a pi provider ID. Returns null when the provider is
 * not mapped to catwalk or the fetch failed.
 * @param {CatwalkProvider[]|null} catwalk the run's fetched listing
 * @param {string} piProviderId the pi provider id (e.g. "openrouter")
 * @returns {{ id: string, name: string }[]|null} model entries or null
 */
export function getCatwalkModels(catwalk, piProviderId) {
	const catwalkId = PROVIDER_MAP[piProviderId];
	if (!catwalkId || !catwalk) {
		return null;
	}
	const provider = catwalk.find((p) => p.id === catwalkId);
	if (!provider) {
		return null;
	}
	// `name` is optional in the raw record; fall back to the id so the return
	// type stays `{id, name}` for display consumers.
	return provider.models.map((m) => ({ id: m.id, name: m.name ?? m.id }));
}

// --- per-provider facts -----------------------------------------------------

/**
 * Fetch one provider's own model listing (docs/d057, d191). Fail closed on
 * unverified TLS (docs/d033): the handshake is unauthenticated there, so the
 * key is never written to an impostor.
 * @param {{ id: string, baseUrl: string }} provider the provider's identity and
 *   the upstream this run uses (canonical, or its `<KEY>_BASE_URL` override)
 * @param {FactsEndpoint} endpoint where its listing lives under that base
 * @param {string|undefined} apiKey the provider's key, from the caller's env
 * @param {boolean} tlsDisabled the runtime TLS state, from the caller
 * @returns {Promise<ProviderFactsModel[]|null>} the served records, or null
 *   when the provider did not answer (the caller publishes nothing)
 */
export async function fetchProviderFacts(
	provider,
	endpoint,
	apiKey,
	tlsDisabled,
) {
	const { path, listKey = "models" } = endpoint;
	const upstream = new URL(provider.baseUrl);
	const basePath = upstream.pathname.replace(/\/+$/, "");
	/** @type {{ "Content-Type": string, Authorization?: string }} */
	const headers = { "Content-Type": "application/json" };
	const key = apiKey?.trim();
	if (key) {
		headers.Authorization = `Bearer ${key}`;
	}

	const payload = await relayFetch({
		candidates: upstreamCandidates(upstream.host, `${basePath}${path}`),
		label: provider.id,
		timeoutMs: FACTS_TIMEOUT_MS,
		headers,
		tlsDisabled,
	});
	const records =
		payload === undefined || payload === null
			? null
			: /** @type {any} */ (payload)[listKey];
	if (!Array.isArray(records) || records.length === 0) {
		logWarn(`${provider.id} served no ${listKey} array`, {
			reason:
				payload === undefined
					? "no candidate delivered"
					: "listing without records",
		});
		return null;
	}
	logInfo(`${provider.id} listing fetched`, {
		[listKey]: records.length,
	});
	return /** @type {ProviderFactsModel[]} */ (records);
}
