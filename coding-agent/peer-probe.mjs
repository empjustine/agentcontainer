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
 * response (dns failure, connection refused, tls failure — a bogus certificate
 * with verification ON dies BEFORE any status —, timeout) or a 5xx server-error
 * response (the endpoint saying it cannot serve right now) is evidence that an
 * endpoint is unusable and a peer fallback is justified.
 *
 * TLS verification is REQUIRED for every https route. With verification ON the
 * handshake refuses a bogus certificate before any request byte (headers
 * included) is written, so a credentialed probe can never reach an impostor.
 * With verification OFF (NODE_TLS_REJECT_UNAUTHORIZED=0) the handshake accepts
 * anything, so an https answer — and any credential sent with it — belongs to
 * whoever terminated the TLS, never the claimed host: those probes FAIL CLOSED
 * (tlsUnverifiable — no request, no route certified, docs/d033). Plain-http
 * peers remain usable as the operator's explicit emergency choice (there is no
 * TLS to verify; the plaintext-credential risk is theirs to accept). See
 * docs/d022 for the history and probeDirect for the classification.
 *
 * Import convention (docs/d023, d039): this module lives beside its consumers
 * in coding-agent/ but keeps the LIB_DIR resolution for the shared logger —
 * `process.env.LIB_DIR ?? "<this dir>/../lib"` — so in-place runs and the
 * d023 scratch staging (generators at the root, lib in $LIB_DIR) both work.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR =
	process.env.LIB_DIR ??
	join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const { logWarn } = /** @type {typeof import("../lib/log.mjs")} */ (
	await import(`${LIB_DIR}/log.mjs`)
);

/**
 * Route this module's fetch() calls through `http(s)_proxy` when set
 * (rationale: docs/d001 §1). Shared by every fetch here;
 * coding-agent/refresh-models-dev.mjs calls it too. Kept defensive: a missing undici
 * install only drops proxy support.
 */
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
				{ error: err },
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
 *     generate-pi-coding-agent.mjs / generate-opencode.mjs's local
 *     probe as peerProviderUrl(peerBase, "llama-swap")).
 *
 * No localhost candidate exists beside it — the LAN :8080 (proxy) and :8101
 * (llama-swap) listen addresses are only ever *local* listen addresses
 * (docs/d022).
 *
 * @returns {string} peer base URL (first candidate), no trailing slash
 */
export function peerBaseUrl() {
	const bases = peerBaseUrls();
	if (bases.length === 0) {
		throw new Error(
			"PEER_BASE_URL is not set — expected from the vault (infisical /inference/PEER_BASE_URL, loaded by the explicit chain: ./lib/environment.sh <script>)",
		);
	}
	return bases[0];
}

/**
 * All peer base URL candidates — reads `PEER_BASE_URLS` (comma or newline
 * delimited), falls back to `PEER_BASE_URL` as a single-entry list.
 * This enables multi-hop proxy chains: each generator's `CLOUD_PEER_CANDIDATES`
 * is populated from this function, and `probePeerRoutes()` probes them in
 * order until a usable route is found (or all are exhausted).
 * @returns {string[]} peer base URL candidates, no trailing slashes, empty
 *   when neither env var is set
 */
export function peerBaseUrls() {
	const raw = process.env.PEER_BASE_URLS || process.env.PEER_BASE_URL || "";
	return raw
		.split(/[\n,]/)
		.map((s) => s.trim().replace(/\/+$/, ""))
		.filter(Boolean);
}

/**
 * An error that carries the http status when the failure came from a response
 * (vs. a transport-level failure, which has no status at all). The message is
 * a static label; the dynamic detail (`status`, `statusText`, `url`) lives on
 * the attached properties so the logger keeps it as structured fields, never
 * interpolated prose (docs/d045).
 * @typedef {Error & { status?: number, statusText?: string, url?: string }} HttpError
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
 *   fine even though the answer was not a model list (other 4xx/429/redirects).
 * - `unreachable` — no http response at all (dns/conn-refused/tls/timeout), or
 *   a 5xx server-error response: the endpoint answered but is NOT usable right
 *   now (outage/overload). Routing a layer at a dead URL just ships errors, so
 *   a down endpoint must drop into the same peer-fallback bucket — the peer
 *   route probes already refuse 502/504 the same way (DEAD_ROUTE_STATUSES).
 * Only `unreachable` justifies rerouting a provider through the peer.
 * @typedef {"ok"|"auth"|"reachable"|"unreachable"} ProbeOutcome
 */

/**
 * @typedef {object} ProbeResult
 * @property {ProbeOutcome} result
 * @property {HttpError} [error] the failure itself — message is the static
 *   label, the attached properties (status/statusText/url) carry the detail
 *   (docs/d045); present unless `result` is `ok`
 */

/**
 * Statuses that mean "we reached the endpoint, we merely lack usable
 * credentials for it" — see the header note above.
 * @type {ReadonlySet<number>}
 */
export const AUTH_REJECTED_STATUSES = new Set([401, 403]);

/**
 * Statuses that mean "this peer path-route does not deliver to the provider"
 * (see probePeerRoute's header): the route is missing (404 — the funnel's
 * default-404 or the proxy's unknown-provider problem detail) or the
 * proxy→upstream leg failed/timed out (502/504). Never emitted as a route.
 * @type {ReadonlySet<number>}
 */
export const DEAD_ROUTE_STATUSES = new Set([404, 502, 504]);

// TLS-verification state, decided once and read by every probe: the process
// either enforces certificates (the default; NODE_TLS_REJECT_UNAUTHORIZED=1
// re-states it) or accepts any presented one (=0). With verification ON a
// bogus-cert MITM never completes — the handshake dies before any request byte
// is written, so a credentialed probe can never reach an impostor. With
// verification OFF a MITM completes and an https answer — plus any credential
// sent with it — belongs to whoever terminated the TLS, not the claimed host.
// That is why unverified https is not a valid reachability scenario
// (docs/d033): those endpoints are never probed and never certified. Plain-http
// peers stay usable as the operator's explicit emergency choice — no TLS to
// verify, plaintext-credential risk accepted by the operator (a LAN
// llama-swap/funnel front behind an http URL is the common shape).
const TLS_UNVERIFIED = process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
if (TLS_UNVERIFIED) {
	logWarn(
		"TLS verification disabled (NODE_TLS_REJECT_UNAUTHORIZED=0) — https endpoints fail closed; only plain-http emergency peers are used",
	);
}

/**
 * Whether an endpoint URL cannot be trusted under this runtime's TLS state:
 * true only for https URLs while certificate verification is disabled. http
 * URLs are never blocked — the operator's explicit emergency peer may be
 * plaintext.
 * @param {string} url
 * @returns {boolean}
 */
export function tlsUnverifiable(url) {
	return TLS_UNVERIFIED && /^https:\/\//i.test(url);
}

/**
 * Generation-side peers-only mode (`PEERS_ONLY=1`): the operator declares this
 * host reaches cloud providers only through the peer funnel, so the generators
 * skip the direct (cloud API) probe entirely and go straight to the peer
 * path-route cascade (docs/d033). Saves the per-provider probe timeouts on
 * exactly the hosts the peer exists for. Distinct from the archived
 * SERVING-side PEERS_ONLY (docs/archive/peer-variant-work.md — cloud peers
 * served, no local models): this is the generation-side knob the coding-agent
 * generators read.
 * @returns {boolean}
 */
export function peersOnly() {
	return process.env.PEERS_ONLY === "1";
}

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
			Object.assign(new Error("models listing answered non-2xx"), {
				status: res.status,
				statusText: res.statusText,
				url,
			})
		);
	}
	/** @type {unknown} */
	const body = await res.json();
	const container = /** @type {{ data?: unknown, models?: unknown }} */ (body);
	const data = container.data ?? container.models ?? body;
	if (!Array.isArray(data)) {
		throw /** @type {HttpError} */ (
			Object.assign(new Error("models listing returned no models array"), {
				url,
			})
		);
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
	// Unverified https is NOT a reachability scenario at all: with verification
	// disabled anyone can answer the handshake, so an ok/auth verdict — and the
	// credentialed request that would produce it — belongs to whoever answered,
	// never the provider (docs/d033, header). Fail closed with no request, so
	// the provider key is never handed to an impostor. Plain-http endpoints
	// (the operator's emergency peers) are unaffected — nothing to verify.
	if (tlsUnverifiable(baseUrl)) {
		return {
			result: "unreachable",
			error: Object.assign(
				new Error("TLS verification disabled — https route not trusted"),
				{ url: baseUrl },
			),
		};
	}
	try {
		await fetchModelEntries(baseUrl, headers);
		return { result: "ok" };
	} catch (err) {
		const http = normalizedProbeError(err);
		if (http.status !== undefined && AUTH_REJECTED_STATUSES.has(http.status)) {
			return { result: "auth", error: http };
		}
		// A 5xx is the endpoint SAYING it cannot serve right now — not a network
		// gap and not a credential gate. An http response proves reachability,
		// but a server-error response proves unusability (docs/d022's "dead
		// endpoint" case): rerouting at a 5xx'ing URL just ships errors instead
		// of the peer path-route. Same family the peer routes already refuse
		// (DEAD_ROUTE_STATUSES — 502/504 are llm-reverse-proxy's proxy→upstream
		// problem detail), and it self-heals: the next generation run re-probes
		// and returns to direct once the provider answers 2xx again.
		if (http.status !== undefined && http.status >= 500 && http.status <= 599) {
			return { result: "unreachable", error: http };
		}
		return {
			result: http.status === undefined ? "unreachable" : "reachable",
			error: http,
		};
	}
}

/**
 * Guarantee a probe failure is always an Error with the HttpError shape: a
 * non-Error throw (or an error-less classification) must still produce a
 * structured value, never an undefined `error` field on a non-ok result —
 * that is exactly the "generic message with no cause" record d045 forbids.
 * @param {unknown} err
 * @returns {HttpError}
 */
function normalizedProbeError(err) {
	if (err instanceof Error) return /** @type {HttpError} */ (err);
	return Object.assign(new Error("probe threw a non-Error value"), {
		thrown: String(err),
	});
}

// SuppressedError (explicit resource management) is missing from some
// @types/node versions, so checkJs cannot see the global — alias through
// globalThis with an explicit constructor type; runtime `new` is unchanged.
const SuppressedErrorCtor =
	/** @type {new (error: unknown, suppressed: unknown, message?: string) => Error & { error?: unknown, suppressed?: unknown }} */ (
		/** @type {any} */ (globalThis).SuppressedError
	);

/**
 * A probe that did NOT deliver the expected listing, packaged for logging as
 * a SuppressedError: the expectation is the message label, the probe's
 * failure is chained as `error`, and the classification rides as an attached
 * property. Every "expected X but got Y — did Z instead" record composes
 * this so the log line is self-sufficient — never a generic label with no
 * cause, even if the probe somehow ends up error-less (docs/d045).
 * @param {ProbeResult|PeerRouteResult} probe
 * @param {string} expectation static label of what the caller expected
 * @returns {Error & { error?: unknown, suppressed?: unknown, result: ProbeOutcome }}
 */
export function suppressedProbe(probe, expectation) {
	const failure =
		probe.error ??
		normalizedProbeError(
			Object.assign(new Error("probe classification without an error object"), {
				result: probe.result,
			}),
		);
	return /** @type {Error & { error?: unknown, suppressed?: unknown, result: ProbeOutcome }} */ (
		Object.assign(new SuppressedErrorCtor(failure, undefined, expectation), {
			result: probe.result,
		})
	);
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
 * @property {HttpError} [error] the failure itself, docs/d045 shape
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
		const http = normalizedProbeError(err);
		if (http.status === undefined || DEAD_ROUTE_STATUSES.has(http.status)) {
			return {
				usable: false,
				result: "unreachable",
				error: http,
				entries: [],
			};
		}
		return {
			usable: true,
			result: AUTH_REJECTED_STATUSES.has(http.status) ? "auth" : "reachable",
			entries: [],
			error: http,
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
		// Same fail-closed rule as probeDirect: an unverifiable https route is
		// never probed and never certified — a credentialed probe could leak the
		// provider key to whoever answered the handshake. https candidates are
		// skipped; http (emergency) candidates still count.
		if (tlsUnverifiable(base)) {
			failures.push({
				url,
				result: "unreachable",
				error: Object.assign(
					new Error("TLS verification disabled — https route not trusted"),
					{ url },
				),
			});
			continue;
		}
		const route = await probePeerRoute(url, headers);
		if (route.usable) return { url, ...route };
		failures.push({ url, result: route.result, error: route.error });
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
		// Fail closed on unverifiable https bases, same rule as probeDirect;
		// http (emergency) candidates still count.
		if (tlsUnverifiable(baseUrl)) {
			failures.push({
				baseUrl,
				error: Object.assign(
					new Error("TLS verification disabled — https route not trusted"),
					{ url: baseUrl },
				),
			});
			continue;
		}
		try {
			const entries = await fetchModelEntries(
				baseUrl,
				bearerHeaders(process.env.PEER_API_KEY?.trim()),
			);
			const ids = entries.map((e) => e.id);
			if (!accept(ids)) throw new Error("no usable models for this concern");
			return { baseUrl, entries };
		} catch (err) {
			failures.push({ baseUrl, error: err });
		}
	}
	if (failures.length) logWarn("peer candidate endpoints failed", { failures });
	return null;
}
