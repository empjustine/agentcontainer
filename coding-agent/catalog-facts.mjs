/**
 * @fileoverview catalog-facts.mjs — the LIVE secondary catalogs the pi and
 * opencode generators read: Charm's multi-provider catwalk listing
 * (`https://catwalk.charm.land/v2/providers`) and one provider's own model
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
 * upstream and reaches it through the environment proxy (docs/d074, d108),
 * carrying the provider Authorization bearer when the key is present. An edge
 * that cannot deliver is a `null`, logged, never retried against a file.
 *
 * TLS: an https route under NODE_TLS_REJECT_UNAUTHORIZED=0 is skipped outright
 * (route-probe's fail-closed rule, docs/d033) — no request bytes, credentials
 * or otherwise, reach whoever terminated the handshake.
 *
 * Record shapes stay RAW, unnormalized: each consumer owns its rendering (the
 * pi generator's per-provider factsMapper, the catwalk id map). No fetch URL
 * reaches an ARTIFACT (docs/d086): the winning relay candidate is
 * capability-bearing (the funnel mount IS the mode A credential) and rotates
 * with it, so only a local `warn` line may name one — nothing written here is
 * ever committed.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { tlsUnverifiable, upstreamCandidates } from "./route-probe.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("./lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("./lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);

setLogTool("coding-agent/catalog-facts");

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
 * @returns {Promise<{ payload: unknown, url: string }|null>} null when every
 *   candidate failed — the caller publishes nothing
 */
async function relayFetch({ candidates, label, timeoutMs, headers }) {
	for (const url of candidates) {
		if (tlsUnverifiable(url)) {
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
				return { payload: await res.json(), url };
			}
			logWarn(`${label} route returned non-2xx`, { status: res.status, url });
		} catch (err) {
			logWarn(`${label} fetch failed`, { error: err, url });
		}
	}
	return null;
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
 * @param {string} [url] explicit URL = operator override of the relay chain
 * @returns {Promise<CatwalkProvider[]|null>} null when no candidate delivered
 */
export async function fetchCatwalkFacts(url) {
	const candidates = url
		? [url]
		: upstreamCandidates("catwalk.charm.land", CATWALK_PATH_AND_QUERY);
	const found = await relayFetch({
		candidates,
		label: "catwalk",
		timeoutMs: CATWALK_TIMEOUT_MS,
	});
	const providers = found ? /** @type {any} */ (found.payload) : null;
	if (!found || !Array.isArray(providers) || providers.length === 0) {
		logWarn("catwalk did not deliver a provider list", {
			reason: found
				? "catalog answered without a providers array"
				: "no candidate delivered",
		});
		return null;
	}
	logInfo("catwalk listing fetched", { providers: providers.length });
	return /** @type {CatwalkProvider[]} */ (providers);
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
 * Fetch one provider's own model listing (docs/d057, d191).
 * Fail closed on unverified TLS (docs/d033): the handshake is unauthenticated
 * there, so the key is never written to an impostor.
 * @param {string} id fact-table provider id
 * @param {FactsEndpoint} options
 * @returns {Promise<ProviderFactsModel[]|null>} the served records, or null
 *   when the provider did not answer (the caller publishes nothing)
 */
export async function fetchProviderFacts(id, options) {
	const { path, listKey = "models" } = options;
	const facts = CLOUD_PROVIDERS[id];
	if (!facts) {
		logWarn("no fact-table row — facts fetch skipped", { provider: id });
		return null;
	}
	// Host-form route (docs/d047): the funnel fronts the estige allowlist, so
	// candidates address the upstream HOST + base path.
	const upstream = new URL(facts.baseUrl);
	const basePath = upstream.pathname.replace(/\/+$/, "");
	/** @type {{ "Content-Type": string, Authorization?: string }} */
	const headers = { "Content-Type": "application/json" };
	const key = process.env[facts.apiKeyEnv]?.trim();
	if (key) {
		headers.Authorization = `Bearer ${key}`;
	}

	const found = await relayFetch({
		candidates: upstreamCandidates(upstream.host, `${basePath}${path}`),
		label: id,
		timeoutMs: FACTS_TIMEOUT_MS,
		headers,
	});
	const payload = found ? /** @type {any} */ (found.payload) : null;
	const records = payload ? payload[listKey] : null;
	if (!found || !Array.isArray(records) || records.length === 0) {
		logWarn(`${id} served no ${listKey} array`, {
			reason: found ? "listing without records" : "no candidate delivered",
		});
		return null;
	}
	logInfo(`${id} listing fetched`, { [listKey]: records.length });
	return /** @type {ProviderFactsModel[]} */ (records);
}
