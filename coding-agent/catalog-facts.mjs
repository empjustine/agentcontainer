/**
 * @fileoverview catalog-facts.mjs — the two LLM catalog fact caches the pi
 * and opencode generators read, in one module (docs/d072 folded the former
 * `catwalk-facts.mjs` + `provider-facts.mjs` here: one consumer
 * (gen-lib.mjs), one fetch/write/read skeleton, one CLI dispatcher — two
 * files only ever duplicated it).
 *
 *   1. CATWALK — Charm's multi-provider fallback catalog
 *      (https://catwalk.charm.land/v2/providers). Catwalk's records are
 *      provider-specific, so this module fetches the full provider listing
 *      and exposes per-provider model lookups for generators that need a
 *      secondary catalog when models.dev is stale or absent. Cache:
 *      `lib/catwalk-facts.json` (the reverse-proxy generator reads that one
 *      too), overridable via `CATWALK_FACTS_JSON`.
 *   2. PER-PROVIDER FACTS — the model-facts cache for providers whose OWN
 *      endpoint is the authoritative model source (docs/d021, d023, d057):
 *      `hyper` (`models` records, enriches a catalog lineup) and `verboo`
 *      (`data` records, the only lineup there is — models.dev carries no row).
 *      Cache: `<id>-facts.json` next to this file, overridable via the
 *      id-derived `<ID>_FACTS_JSON`. It must NOT be named `model-*.json`:
 *      generate-pi-coding-agent.mjs collects that pattern as merge layers.
 *
 * Both fetches address the canonical upstream (upstreamCandidates) and reach
 * the edge through the environment proxy (docs/d074, d108), carrying the
 * provider Authorization bearer when the key is present. There is no
 * prefixed-route leg any more and no candidate chain to walk, so an edge that
 * cannot deliver simply leaves the last good cache in place.
 *
 * Contracts that hold for BOTH caches:
 *   - REFRESH is best-effort: every failure — fetch, validation, or a cache
 *     dir that is not writable (ro-mounted tree) — is a warn, the last good
 *     copy survives (tmp+rename), the return value is the only signal. A
 *     refresh that finds unchanged facts still returns true: the cache holds
 *     current data either way, and the log line is what separates
 *     `refreshed` from `unchanged — not rewritten`.
 *   - CONSUME is stale-tolerant (docs/d021): an absent/unreadable cache
 *     skips the enrichment, never aborts the run. The age is logged, never
 *     enforced — so a committed cache is a first-class artifact, not a
 *     leftover.
 *   - TLS: an https route under NODE_TLS_REJECT_UNAUTHORIZED=0 is skipped
 *     outright (route-probe's fail-closed rule, docs/d033) — no request
 *     bytes, credentials or otherwise, reach whoever terminated the
 *     handshake.
 *
 * Cache documents keep the RAW records, unnormalized: each consumer owns its
 * rendering (the pi generator's per-provider factsMapper, the catwalk id
 * map). Shapes: `{_meta, fetchedAt, providers: [...]}` for catwalk,
 * `{_meta, fetchedAt, models: [...]}` for a provider — the `_meta` block, the
 * canonical ordering and the skip-when-unchanged rule are lib/fact-table.mjs's
 * contract (docs/d086), which is also why a refresh that finds the same facts
 * leaves the file — and its `fetchedAt` — alone. `fetchedAt` is therefore when
 * the DATA last moved, not when the last fetch ran: the age below is the
 * freshness of the facts, never of the run. No fetch URL is recorded — in the
 * document or the logs (docs/d086): the winning relay candidate is
 * capability-bearing (the funnel mount IS the mode A credential) and rotates
 * with it, so an exact URL both leaks the credential and churns the cache.
 *
 * Usage (the generators call the functions in-process; the CLI is a
 * maintenance convenience — best-effort, exit 0 either way):
 *   node coding-agent/catalog-facts.mjs catwalk [url]   explicit url overrides the relay chain
 *   node coding-agent/catalog-facts.mjs <providerId> [listPath]  path defaults to /models
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
const { publishFactCache } =
	/** @type {typeof import("./lib/fact-table.mjs")} */ (
		await import(`${LIB_DIR}/fact-table.mjs`)
	);

setLogTool("coding-agent/catalog-facts");

const CATWALK_PATH_AND_QUERY = "/v2/providers";
/** The catwalk listing is a large document; provider /models lists are small. */
const CATWALK_TIMEOUT_MS = 10_000;
const FACTS_TIMEOUT_MS = 8000;

const CATWALK_CACHE_PATH =
	process.env.CATWALK_FACTS_JSON ?? join(LIB_DIR, "catwalk-facts.json");

/**
 * The raw provider records a per-provider cache holds — only `id` is
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
 * A loaded, age-stamped view of a per-provider cache.
 * @typedef {object} LoadedProviderFacts
 * @property {string} fetchedAt
 * @property {number} ageMs
 * @property {ProviderFactsModel[]} models
 */

/**
 * A loaded, age-stamped view of the catwalk cache.
 * @typedef {object} LoadedCatwalkFacts
 * @property {string} fetchedAt
 * @property {number} ageMs
 * @property {CatwalkProvider[]} providers
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
 * Walk a candidate chain and return the first usable payload.
 * @param {object} options
 * @param {readonly string[]} options.candidates URLs in preference order
 *   (upstreamCandidates)
 * @param {string} options.label log context — the cache name / provider id
 * @param {number} options.timeoutMs per-caller fetch budget
 * @param {Record<string, string>} [options.headers] provider bearer when present
 * @returns {Promise<{ payload: unknown, url: string }|null>} null when every
 *   candidate failed — the caller keeps its last good cache
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

/**
 * The command that reproduces a cache — recorded as `_meta.regen` so a reader
 * can rebuild a file they do not trust. Catwalk has a standalone CLI entry;
 * a per-provider cache is refreshed inside generation, whose provider rows
 * carry the endpoint shape (`path`, `listKey`) the generic CLI cannot know,
 * so its reproducer is the generator itself.
 * @param {string} source cache source ID
 * @returns {string}
 */
function regenCommand(source) {
	return source === "catwalk"
		? "node coding-agent/catalog-facts.mjs catwalk"
		: "node coding-agent/generate-pi-coding-agent.mjs";
}

/**
 * Publish a refreshed cache through the docs/d086 churn recipe
 * (lib/fact-table.mjs): canonical order, `_meta` provenance, and no write at
 * all when the facts did not move. A cache dir that is not writable (the repo
 * tree mounted ro in a container) is a WARN, not a throw — the refresh
 * contract says every failure degrades to the last good copy, and throwing
 * here would take the whole generation down over an enrichment.
 * @param {string} path cache destination
 * @param {object} cache
 * @param {string} cache.source cache source ID (`catwalk` / provider id)
 * @param {string} cache.listKey member holding the record list
 * @param {unknown[]} cache.records raw records as fetched
 * @returns {boolean} false when the cache could not be written
 */
function publishCache(path, { source, listKey, records }) {
	try {
		const published = publishFactCache(path, {
			source,
			listKey,
			records,
			generator: "coding-agent/catalog-facts.mjs",
			regen: regenCommand(source),
		});
		logInfo(
			published.changed
				? `${source} facts cache refreshed`
				: `${source} facts cache unchanged — not rewritten`,
			{
				path,
				[listKey]: records.length,
				fetchedAt: published.fetchedAt,
				contentSha256: published.contentSha256,
			},
		);
		return true;
	} catch (err) {
		logWarn("facts cache not writable — keeping last good copy", {
			path,
			error: err,
		});
		return false;
	}
}

/**
 * Read a cache document and stamp its age — the stale-tolerant half of the
 * refresh contract: absent, unreadable, empty or malformed all reduce to
 * `null` (skip the enrichment) rather than an error. `ageMs` is the age of the
 * FACTS: `fetchedAt` advances only when the content moves (docs/d086), so a
 * cache checked daily against a stable upstream reports its real data age
 * rather than resetting to zero every run.
 * @param {string} path cache file
 * @param {string} listKey key holding the records array (`providers` / `models`)
 * @param {string} label log context
 * @returns {{ fetchedAt: string, ageMs: number, records: unknown[] }|null}
 */
function loadCache(path, listKey, label) {
	try {
		const document = JSON.parse(readFileSync(path, "utf-8"));
		const records = document?.[listKey];
		if (!Array.isArray(records) || records.length === 0) {
			throw new Error(`cache has no ${listKey} array`);
		}
		const ageMs = Date.now() - Date.parse(document.fetchedAt);
		return {
			fetchedAt: document.fetchedAt,
			ageMs: Number.isFinite(ageMs) ? ageMs : 0,
			records,
		};
	} catch (err) {
		logWarn(`${label} facts cache unreadable — skipping enrichment`, {
			path,
			error: err,
		});
		return null;
	}
}

// --- catwalk ----------------------------------------------------------------

/**
 * Pi provider ID → catwalk provider ID. Every pi id absent here has no
 * catwalk view at all (nvidia, mistral, cline-pass, hyper, inferx, verboo),
 * which is why `getCatwalkModels` returns null rather than an empty list.
 * @type {Readonly<Record<string, string>>}
 */
export const PROVIDER_MAP = Object.freeze({
	openrouter: "openrouter",
	opencode: "opencode-zen",
	"opencode-go": "opencode-go",
	google: "gemini",
});

/**
 * Fetch catwalk's full /v2/providers catalog and publish it.
 * @param {string} [url] explicit URL = operator override of the relay chain
 * @returns {Promise<boolean>} true when the cache was refreshed
 */
export async function refreshCatwalkFacts(url) {
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
		logWarn("catwalk facts refresh failed — keeping last good cache", {
			path: CATWALK_CACHE_PATH,
			reason: found
				? "catalog answered without a providers array"
				: "no candidate delivered",
		});
		return false;
	}
	return publishCache(CATWALK_CACHE_PATH, {
		source: "catwalk",
		listKey: "providers",
		records: /** @type {CatwalkProvider[]} */ (providers),
	});
}

/**
 * Stale-tolerant cache read.
 * @returns {LoadedCatwalkFacts|null} null when the cache is absent or unreadable
 */
export function loadCatwalkFacts() {
	const cache = loadCache(CATWALK_CACHE_PATH, "providers", "catwalk");
	if (!cache) {
		return null;
	}
	return {
		fetchedAt: cache.fetchedAt,
		ageMs: cache.ageMs,
		providers: /** @type {CatwalkProvider[]} */ (cache.records),
	};
}

/**
 * Get catwalk models for a pi provider ID. Returns null when the provider
 * is not mapped to catwalk or the cache is unavailable.
 * @param {string} piProviderId the pi provider id (e.g. "openrouter")
 * @returns {{ id: string, name: string }[]|null} model entries or null
 */
export function getCatwalkModels(piProviderId) {
	const catwalkId = PROVIDER_MAP[piProviderId];
	if (!catwalkId) {
		return null;
	}
	const facts = loadCatwalkFacts();
	if (!facts) {
		return null;
	}
	const provider = facts.providers.find((p) => p.id === catwalkId);
	if (!provider) {
		return null;
	}
	// `name` is optional in the raw record; fall back to the id so the return
	// type stays `{id, name}` for display consumers.
	return provider.models.map((m) => ({ id: m.id, name: m.name ?? m.id }));
}

// --- per-provider facts -----------------------------------------------------

/**
 * The cache location for one provider: next to this file unless the
 * id-derived env override names another path. The id is uppercased and
 * dash-folded so `opencode-go` would be `OPENCODE_GO_FACTS_JSON`.
 * @param {string} id fact-table provider id
 * @returns {string}
 */
function factsPath(id) {
	const envKey = `${id.toUpperCase().replaceAll("-", "_")}_FACTS_JSON`;
	return process.env[envKey] ?? join(scriptDir, `${id}-facts.json`);
}

/**
 * Fetch one provider's live facts catalog and publish the cache.
 * Fail closed on unverified TLS (docs/d033): the handshake is
 * unauthenticated there, so the key is never written to an impostor.
 * @param {string} id fact-table provider id
 * @param {FactsEndpoint} options
 * @returns {Promise<boolean>} true when the cache was refreshed
 */
export async function refreshProviderFacts(id, options) {
	const { path, listKey = "models" } = options;
	const facts = CLOUD_PROVIDERS[id];
	if (!facts) {
		logWarn("no fact-table row — facts refresh skipped", { provider: id });
		return false;
	}
	const cachePath = factsPath(id);
	// Host-form route (docs/d047): the funnel fronts the estige
	// allowlist, so candidates address the upstream HOST + base path.
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
		logWarn(
			`${id} facts refresh failed (no ${listKey} array) — keeping last good cache`,
			{ path: cachePath },
		);
		return false;
	}
	return publishCache(cachePath, {
		source: id,
		listKey,
		records,
	});
}

/**
 * Stale-tolerant cache read (docs/d021: an unreadable facts file skips the
 * enrichment, never aborts the run).
 * @param {string} id fact-table provider id
 * @returns {LoadedProviderFacts|null} null when the cache is absent/unreadable
 */
export function loadProviderFacts(id) {
	const cache = loadCache(factsPath(id), "models", id);
	if (!cache) {
		return null;
	}
	return {
		fetchedAt: cache.fetchedAt,
		ageMs: cache.ageMs,
		models: /** @type {ProviderFactsModel[]} */ (cache.records),
	};
}

// CLI dispatch: `catwalk` names the catalog cache, anything else is a
// fact-table provider id (see the fileoverview usage block).
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
	const [target, arg] = process.argv.slice(2);
	if (target === undefined) {
		throw new Error(
			"usage: catalog-facts.mjs <provider-id|catwalk> [path] — no target given",
		);
	}
	if (target === "catwalk") {
		await refreshCatwalkFacts(arg);
	} else {
		await refreshProviderFacts(target, { path: arg ?? "/models" });
	}
}
