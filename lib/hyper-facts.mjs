/**
 * @fileoverview hyper-facts.mjs — the ONE non-models.dev model-facts cache:
 * Charm Hyper's live `/provider` catalog
 * (https://hyper.charm.land/v1/provider — the same source the vendor
 * extension charmbracelet/pi-hyper-provider consumes, mirrored under
 * ~/Downloads/references/github/), cached next to this file with the same
 * tmp+rename + stale-tolerant-read contract as the vendored models.dev
 * catalog (docs/d021, docs/d023).
 *
 * Why a cache and why ONLY hyper: hyper is the one cloud provider where (a)
 * its own endpoint beats the models.dev catalog per-field (live reasoning
 * flags, attachment support, per-model cached-input/cached-OUTPUT prices,
 * effort enums) and (b) pi has no built-in provider, so the emitted models.json
 * layer is the ONLY metadata pi ever sees — every other provider here either
 * has no rich endpoint worth caching (opencode/cline-pass serve thin id-only
 * /models listings; cline-pass's enrichment already IS models.dev) or is
 * pi-native with richer built-ins that a layer must not replace
 * (openrouter/opencode — docs/d024 override-only semantics).
 *
 * Shape (the RAW /provider model records, unnormalized — each consumer owns
 * its rendering: pi-shaped entries vs llama-swap peer id lists):
 *   { fetchedAt: <ISO>, fetchedFrom: <url>, models: [...] }
 *
 * Lifecycle (mirrors lib/refresh-models-dev.mjs):
 *   - REFRESH, best-effort, whenever hyper is reachable directly — done by
 *     coding-agent/generate-cloud-alternative-providers.mjs (cascade step 1)
 *     and by llm-reverse-proxy's hyper peer fetch. A failed refresh never
 *     touches the last good copy (tmp+rename).
 *   - CONSUME, stale-tolerant, whenever the facts are needed but the
 *     endpoint is not (pi's peer-mode layer — peer mode means
 *     hyper.charm.land itself is unreachable, so the cache is the only
 *     enrichment available; llm-reverse-proxy when the refresh failed). The
 *     age is logged, never enforced.
 *
 * The cache file must NOT be named `model-*.json`: merge-models-json.mjs
 * collects every /model-.*\.json/ sibling as a merge layer and would
 * silently merge these facts into models.json.
 *
 * Import via the LIB_DIR convention (docs/d023). Path convention: the cache
 * lives NEXT TO THIS FILE (lib/hyper-facts.json — inside the copy unit
 * "folder + ../lib", so it is staged/committed like the vendored catalog);
 * HYPER_FACTS_JSON overrides (generate.sh points it at a writable location
 * when lib is a read-only mount).
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR =
	process.env.LIB_DIR ?? dirname(fileURLToPath(import.meta.url));
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("./log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("./cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);
// Proxy-env routing for this module's own fetch (rationale: docs/d001 §1).
// Importing peer-probe.mjs gives it for free — its module top-level calls
// useEnvProxy() and its fetches share the global dispatcher contract.
const { useEnvProxy } = /** @type {typeof import("./peer-probe.mjs")} */ (
	await import(`${LIB_DIR}/peer-probe.mjs`)
);
useEnvProxy();
setLogTool("lib/hyper-facts");

const FACTS = CLOUD_PROVIDERS.hyper;
const REQUEST_TIMEOUT_MS = 8000;

/** Cache location (see header): next to this file unless overridden. */
const FACTS_PATH =
	process.env.HYPER_FACTS_JSON ?? join(LIB_DIR, "hyper-facts.json");

/**
 * A raw Charm Hyper `/provider` model record — the subset consumers read.
 * @typedef {object} HyperProviderModel
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [can_reason]
 * @property {string[]} [reasoning_levels]
 * @property {string} [default_reasoning_effort]
 * @property {boolean} [supports_attachments]
 * @property {number} [context_window]
 * @property {number} [default_max_tokens]
 * @property {number} [cost_per_1m_in]
 * @property {number} [cost_per_1m_out]
 * @property {number} [cost_per_1m_in_cached]
 * @property {number} [cost_per_1m_out_cached]
 */

/**
 * The parsed cache document.
 * @typedef {object} HyperFacts
 * @property {string} fetchedAt
 * @property {string} fetchedFrom
 * @property {HyperProviderModel[]} models
 */

/**
 * A loaded, age-stamped view of the cache.
 * @typedef {object} LoadedHyperFacts
 * @property {string} fetchedAt
 * @property {number} ageMs
 * @property {HyperProviderModel[]} models
 */

/**
 * Fetch hyper's live /provider catalog and (atomically) write the cache.
 * Best-effort by contract: every failure is a warn, the last good cache is
 * never touched, and the return value is the only signal.
 * @param {string} [baseUrl] hyper's OpenAI-compatible endpoint (facts-table
 *   default)
 * @returns {Promise<boolean>} true when the cache was refreshed
 */
export async function refreshHyperFacts(
	baseUrl = FACTS.baseUrl,
) {
	const url = `${baseUrl.replace(/\/+$/, "")}/provider`;
	try {
		const headers = { "Content-Type": "application/json" };
		const key = process.env[FACTS.apiKeyEnv]?.trim();
		if (key) headers.Authorization = `Bearer ${key}`;
		const res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) {
			throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
		}
		const payload = /** @type {any} */ (await res.json());
		const models = /** @type {HyperProviderModel[]} */ (payload?.models);
		if (!Array.isArray(models) || models.length === 0) {
			throw new Error(`GET ${url} returned no models array`);
		}
		const facts = /** @type {HyperFacts} */ ({
			fetchedAt: new Date().toISOString(),
			fetchedFrom: url,
			models,
		});
		const tmp = `${FACTS_PATH}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(facts, null, 2)}\n`);
		renameSync(tmp, FACTS_PATH); // atomic on the same filesystem: a failed fetch never corrupts the last good copy
		logInfo("hyper facts cache refreshed", {
			path: FACTS_PATH,
			models: models.length,
		});
		return true;
	} catch (err) {
		logWarn("hyper facts refresh failed — keeping last good cache", {
			path: FACTS_PATH,
			error: /** @type {any} */ (err)?.message ?? String(err),
		});
		return false;
	}
}

/**
 * Stale-tolerant cache read (docs/d021 contract: an unreadable facts file
 * skips the enrichment, never aborts the run).
 * @returns {LoadedHyperFacts|null} null when the cache is absent or unreadable
 */
export function loadHyperFacts() {
	try {
		const facts = /** @type {HyperFacts} */ (
			JSON.parse(readFileSync(FACTS_PATH, "utf-8"))
		);
		if (!Array.isArray(facts.models) || facts.models.length === 0) {
			throw new Error("cache has no models array");
		}
		const ageMs = Date.now() - Date.parse(facts.fetchedAt);
		return {
			fetchedAt: facts.fetchedAt,
			ageMs: Number.isFinite(ageMs) ? ageMs : 0,
			models: facts.models,
		};
	} catch (err) {
		logWarn("hyper facts cache unreadable — skipping enrichment", {
			path: FACTS_PATH,
			error: /** @type {any} */ (err)?.message ?? String(err),
		});
		return null;
	}
}

// Runnable as main: node lib/hyper-facts.mjs [baseUrl] — best-effort refresh
// (the same call the generators make), exit 0 either way.
if (
	process.argv[1] &&
	import.meta.url.endsWith(basename(process.argv[1]))
) {
	await refreshHyperFacts(process.argv[2]);
}
