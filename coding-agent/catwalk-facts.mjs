/**
 * @fileoverview catwalk-facts.mjs — Charm's catwalk as a multi-provider
 * fallback catalog (https://catwalk.charm.land/v2/providers). Unlike
 * hyper-facts.mjs (single-provider), this module fetches the full catwalk
 * provider listing and exposes per-provider model lookups for generators
 * that need a secondary catalog when models.dev is stale or absent.
 *
 * Provider ID mapping (pi → catwalk):
 *   openrouter    → openrouter
 *   opencode      → opencode-zen
 *   opencode-go   → opencode-go
 *   google        → gemini
 *   nvidia        → (none — not in catwalk)
 *   mistral       → (none — not in catwalk)
 *   cline-pass    → (none — not in catwalk)
 *   hyper         → (none — not in catwalk; uses hyper-facts.mjs)
 *   inferx        → (none — not in catwalk)
 *
 * Shape (same contract as hyper-facts.mjs):
 *   { fetchedAt: <ISO>, fetchedFrom: <url>, providers: [{id, models: [...]}] }
 *
 * Lifecycle (mirrors coding-agent/refresh-models-dev.mjs):
 *   - REFRESH, best-effort, whenever catwalk is reachable — done by
 *     coding-agent/generate-pi-coding-agent.mjs (fallback id list).
 *     A failed refresh never touches the last good copy.
 *   - CONSUME, stale-tolerant, whenever enrichment is needed. The age is
 *     logged, never enforced.
 *
 * Import via the LIB_DIR convention (docs/d023).
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);

// Proxy-env routing via the same-dir peer-probe module (its top-level calls
// useEnvProxy(); rationale docs/d001 §1).
import { useEnvProxy } from "./peer-probe.mjs";

useEnvProxy();
setLogTool("coding-agent/catwalk-facts");

const CATWALK_URL = "https://catwalk.charm.land/v2/providers";
const REQUEST_TIMEOUT_MS = 10000;

/** Cache location: next to this file unless overridden. */
const FACTS_PATH =
	process.env.CATWALK_FACTS_JSON ?? join(LIB_DIR, "catwalk-facts.json");

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
 * The parsed cache document.
 * @typedef {object} CatwalkFacts
 * @property {string} fetchedAt
 * @property {string} fetchedFrom
 * @property {CatwalkProvider[]} providers
 */

/**
 * A loaded, age-stamped view of the cache.
 * @typedef {object} LoadedCatwalkFacts
 * @property {string} fetchedAt
 * @property {number} ageMs
 * @property {CatwalkProvider[]} providers
 */

/**
 * Pi provider ID → catwalk provider ID mapping.
 * @type {Readonly<Record<string, string>>}
 */
export const PROVIDER_MAP = Object.freeze({
	openrouter: "openrouter",
	opencode: "opencode-zen",
	"opencode-go": "opencode-go",
	google: "gemini",
	// nvidia, mistral, cline-pass, hyper, inferx: not in catwalk
});

/**
 * Fetch catwalk's full /v2/providers catalog and (atomically) write the cache.
 * Best-effort by contract: every failure is a warn, the last good cache is
 * never touched, and the return value is the only signal.
 * @param {string} [url] catwalk endpoint (default: public URL)
 * @returns {Promise<boolean>} true when the cache was refreshed
 */
export async function refreshCatwalkFacts(url = CATWALK_URL) {
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) {
			throw Object.assign(new Error("catwalk catalog answered non-2xx"), {
				status: res.status,
				statusText: res.statusText,
				url,
			});
		}
		const payload = /** @type {CatwalkProvider[]} */ (await res.json());
		if (!Array.isArray(payload) || payload.length === 0) {
			throw Object.assign(
				new Error("catwalk catalog returned no providers array"),
				{ url },
			);
		}
		const facts = /** @type {CatwalkFacts} */ ({
			fetchedAt: new Date().toISOString(),
			fetchedFrom: url,
			providers: payload,
		});
		const tmp = `${FACTS_PATH}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(facts, null, 2)}\n`);
		renameSync(tmp, FACTS_PATH);
		logInfo("catwalk facts cache refreshed", {
			path: FACTS_PATH,
			providers: payload.length,
		});
		return true;
	} catch (err) {
		logWarn("catwalk facts refresh failed — keeping last good cache", {
			path: FACTS_PATH,
			error: err,
		});
		return false;
	}
}

/**
 * Stale-tolerant cache read.
 * @returns {LoadedCatwalkFacts|null} null when the cache is absent or unreadable
 */
export function loadCatwalkFacts() {
	try {
		const facts = /** @type {CatwalkFacts} */ (
			JSON.parse(readFileSync(FACTS_PATH, "utf-8"))
		);
		if (!Array.isArray(facts.providers) || facts.providers.length === 0) {
			throw new Error("cache has no providers array");
		}
		const ageMs = Date.now() - Date.parse(facts.fetchedAt);
		return {
			fetchedAt: facts.fetchedAt,
			ageMs: Number.isFinite(ageMs) ? ageMs : 0,
			providers: facts.providers,
		};
	} catch (err) {
		logWarn("catwalk facts cache unreadable — skipping enrichment", {
			path: FACTS_PATH,
			error: err,
		});
		return null;
	}
}

/**
 * Get catwalk models for a pi provider ID. Returns null when the provider
 * is not mapped to catwalk or the cache is unavailable.
 * @param {string} piProviderId the pi provider id (e.g. "openrouter")
 * @returns {{ id: string, name: string }[]|null} model entries or null
 */
export function getCatwalkModels(piProviderId) {
	const catwalkId = PROVIDER_MAP[piProviderId];
	if (!catwalkId) return null;
	const facts = loadCatwalkFacts();
	if (!facts) return null;
	const provider = facts.providers.find((p) => p.id === catwalkId);
	if (!provider) return null;
	// `name` is optional in the raw record; fall back to the id so the return
	// type stays `{id, name}` for display consumers.
	return provider.models.map((m) => ({ id: m.id, name: m.name ?? m.id }));
}

// Runnable: node coding-agent/catwalk-facts.mjs [url] — best-effort refresh
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
	await refreshCatwalkFacts(process.argv[2]);
}
