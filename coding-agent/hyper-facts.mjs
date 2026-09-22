/**
 * @fileoverview hyper-facts.mjs — the ONE non-models.dev model-facts cache:
 * Charm Hyper's live `/provider` catalog
 * (https://hyper.charm.land/v1/provider — the canonical source; the vendor
 * extension charmbracelet/pi-hyper-provider consumes the same endpoint and
 * its source is also kept in the optional local reference mirror
 * ~/Downloads/references/github/ — a cache, not canonical), cached next to
 * this file with the same tmp+rename + stale-tolerant-read contract as the
 * vendored models.dev catalog (docs/d021, docs/d023).
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
 * Lifecycle (mirrors coding-agent/refresh-models-dev.mjs):
 *   - REFRESH, best-effort, whenever hyper is reachable directly — done by
 *     coding-agent/generate-pi-coding-agent.mjs (hyper row, cascade step 1)
 *     and by llm-local-inference's hyper peer fetch. A failed refresh never
 *     touches the last good copy (tmp+rename).
 *   - CONSUME, stale-tolerant, whenever the facts are needed but the
 *     endpoint is not (pi's peer-mode layer — peer mode means
 *     hyper.charm.land itself is unreachable, so the cache is the only
 *     enrichment available; llm-local-inference when the refresh failed). The
 *     age is logged, never enforced.
 *
 * The cache file must NOT be named `model-*.json`: generate-pi-coding-agent.mjs
 * collects every /model-.*\.json/ sibling as a merge layer and would
 * silently merge these facts into models.json.
 *
 * Import convention (docs/d023, d039): shared lib/ helpers resolve through
 * $LIB_DIR (`env ?? "<this dir>/../lib"`); peer-probe.mjs is a same-dir
 * sibling. Path convention: the cache lives NEXT TO THIS FILE
 * (coding-agent/hyper-facts.json — single consumer, so the cache lives with
 * it; docs/d039); HYPER_FACTS_JSON overrides (generate.sh points it at the
 * staged scratch copy when the repo tree is read-only).
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	peerBaseUrls,
	peerProviderUrl,
	peersOnly,
	tlsUnverifiable,
	useEnvProxy,
} from "./peer-probe.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);
// Proxy-env routing for this module's own fetch (rationale: docs/d001 §1).
// Importing peer-probe.mjs gives it for free — its module top-level calls
// useEnvProxy() and its fetches share the global dispatcher contract.
useEnvProxy();
setLogTool("coding-agent/hyper-facts");

const FACTS = CLOUD_PROVIDERS.hyper;
const REQUEST_TIMEOUT_MS = 8000;

/** Cache location (see header): next to this file unless overridden. */
const FACTS_PATH =
	process.env.HYPER_FACTS_JSON ?? join(scriptDir, "hyper-facts.json");

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
 *
 * Direct first (the provider's real endpoint), then the peer route
 * (peerProviderUrl form, docs/d047) over EVERY vault-sourced peer base candidate
 * (multi-hop chains — docs/d034) when the direct endpoint is unreachable.
 * This keeps the cache fresh even when the provider's own endpoint is
 * network-isolated but routable through a peer.
 *
 * Same fail-closed rule as the probes (peer-probe.mjs): under unverified TLS
 * (NODE_TLS_REJECT_UNAUTHORIZED=0) https fetches are skipped WITHOUT the
 * HYPER_API_KEY header — the key belongs to whoever answered the unverified
 * handshake (docs/d033). The last good cache then stays in place.
 * `skipDirect` (peer-mode refreshes — docs/d033) skips the direct leg the same
 * way: the caller already proved the direct endpoint unreachable, so re-probing
 * it is a wasted timeout; peer candidates only.
 * @param {string} [baseUrl] hyper's OpenAI-compatible endpoint (facts-table
 *   default)
 * @param {boolean} [skipDirect] peer-mode refresh: never probe the provider's
 *   own endpoint, peer candidates only
 * @returns {Promise<boolean>} true when the cache was refreshed
 */
export async function refreshHyperFacts(
	baseUrl = FACTS.baseUrl,
	skipDirect = false,
) {
	const directUrl = `${baseUrl.replace(/\/+$/, "")}/provider`;
	// v2 host-form peer route (docs/d047): the funnel fronts the
	// llm-reverse-proxy allowlist, so the peer leg must address the
	// hyper.charm.land HOST, not a slug.
	const peerUrls = peerBaseUrls().map(
		(base) => `${peerProviderUrl(base, "hyper")}/provider`,
	);

	/** @type {any} */
	let payload;
	let fetchedUrl = null;

	// --- 1. direct endpoint first -----------------------------------------
	// Skipped under PEERS_ONLY=1, by `skipDirect` (peer-mode callers — the
	// direct endpoint was already proven unreachable) and on unverified TLS
	// (fail closed, no credentialed fetch — docs/d033).
	if (peersOnly() || skipDirect || tlsUnverifiable(directUrl)) {
		const reason = tlsUnverifiable(directUrl)
			? "unverified TLS — failing closed"
			: "PEERS_ONLY / peer-mode — direct leg skipped";
		logWarn(`hyper direct endpoint ${reason}`, {
			url: directUrl,
		});
	} else {
		try {
			/** @type {{ "Content-Type": string, Authorization?: string }} */
			const headers = { "Content-Type": "application/json" };
			const key = process.env[FACTS.apiKeyEnv]?.trim();
			if (key) headers.Authorization = `Bearer ${key}`;
			const res = await fetch(directUrl, {
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (res.ok) {
				payload = await res.json();
				fetchedUrl = directUrl;
			} else {
				logWarn("hyper direct endpoint returned non-2xx — trying peer route", {
					status: res.status,
					url: directUrl,
				});
			}
		} catch (err) {
			logWarn("hyper direct fetch failed — trying peer route", {
				error: err,
			});
		}
	}

	// --- 2. peer route fallback (every candidate, in order) -------------
	if (!payload) {
		for (const peerUrl of peerUrls) {
			if (tlsUnverifiable(peerUrl)) {
				logWarn(
					"hyper peer https unverifiable — skipping (TLS verification disabled)",
					{
						url: peerUrl,
					},
				);
				continue;
			}
			try {
				const res = await fetch(peerUrl, {
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (res.ok) {
					payload = await res.json();
					fetchedUrl = peerUrl;
					break;
				}
				logWarn("hyper peer route returned non-2xx", {
					status: res.status,
					url: peerUrl,
				});
			} catch (err) {
				logWarn("hyper peer fetch failed", {
					error: err,
					url: peerUrl,
				});
			}
		}
	}

	if (!payload) {
		logWarn(
			"hyper facts refresh failed (all sources exhausted) — keeping last good cache",
			{
				path: FACTS_PATH,
			},
		);
		return false;
	}

	const models = /** @type {HyperProviderModel[]} */ (payload?.models);
	if (!Array.isArray(models) || models.length === 0) {
		logWarn("hyper facts refresh failed — no models array", {
			path: FACTS_PATH,
			fetchedUrl,
		});
		return false;
	}

	const facts = /** @type {HyperFacts} */ ({
		fetchedAt: new Date().toISOString(),
		fetchedFrom: fetchedUrl,
		models,
	});
	const tmp = `${FACTS_PATH}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(facts, null, 2)}\n`);
	renameSync(tmp, FACTS_PATH); // atomic on the same filesystem: a failed fetch never corrupts the last good copy
	logInfo("hyper facts cache refreshed", {
		path: FACTS_PATH,
		models: models.length,
		fetchedFrom: fetchedUrl,
	});
	return true;
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
			error: err,
		});
		return null;
	}
}

// Runnable as main: node coding-agent/hyper-facts.mjs [baseUrl] — best-effort refresh
// (the same call the generators make), exit 0 either way.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
	await refreshHyperFacts(process.argv[2]);
}
