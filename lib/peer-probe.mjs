/**
 * @fileoverview peer-probe.mjs — shared HTTP probe toolkit for the generator
 * families (pi `models.json` layers, opencode config layers, llama-swap peer
 * layers). Owns everything about "ask an OpenAI-compatible endpoint for its
 * `/models` listing": auth headers, the 8 s timeout, the `/v1/models` retry,
 * status-carrying errors, and the reachability classification that decides
 * whether a provider keeps its built-in routing or must be rerouted through a
 * peer.
 *
 * The canonical "reachable ≠ authenticated" rule (previously pasted in three
 * generators — this header is now the only copy): a 401/403 is what an
 * OpenAI-compatible endpoint returns to any unauthenticated request, and the
 * generators legitimately run without provider keys (pi/opencode resolve
 * their own key / OAuth login at request time). Such a response proves the
 * NETWORK PATH works and says nothing about whether the built-in provider
 * works, so it must NOT trigger a peer override. Only the absence of ANY http
 * response (dns failure, connection refused, tls failure, timeout) is
 * evidence that the endpoint is unreachable. See docs/d022 for the history.
 *
 * Import via the LIB_DIR convention (see docs/d023): the generators resolve
 * this file through `process.env.LIB_DIR ?? "../lib"`; the logger is the
 * sibling `./log.mjs`, so one directory = one logger instance.
 */

import { createRequire } from "node:module";
import { logWarn } from "./log.mjs";

// Route fetch() through http(s)_proxy when set (rationale: docs/d001 §1).
// Shared by every fetch this module performs; lib/refresh-models-dev.mjs calls
// useEnvProxy() too. Kept defensive: a missing undici install only drops
// proxy support.
export function useEnvProxy() {
	if (
		process.env.http_proxy ||
		process.env.HTTP_PROXY ||
		process.env.https_proxy ||
		process.env.HTTPS_PROXY
	) {
		try {
			// nodeRequire cast to (id) => any: undici is optional (bundled with
			// node but not type-installed in this repo) and the setup is
			// defensive by design.  (Not named `require`: TS special-cases that
			// identifier and would try to resolve the module for real.)
			const nodeRequire = /** @type {(id: string) => any} */ (
				createRequire(import.meta.url)
			);
			const { EnvHttpProxyAgent, setGlobalDispatcher } = nodeRequire("undici");
			setGlobalDispatcher(new EnvHttpProxyAgent());
		} catch (err) {
			logWarn(
				"http(s)_proxy set but undici EnvHttpProxyAgent unavailable — fetch requests will NOT use the proxy",
				{ error: /** @type {Error} */ (err).message },
			);
		}
	}
}
useEnvProxy();

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Fallback peer candidate used when $PEER_BASE_URL is unset: the bazzite
 * tailscale URL — the world-visible FQDN funnel that reverse-proxies the LAN
 * llama-swap instance (:8080), which serves BOTH concerns (local GGUF, ids
 * FQN-prefixed per family when reached remotely, and cloud peers), so it is a
 * valid candidate for every generator's cascade.
 *
 * Single definition (docs/d024): the URL was previously pasted in four
 * generators under the name BAZZITE_ROUTER_TAILSCALE_URL. No localhost
 * candidate exists beside it — the LAN :8080 listen address is only ever a
 * *local* listen address and the legacy :18080 local-inference port is
 * DEPRECATED, so a co-located peer is reached via $PEER_BASE_URL or this FQDN
 * (docs/d022).
 */
export const DEFAULT_PEER_FALLBACK =
	"https://bazzite.coelacanth-barb.ts.net/8654b72a-de9b-402b-abe6-7201dcb38438";

/**
 * An error that carries the http status when the failure came from a response
 * (vs. a transport-level failure, which has no status at all).
 * @typedef {Error & { status?: number }} HttpError
 */

/**
 * Per-model cost, pi-shaped (used by llama-swap's mirrored metadata and by the
 * pi model entries built from it).
 * @typedef {object} Cost
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 */

/**
 * Per-model metadata llama-swap mirrors from its own model config (served on
 * `/v1/models` under `meta.llamaswap`, already pi-shaped).
 * @typedef {object} LlamaSwapMeta
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {boolean} [reasoning]
 * @property {string[]} [input]
 * @property {Cost} [cost]
 */

/**
 * An unvalidated `/models` entry: `id` is the only required field, everything
 * else is best-effort (llama.cpp, llama-swap and cloud providers each spell
 * the same concepts differently).
 * @typedef {object} RawModelEntry
 * @property {string} id
 * @property {number} [context_length]
 * @property {{ input_modalities?: string[] }} [architecture]
 * @property {{ vision?: boolean }} [capabilities]
 * @property {{ llamaswap?: LlamaSwapMeta, n_ctx?: number }} [meta]
 */

/**
 * A peer/source candidate that answered with a usable `/models` listing.
 * @typedef {object} PeerSource
 * @property {string} baseUrl
 * @property {RawModelEntry[]} entries
 */

/**
 * Outcome of probing an endpoint:
 * - `ok` — 2xx with a parseable model list: built-in routing works.
 * - `auth` — 401/403: reachable, we merely have no usable credentials here.
 * - `reachable` — some other http response: the host answered, so the path is
 *   fine even though the answer was not a model list.
 * - `unreachable` — no http response at all (dns/conn-refused/tls/timeout).
 * Only `unreachable` justifies rerouting a provider through the peer.
 * @typedef {"ok"|"auth"|"reachable"|"unreachable"} ProbeOutcome
 */

/**
 * @typedef {object} ProbeResult
 * @property {ProbeOutcome} result
 * @property {string} [error] cause, present unless `result` is `ok`
 */

// Statuses that mean "we reached the endpoint, we merely lack usable
// credentials for it" — see the header note above.
export const AUTH_REJECTED_STATUSES = new Set([401, 403]);

/**
 * Bearer auth headers for a key, or undefined to probe unauthenticated.
 * @param {string} [key]
 * @returns {Record<string, string>|undefined}
 */
export function bearerHeaders(key) {
	return key ? { Authorization: `Bearer ${key}` } : undefined;
}

/**
 * Fetch an OpenAI-compatible `/models` listing, tolerating peers that serve it
 * under `/v1/models` instead of `/models`.
 * @param {string} serverUrl base URL, with or without the `/v1` suffix
 * @param {Record<string, string>} [headers]
 * @returns {Promise<RawModelEntry[]>} entries with a truthy `id`
 * @throws {HttpError} `status` is set when the endpoint answered non-2xx
 */
export async function fetchModelEntries(serverUrl, headers) {
	let url = `${serverUrl}/models`;
	let res = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (res.status === 404 && !url.endsWith("/v1/models")) {
		url = `${serverUrl}/v1/models`;
		res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}
	if (!res.ok) {
		throw /** @type {HttpError} */ (
			Object.assign(
				new Error(`GET ${url} -> ${res.status} ${res.statusText}`),
				{ status: res.status },
			)
		);
	}
	/** @type {unknown} */
	const body = await res.json();
	const container = /** @type {{ data?: unknown, models?: unknown }} */ (body);
	const data = container.data ?? container.models ?? body;
	if (!Array.isArray(data)) {
		throw new Error(`GET ${url} returned no models array`);
	}
	return /** @type {RawModelEntry[]} */ (data).filter((entry) =>
		Boolean(entry?.id),
	);
}

/**
 * Probe an endpoint and classify the outcome (see ProbeOutcome).
 * @param {string} baseUrl
 * @param {Record<string, string>} [headers]
 * @returns {Promise<ProbeResult>}
 */
export async function probeDirect(baseUrl, headers) {
	try {
		await fetchModelEntries(baseUrl, headers);
		return { result: "ok" };
	} catch (err) {
		const { message, status } = /** @type {HttpError} */ (err);
		if (status !== undefined && AUTH_REJECTED_STATUSES.has(status)) {
			return { result: "auth", error: message };
		}
		return {
			result: status === undefined ? "unreachable" : "reachable",
			error: message,
		};
	}
}

/**
 * Probe candidate base URLs in order; the first one whose catalog passes
 * `accept` wins. Authenticated with $PEER_API_KEY when set — the peer router's
 * bearer key, distinct from the per-provider keys the direct probes use.
 * @param {string[]} candidates
 * @param {(ids: string[]) => boolean} accept does this catalog serve our concern?
 * @returns {Promise<PeerSource|null>} null when no candidate is usable
 */
export async function probeCandidates(candidates, accept) {
	const failures = [];
	for (const baseUrl of candidates) {
		try {
			const entries = await fetchModelEntries(
				baseUrl,
				bearerHeaders(process.env.PEER_API_KEY?.trim()),
			);
			const ids = entries.map((e) => e.id);
			if (!accept(ids)) throw new Error("no usable models for this concern");
			return { baseUrl, entries };
		} catch (err) {
			const { message } = /** @type {HttpError} */ (err);
			failures.push(`${baseUrl}: ${message}`);
		}
	}
	if (failures.length) logWarn("peer candidate endpoints failed", { failures });
	return null;
}
