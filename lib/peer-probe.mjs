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
 * The peer base URL — the bazzite tailscale funnel (docs/d027), sourced from
 * the vault: `PEER_BASE_URL` in infisical's /inference path, injected by
 * lib/environment.sh alongside the key it pairs with (PEER_API_KEY — the peer's
 * base URL and the peer's bearer are one config unit). One definition
 * (docs/d024): the URL was previously hardcoded here as DEFAULT_PEER_FALLBACK
 * — a second copy of the value the committed models.json already embeds —
 * and threaded through the generators as a two-candidate probe cascade.
 * The funnel serves the whole `<funnel-id>` route to llm-reverse-proxy on
 * host port 8080 (docs/d027), which path-prefix routes everything behind it:
 *
 *   - `/<providerId>` → that cloud provider's real (full) base URL, byte
 *     for byte — no model-id magic, no key injection (docs/d027). Cloud
 *     providers are addressed as peerProviderUrl(peerBase, id) =
 *     `<peerBase>/<id>`.
 *   - `/llama-swap/…` → http://127.0.0.1:8101, the LOCAL GGUF llama-swap
 *     instance (LAN 8101; its /v1 OpenAI surface and model-id magic are
 *     unchanged behind the prefix — addressed by
 *     generate-local-llama-swap.mjs / generate-opencode.jsonc.mjs's local
 *     probe as peerProviderUrl(peerBase, "llama-swap")).
 *
 * No localhost candidate exists beside it — the LAN :8080 (proxy) and :8101
 * (llama-swap) listen addresses are only ever *local* listen addresses
 * (docs/d022).
 *
 * @returns {string} peer base URL, no trailing slash
 */
export function peerBaseUrl() {
	const base = process.env.PEER_BASE_URL?.replace(/\/+$/, "").trim();
	if (!base) {
		throw new Error(
			"PEER_BASE_URL is not set — expected from the vault (infisical /inference/PEER_BASE_URL, loaded by the explicit chain: ./lib/environment.sh <script>)",
		);
	}
	return base;
}

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
 * the same concepts differently; Google's Gemini API serves `name` —
 * `models/<id>` — instead of `id`, normalized by fetchModelEntries).
 * @typedef {object} RawModelEntry
 * @property {string} id
 * @property {string} [name]
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

// Statuses that mean "this peer path-route does not deliver to the provider"
// (see probePeerRoute's header): the route is missing (404 — the funnel's
// default-404 or the proxy's unknown-provider problem detail) or the
// proxy→upstream leg failed/timed out (502/504). Never emitted as a route.
export const DEAD_ROUTE_STATUSES = new Set([404, 502, 504]);

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
 * under `/v1/models` instead of `/models` and upstreams that spell the model
 * identity as `name` instead of `id` (Google's Gemini API serves
 * `{ name: "models/<id>", ... }` entries — the `models/` prefix is stripped
 * so the entry's id matches the wire id pi would send).
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
	return /** @type {RawModelEntry[]} */ (data)
		.map((entry) => {
			if (entry?.id || !entry?.name) return entry;
			// Gemini shape: name = "models/<id>" — publish the bare wire id.
			const id = String(entry.name).replace(/^models\//, "");
			return id ? { ...entry, id } : entry;
		})
		.filter((entry) => Boolean(entry?.id));
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
 * The peer's path-prefix route for ONE provider on the simplified cloud
 * router: `<peerBase>/<providerId>` (docs/d027). The deployed
 * llm-reverse-proxy.json maps each provider id to that provider's FULL real
 * base URL (the `baseUrl` facts in lib/cloud-providers.mjs), so the client
 * route is deterministic — every cloud provider sits one path segment below
 * the peer base, never under a shared `/v1`.
 * @param {string} peerBaseUrl peer base candidate (no trailing slash required)
 * @param {string} providerId the provider's peer path segment
 * @returns {string} e.g. `https://…/<uuid>/hyper`
 */
export function peerProviderUrl(peerBaseUrl, providerId) {
	return `${peerBaseUrl.replace(/\/+$/, "")}/${providerId}`;
}

/**
 * A single peer path-route probe result. `usable` is the generator-facing
 * verdict: does the route exist and deliver to the provider?
 * @typedef {object} PeerRouteResult
 * @property {boolean} usable
 * @property {ProbeOutcome} result
 * @property {RawModelEntry[]} entries the listing (only when `result` is
 *   `ok`; empty otherwise — a 401/403 or an unexpected answer proves the
 *   route but yields no models)
 * @property {string} [error]
 */

/**
 * Probe ONE provider's peer path-route (`<peerProviderUrl>/models`). Same
 * reachability semantics as probeDirect — ANY http response proves the path
 * — with three exceptions, all of them "the response did not come from the
 * provider's endpoint" rather than "the provider refused us":
 *
 *   - 404 is NOT usable: the funnel's default-404 (llama-swap answering for
 *     an unmanaged prefix) and llm-reverse-proxy's unknown-provider problem
 *     detail both look exactly like this — and so would a misconfigured
 *     upstream base. A route that 404s on `/models` cannot be trusted to
 *     deliver, so it is never emitted.
 *   - 502 is NOT usable: it is llm-reverse-proxy's own RFC 9457 problem
 *     detail meaning the proxy→upstream leg failed (see its README) — the
 *     provider was not reached.
 *   - 504 is NOT usable: the same leg timed out (funnel/proxy level; a
 *     provider that times out a GET /models is not delivering either).
 *
 * Everything else — 401/403 credential gates and any other provider answer —
 * is `usable`: the route delivered to the real endpoint; the generator
 * legitimately probes without provider keys, and pi resolves its own key at
 * request time. 200 with a parseable listing additionally yields the
 * provider's live model entries.
 * @param {string} providerUrl the provider's peer route (peerProviderUrl)
 * @param {Record<string, string>} [headers] the provider's real bearer when
 *   the caller has the key, else undefined (unauthenticated probes get
 *   401/403, which still classify the route as usable)
 * @returns {Promise<PeerRouteResult>}
 */
export async function probePeerRoute(providerUrl, headers) {
	try {
		const entries = await fetchModelEntries(providerUrl, headers);
		return { usable: true, result: "ok", entries };
	} catch (err) {
		const { message, status } = /** @type {HttpError} */ (err);
		if (status === undefined || DEAD_ROUTE_STATUSES.has(status)) {
			return {
				usable: false,
				result: "unreachable",
				error: message,
				entries: [],
			};
		}
		return {
			usable: true,
			result: AUTH_REJECTED_STATUSES.has(status) ? "auth" : "reachable",
			entries: [],
			error: message,
		};
	}
}

/**
 * Probe one provider's peer path-route across candidate peer bases in order
 * (the vault-sourced peer base, peerBaseUrl()); the first
 * candidate whose route is usable wins. This is the cloud counterpart of
 * probeCandidates: routing is per provider (`<peerBase>/<id>`), so each
 * provider probes its own route instead of one shared catalog.
 * @param {string[]} candidates peer base URLs (trailing slashes tolerated)
 * @param {string} providerId the provider's peer path segment
 * @param {Record<string, string>} [headers] see probePeerRoute
 * @returns {Promise<({ url: string } & PeerRouteResult)|null>} null when no
 *   candidate route is usable
 */
export async function probePeerRoutes(candidates, providerId, headers) {
	const failures = [];
	for (const base of candidates) {
		const url = peerProviderUrl(base, providerId);
		const route = await probePeerRoute(url, headers);
		if (route.usable) return { url, ...route };
		failures.push(`${url}: ${route.error ?? route.result}`);
	}
	if (failures.length) logWarn("peer provider routes failed", { failures });
	return null;
}

/**
 * Probe candidate base URLs in order; the first one whose catalog passes
 * `accept` wins. Authenticated with $PEER_API_KEY when set — llama-swap's
 * own client-facing bearer key (used for the LOCAL GGUF /v1 route; the
 * cloud path-routes are probed per provider via probePeerRoutes instead,
 * docs/d027).
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
