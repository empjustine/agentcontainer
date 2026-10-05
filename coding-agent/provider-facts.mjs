/**
 * @fileoverview provider-facts.mjs — the model-facts cache for providers whose
 * OWN endpoint is the authoritative model source: the sanctioned non-models.dev
 * path (docs/d021, docs/d023, docs/d057).
 *
 * One engine, parameterized by the fact-table provider id, because the two
 * consumers differ only in where their records live:
 *
 *   - `hyper`   — https://hyper.charm.land/v1/provider, records under
 *     `models`. models.dev DOES carry hyper, so the cache only ENRICHES the
 *     catalog lineup (docs/d033).
 *   - `verboo`  — https://code.verboo.ai/router/v1/models, records under
 *     `data`. models.dev carries no verboo row at all and refresh-models-dev
 *     replaces the vendored catalog wholesale, so a hand-added catalog row is
 *     transient (docs/d032 F1): here the cache IS the lineup, in both direct
 *     and peer mode.
 *
 * Lifecycle (mirrors coding-agent/refresh-models-dev.mjs):
 *   - REFRESH, best-effort, whenever the endpoint is reachable — driven by
 *     generate-pi-coding-agent.mjs's own row (its emit path passes the
 *     resolved endpoint so the multi-hop peer walk stays pointed at the right
 *     provider path). A failed refresh never touches the last good copy
 *     (tmp+rename).
 *   - CONSUME, stale-tolerant, whenever the facts are needed but the endpoint
 *     is not: peer mode means the provider's own host is unreachable, so the
 *     cache is the only enrichment available. The age is logged, never
 *     enforced. A committed cache (hyper-facts.json) is therefore a first
 *     class artifact, not a leftover.
 *
 * Cache shape — the RAW records, unnormalized, because each consumer owns its
 * rendering (the pi generator's per-provider factsMapper):
 *   { fetchedAt: <ISO>, fetchedFrom: <url>, models: [...] }
 *
 * Path convention: `<id>-facts.json` NEXT TO THIS FILE (docs/d039), and
 * `<ID>_FACTS_JSON` overrides it (generate.sh points it at the staged scratch
 * copy when the repo tree is read-only). The cache file must NOT be named
 * `model-*.json`: generate-pi-coding-agent.mjs collects every such sibling as
 * a merge layer and would silently merge raw facts into models.json.
 *
 * Import convention (docs/d023, d039): lib/ helpers resolve through $LIB_DIR
 * (`env ?? "<this dir>/../lib"`); peer-probe.mjs is a same-dir sibling.
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
setLogTool("coding-agent/provider-facts");

const REQUEST_TIMEOUT_MS = 8000;

/**
 * A raw model record as the provider's own facts endpoint serves it. The
 * fields are provider-specific (hyper's `can_reason` vs verboo's
 * `reasoning.effort_levels`), so only the id is contractual here; each
 * consumer's mapper reads the rest.
 * @typedef {object} ProviderFactsModel
 * @property {string} id
 */

/**
 * The parsed cache document.
 * @typedef {object} ProviderFacts
 * @property {string} fetchedAt
 * @property {string} fetchedFrom
 * @property {ProviderFactsModel[]} models
 */

/**
 * A loaded, age-stamped view of the cache.
 * @typedef {object} LoadedProviderFacts
 * @property {string} fetchedAt
 * @property {number} ageMs
 * @property {ProviderFactsModel[]} models
 */

/**
 * Where one provider's facts live, relative to its base URL. `listKey` is the
 * JSON key holding the array: hyper serves `{models:[…]}`, verboo the
 * OpenAI-shaped `{object:"list", data:[…]}`.
 * @typedef {object} FactsEndpoint
 * @property {string} path suffix appended to the provider base URL
 * @property {string} [listKey]
 */

/**
 * The cache location for one provider (see header): next to this file unless
 * the id-derived env override names another path. The id is uppercased and
 * dash-folded so `opencode-go` would be `OPENCODE_GO_FACTS_JSON`.
 * @param {string} id fact-table provider id
 * @returns {string}
 */
function factsPath(id) {
	const envKey = `${id.toUpperCase().replaceAll("-", "_")}_FACTS_JSON`;
	return process.env[envKey] ?? join(scriptDir, `${id}-facts.json`);
}

/**
 * Fetch one provider's live facts catalog and (atomically) write the cache.
 * Best-effort by contract: every failure is a warn, the last good cache is
 * never touched, and the return value is the only signal.
 *
 * Direct first (the provider's real endpoint), then the peer route
 * (peerProviderUrl form, docs/d047) over EVERY vault-sourced peer base
 * candidate (multi-hop chains — docs/d034) when the direct endpoint is
 * unreachable. This keeps the cache fresh even when the provider's own
 * endpoint is network-isolated but routable through a peer.
 *
 * Same fail-closed rule as the probes (peer-probe.mjs): under unverified TLS
 * (NODE_TLS_REJECT_UNAUTHORIZED=0) https fetches are skipped WITHOUT the
 * provider's key header — the key belongs to whoever answered the unverified
 * handshake (docs/d033). The last good cache then stays in place.
 * `skipDirect` (peer-mode callers) skips the direct leg the same way: the
 * caller already proved the direct endpoint unreachable, so re-probing it is a
 * wasted timeout; peer candidates only.
 * @param {string} id fact-table provider id
 * @param {FactsEndpoint & { baseUrl?: string, skipDirect?: boolean }} options
 * @returns {Promise<boolean>} true when the cache was refreshed
 */
export async function refreshProviderFacts(id, options) {
	const { path, listKey = "models", skipDirect = false } = options;
	const facts = CLOUD_PROVIDERS[id];
	if (!facts) {
		logWarn("no fact-table row — facts refresh skipped", { provider: id });
		return false;
	}
	const baseUrl = options.baseUrl ?? facts.baseUrl;
	const cachePath = factsPath(id);
	const directUrl = `${baseUrl.replace(/\/+$/, "")}${path}`;
	/**
	 * v2 host-form peer route (docs/d047): the funnel fronts the
	 * llm-reverse-proxy allowlist, so the peer leg must address the upstream
	 * HOST, not a slug.
	 */
	const peerUrls = peerBaseUrls().map((base) => `${peerProviderUrl(base, id)}${path}`);

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
		logWarn(`${id} direct endpoint ${reason}`, { url: directUrl });
	} else {
		try {
			/** @type {{ "Content-Type": string, Authorization?: string }} */
			const headers = { "Content-Type": "application/json" };
			const key = process.env[facts.apiKeyEnv]?.trim();
			if (key) headers.Authorization = `Bearer ${key}`;
			const res = await fetch(directUrl, {
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (res.ok) {
				payload = await res.json();
				fetchedUrl = directUrl;
			} else {
				logWarn(
					`${id} direct endpoint returned non-2xx — trying peer route`,
					{ status: res.status, url: directUrl },
				);
			}
		} catch (err) {
			logWarn(`${id} direct fetch failed — trying peer route`, { error: err });
		}
	}

	// --- 2. peer route fallback (every candidate, in order) -------------
	if (!payload) {
		for (const peerUrl of peerUrls) {
			if (tlsUnverifiable(peerUrl)) {
				logWarn(`${id} peer https unverifiable — skipping (TLS disabled)`, {
					url: peerUrl,
				});
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
				logWarn(`${id} peer route returned non-2xx`, {
					status: res.status,
					url: peerUrl,
				});
			} catch (err) {
				logWarn(`${id} peer fetch failed`, { error: err, url: peerUrl });
			}
		}
	}

	const records = payload?.[listKey];
	if (!Array.isArray(records) || records.length === 0) {
		logWarn(`${id} facts refresh failed (no ${listKey} array) — keeping last good cache`, {
			path: cachePath,
			fetchedUrl,
		});
		return false;
	}

	const document = /** @type {ProviderFacts} */ ({
		fetchedAt: new Date().toISOString(),
		fetchedFrom: fetchedUrl,
		models: records,
	});
	const tmp = `${cachePath}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`);
	renameSync(tmp, cachePath); // atomic on the same filesystem: a failed fetch never corrupts the last good copy
	logInfo(`${id} facts cache refreshed`, {
		path: cachePath,
		models: records.length,
		fetchedFrom: fetchedUrl,
	});
	return true;
}

/**
 * Stale-tolerant cache read (docs/d021 contract: an unreadable facts file
 * skips the enrichment, never aborts the run).
 * @param {string} id fact-table provider id
 * @returns {LoadedProviderFacts|null} null when the cache is absent/unreadable
 */
export function loadProviderFacts(id) {
	const path = factsPath(id);
	try {
		const document = /** @type {ProviderFacts} */ (
			JSON.parse(readFileSync(path, "utf-8"))
		);
		if (!Array.isArray(document.models) || document.models.length === 0) {
			throw new Error("cache has no models array");
		}
		const ageMs = Date.now() - Date.parse(document.fetchedAt);
		return {
			fetchedAt: document.fetchedAt,
			ageMs: Number.isFinite(ageMs) ? ageMs : 0,
			models: document.models,
		};
	} catch (err) {
		logWarn(`${id} facts cache unreadable — skipping enrichment`, {
			path,
			error: err,
		});
		return null;
	}
}

// Runnable as main: node coding-agent/provider-facts.mjs <providerId> [factsPath] —
// best-effort refresh, exit 0 either way (the same call the generators make).
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
	const [id, path = "/models"] = process.argv.slice(2);
	await refreshProviderFacts(id, { path });
}