/**
 * @fileoverview route-probe.mjs — shared HTTP probe + route toolkit for the
 * coding-agent generators (pi `models.json` layers, opencode config
 * layers). Owns everything about "ask an OpenAI-compatible
 * endpoint for its `/models` listing": auth headers, the 8 s timeout, the
 * `/v1/models` retry, status-carrying errors, and the classification that
 * decides WHICH LINEUP SOURCE a generator may use. It also owns the CLIENT
 * ROUTE derivation: `providerRouteUrl` (the d047 host-form
 * `<base>/<upstream-host><base-path>`) and `routeUrlFromCanonical`, the
 * install-time rewrite from a committed canonical upstream URL to that route
 * (docs/d070).
 *
 * Routing is no longer a probe decision (docs/d063, narrowed further by
 * d070): committed artifacts carry each provider's REAL upstream URL (the
 * fact table), and generate.mjs substitutes the reverse-proxy route only when
 * copying an artifact into a host config dir. A probe says whether the live
 * listing behind a route can be trusted right now — a usable listing feeds
 * the lineup, anything else drops the lineup to the catalog/facts cache.
 * There is deliberately no branch that falls back to a direct endpoint or to
 * pi/opencode built-in routing.
 *
 * The canonical "reachable ≠ authenticated" rule (previously pasted in three
 * generators — this header is now the only copy): a 401/403 is what an
 * OpenAI-compatible endpoint returns to any unauthenticated request, and the
 * generators legitimately run without provider keys (pi/opencode resolve
 * their own key / OAuth login at request time). Such a response proves the
 * NETWORK PATH works — enough to prove the route, never enough to drop a
 * provider (omission would restore built-in direct routing, docs/d063), and
 * never a reason to fetch anything from a direct endpoint. Only the absence
 * of ANY http response (dns failure, connection refused, tls failure — a
 * bogus certificate with verification ON dies BEFORE any status —, timeout)
 * or a 5xx server-error response means the route cannot deliver at all
 * (DEAD_ROUTE_STATUSES) — and even then the installed URL stays on the
 * proxy, with the stale catalog as lineup.
 *
 * TLS verification is REQUIRED for every https route. With verification ON the
 * handshake refuses a bogus certificate before any request byte (headers
 * included) is written, so a credentialed probe can never reach an impostor.
 * With verification OFF (NODE_TLS_REJECT_UNAUTHORIZED=0) the handshake accepts
 * anything, so an https answer — and any credential sent with it — belongs to
 * whoever terminated the TLS, never the claimed host: those probes FAIL CLOSED
 * (tlsUnverifiable — no request, no route certified, docs/d033). Plain-http
 * emergency bases remain usable as the operator's explicit choice (there is no
 * TLS to verify; the plaintext-credential risk is theirs to accept). See
 * docs/d022 for the history, docs/d063 for the routing rule, docs/d070 for
 * the canonical-URL contract, docs/d071 for the vocabulary, and probeRoute
 * for the classification.
 *
 * Import convention (docs/d023, d039): this module lives beside its consumers
 * in coding-agent/ but keeps the LIB_DIR resolution for the shared logger —
 * `process.env.LIB_DIR ?? "<this dir>/../lib"` — so a folder copied out of
 * this tree (the docs/architecture.md copy unit) still finds `../lib`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR =
	process.env.LIB_DIR ??
	join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const { logWarn } = /** @type {typeof import("../lib/log.mjs")} */ (
	await import(`${LIB_DIR}/log.mjs`)
);
// The v2 host-form route (providerRouteUrl) is derived from the SAME
// fact-table base URLs the llm-reverse-proxy allowlist is generated from —
// one source of truth for "which upstream does this provider sit on"
// (docs/d047).
const { PROVIDER_BASE_URLS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);

// Proxy env is handled by Node itself: NODE_USE_ENV_PROXY=1 (set by
// lib/node-run.sh and the coding-agent image, docs/d074) makes global fetch()
// and http/https honor HTTP(S)_PROXY / NO_PROXY natively. The former undici
// EnvHttpProxyAgent setGlobalDispatcher monkey-patch is retired — a repo-side
// dispatcher would only shadow the native one and drift from it. Requires
// node >= 22.21 / 24 (the versions that added the variable).

const REQUEST_TIMEOUT_MS = 8000;

/**
 * The reverse-proxy base URL — the vault-sourced funnel entry point to
 * llm-reverse-proxy (docs/d027), read from `REVERSE_PROXY_BASE_URLS` in
 * infisical's /inference path (the ONLY base env this repo reads, d071 §1;
 * the vault still sets the retired `PEER_BASE_URL(S)` beside it for
 * outside compatibility — nothing here reads that), injected by
 * lib/environment.sh alongside the key it pairs with (REVERSE_PROXY_API_KEY — the
 * base URL and the client-facing bearer are one config unit). The funnel serves the whole `<funnel-id>` route to
 * llm-reverse-proxy on host port 8080 (docs/d027), which path-prefix routes
 * everything behind it:
 *
 *   - v2 HOST routing (docs/d047): `/<upstream-host>/<path>` → that host's
 *     allowlisted upstream root, byte for byte — no model-id magic, no key
 *     injection. Providers are addressed as providerRouteUrl(base, id) =
 *     `<base>/<upstream-host><full-upstream-base-path>`; the allowlist
 *     carries only the owner's stack, everything else is denied by absence
 *     (the plain funnel 404).
 *   - llama-swap (the local GGUF farm, LAN 8101) is served on its own
 *     tsnet-only `tailscale serve` hostname and is a fact-table row like any
 *     other provider (docs/d070): its route is
 *     providerRouteUrl(base, "llama-swap"), no loopback and no logical-name
 *     exception anywhere in client configs.
 *
 * No localhost candidate exists beside it — the LAN :8080 (proxy) listen
 * address is only ever a *local* listen address (docs/d022).
 *
 * @returns {string} reverse-proxy base URL (first candidate), no trailing
 *   slash
 */
export function reverseProxyBaseUrl() {
	// The undefined check IS the emptiness check (an empty array indexes to
	// undefined), and it is the form noUncheckedIndexedAccess can verify.
	const first = reverseProxyBaseUrls()[0];
	if (first === undefined) {
		throw new Error(
			"REVERSE_PROXY_BASE_URLS is not set — expected from the vault (infisical /inference, loaded by the explicit chain: ./lib/environment.sh <script>)",
		);
	}
	return first;
}

/**
 * True when a base entry is safe to string-concatenate into a route. The
 * LITERAL prefix check is the load-bearing half: WHATWG URL parsing
 * normalizes `https:/models.dev/api.json` to the DIRECT upstream
 * `https://models.dev/api.json`, so a degenerate `https:/` base would
 * silently emit the one wire shape d063 forbids — parsing alone can never
 * catch it. The parse is kept for the cases parsing does catch (no host,
 * garbage).
 * @param {string} base slash-trimmed entry
 * @returns {boolean}
 */
function isUsableProxyBase(base) {
	if (!/^https?:\/\//i.test(base)) {
		return false;
	}
	try {
		return new URL(base).host !== "";
	} catch {
		return false;
	}
}

/**
 * All reverse-proxy base URL candidates — reads `REVERSE_PROXY_BASE_URLS`
 * (comma or newline delimited), THE one env this repo reads for the base
 * (d071 §1; a single base is a single-entry list — no singular fallback, and
 * the retired `PEER_BASE_URL(S)` names, still set in the vault for outside
 * compatibility, are never read here). Multi-hop proxy chains are why the
 * plural exists: each generator's `REVERSE_PROXY_BASE_CANDIDATES` is
 * populated from this function, and `probeRoutes()` probes them in order
 * until a usable route is found (or all are exhausted). Unusable entries
 * are dropped with a warning, never repaired (see isUsableProxyBase); if
 * that empties the list, requireInstallBase() fails the generation loudly.
 * @returns {string[]} reverse-proxy base URL candidates, no trailing
 *   slashes, empty when the env var is not set
 */
export function reverseProxyBaseUrls() {
	return (process.env.REVERSE_PROXY_BASE_URLS || "")
		.split(/[\n,]/)
		.map((s) => s.trim().replace(/\/+$/, ""))
		.filter((raw) => {
			if (!raw) {
				return false;
			}
			if (isUsableProxyBase(raw)) {
				return true;
			}
			logWarn("base entry dropped — not an absolute http(s) URL with a host", {
				entry: raw,
			});
			return false;
		});
}

/**
 * The reverse-proxy-only fetch chain for a STATIC upstream's metadata
 * (docs/d063 §5): models.dev/catwalk refreshes may not fall back to the
 * upstream's real host — every candidate here is a reverse-proxy URL.
 *
 *   - `envOverride` set non-empty → that URL alone (the operator's own
 *     relay; MODELS_DEV_RELAY_URL keeps its docs/d027 name and meaning);
 *   - `envOverride` set empty → no relay at all: the consumer keeps its
 *     stale vendored copy (a file, not a wire URL — always in scope);
 *   - `envOverride` unset → the vault-sourced bases' host-form routes
 *     `<base>/<host>/<path>`, one candidate per configured base, in order
 *     (docs/d047 — the allowlist carries both passthrough hosts). There is
 *     deliberately NO implicit 127.0.0.1:8080 candidate (d063 §5 as
 *     amended): it presumed a same-host proxy, so on every host without
 *     one it was a guaranteed-refused first probe — and inside the
 *     agentcontainer loopback can never reach a proxy that runs outside
 *     it. An operator running llm-reverse-proxy beside the generator
 *     lists `http://127.0.0.1:8080` as a base entry; a degenerate entry
 *     is dropped by reverseProxyBaseUrls(), never concatenated.
 *
 * @param {string} upstream host the proxy allowlist keys on ("models.dev", …)
 * @param {string} pathAndQuery path + query under that host (leading slash)
 * @param {string} [envOverride] full URL, "" (disabled), or undefined (default chain)
 * @returns {string[]} candidates in probe order; empty = stale copy only
 */
export function relayCandidates(upstream, pathAndQuery, envOverride) {
	if (envOverride !== undefined) {
		const trimmed = envOverride.trim();
		if (!trimmed) {
			return [];
		}
		if (isUsableProxyBase(trimmed)) {
			return [trimmed];
		}
		logWarn("relay URL dropped — not an absolute http(s) URL with a host", {
			entry: trimmed,
		});
		return [];
	}
	const suffix = `${upstream}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
	return reverseProxyBaseUrls().map((base) => `${base}/${suffix}`);
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
 * `/v1/models` under `meta.llamaswap`, already pi-shaped). `cost` is Partial
 * because the mirror is verbatim: the config may carry an empty or partial
 * price block, which gen-lib's piCost() has to normalize on the way out.
 * @typedef {object} LlamaSwapMeta
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {boolean} [reasoning]
 * @property {string[]} [input]
 * @property {Partial<Cost>} [cost]
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
 * A source candidate that answered with a usable `/models` listing.
 * @typedef {object} ProbeSource
 * @property {string} baseUrl
 * @property {RawModelEntry[]} entries
 */

/**
 * Outcome of probing an endpoint (docs/d063: the answer selects the LINEUP
 * source, never the route):
 * - `ok` — 2xx with a parseable model list: the live listing may feed the
 *   lineup.
 * - `auth` — 401/403: the request reached the endpoint; we merely have no
 *   usable credentials here (reachable ≠ authenticated) — route probes still
 *   classify the route usable, the catalog becomes the lineup.
 * - `reachable` — some other http response: the path is fine even though the
 *   answer was not a model list (other 4xx/429/redirects).
 * - `unreachable` — no http response at all (dns/conn-refused/tls/timeout), or
 *   a 5xx server-error response: nothing was delivered. Route probes refuse
 *   the dead-route family (DEAD_ROUTE_STATUSES); the emitted URL still points
 *   at the proxy — only the lineup falls back to the stale catalog/facts
 *   cache.
 * @typedef {"ok"|"auth"|"reachable"|"unreachable"} ProbeOutcome
 */

/**
 * Statuses that mean "we reached the endpoint, we merely lack usable
 * credentials for it" — see the header note above.
 * @type {ReadonlySet<number>}
 */
const AUTH_REJECTED_STATUSES = new Set([401, 403]);

/**
 * Statuses that mean "this route does not deliver to the provider"
 * (see probeRoute's header): the route is missing (404 — the funnel's
 * default-404 or the proxy's unknown-provider problem detail) or the
 * proxy→upstream leg failed/timed out (502/504). Never emitted as a route.
 * @type {ReadonlySet<number>}
 */
const DEAD_ROUTE_STATUSES = new Set([404, 502, 504]);

// TLS-verification state, decided once and read by every probe: the process
// either enforces certificates (the default; NODE_TLS_REJECT_UNAUTHORIZED=1
// re-states it) or accepts any presented one (=0). With verification ON a
// bogus-cert MITM never completes — the handshake dies before any request byte
// is written, so a credentialed probe can never reach an impostor. With
// verification OFF a MITM completes and an https answer — plus any credential
// sent with it — belongs to whoever terminated the TLS, not the claimed host.
// That is why unverified https is not a valid reachability scenario
// (docs/d033): those endpoints are never probed and never certified. Plain-http
// emergency bases stay usable as the operator's explicit choice — no TLS to
// verify, plaintext-credential risk accepted by the operator (a LAN
// llama-swap/funnel front behind an http URL is the common shape).
const TLS_UNVERIFIED = process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
if (TLS_UNVERIFIED) {
	logWarn(
		"TLS verification disabled (NODE_TLS_REJECT_UNAUTHORIZED=0) — https endpoints fail closed; only plain-http emergency bases are used",
	);
}

/**
 * Whether an endpoint URL cannot be trusted under this runtime's TLS state:
 * true only for https URLs while certificate verification is disabled. http
 * URLs are never blocked — the operator's explicit emergency base may be
 * plaintext.
 * @param {string} url
 * @returns {boolean}
 */
export function tlsUnverifiable(url) {
	return TLS_UNVERIFIED && /^https:\/\//i.test(url);
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
 * Fetch an OpenAI-compatible `/models` listing, tolerating endpoints that serve it
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
		...(headers ? { headers } : {}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (res.status === 404 && !url.endsWith("/v1/models")) {
		url = `${serverUrl}/v1/models`;
		res = await fetch(url, {
			...(headers ? { headers } : {}),
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
			if (entry?.id || !entry?.name) {
				return entry;
			}
			/** Gemini shape: name = "models/<id>" — publish the bare wire id. */
			const id = String(entry.name).replace(/^models\//, "");
			return id ? { ...entry, id } : entry;
		})
		.filter((entry) => Boolean(entry?.id));
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
	if (err instanceof Error) {
		return /** @type {HttpError} */ (err);
	}
	return Object.assign(new Error("probe threw a non-Error value"), {
		thrown: String(err),
	});
}

/**
 * The client route for ONE provider on the v2 router (docs/d047):
 * `<base>/<route-name><full-upstream-base-path>`. The first segment is the
 * upstream host the llm-reverse-proxy allowlist keys on (a DNS name); the
 * upstream's base path rides in the CLIENT's base URL, because the
 * allowlisted value is only scheme://host — that is what lets multi-base
 * hosts (opencode vs opencode-go on opencode.ai, minimax's /anthropic
 * variants) share one allowlist row while each client keeps its own path
 * (docs/d047). The provider's real base URL comes from the fact table (the
 * same lib/cloud-providers.mjs `baseUrl` the proxy's allowlist is generated
 * from AND committed artifacts carry verbatim, docs/d070) — llama-swap's
 * tsnet serve hostname is a fact-table row like any other, so there is no
 * logical-name or loopback exception anywhere in the derivation.
 * @param {string} base reverse-proxy base candidate (no trailing slash
 *   required)
 * @param {string} providerId fact-table provider id
 * @returns {string} e.g. `https://…/<uuid>/hyper.charm.land/v1` (the caller
 *   appends the model path — `/models` for a probe, `/v1/chat/completions`
 *   for a client)
 */
export function providerRouteUrl(base, providerId) {
	const upstream = PROVIDER_BASE_URLS[providerId];
	if (!upstream) {
		throw new Error(
			`providerRouteUrl: no fact-table base URL for ${JSON.stringify(providerId)} — the v2 host-form route needs the upstream host (docs/d047)`,
		);
	}
	const u = new URL(upstream);
	const path = u.pathname.replace(/\/+$/, "");
	return `${base.replace(/\/+$/, "")}/${u.host}${path}`;
}

/**
 * The install-time rewrite (docs/d070): a committed CANONICAL upstream URL →
 * the reverse-proxy client route. The canonical URL must be exactly the
 * fact-table upstream (plus an optional client-side suffix such as llama-
 * swap's `/v1`); anything else is an artifact/fact-table disagreement and
 * fails closed rather than emitting a URL that is neither canonical nor
 * routed.
 * @param {string} base reverse-proxy base to substitute under
 * @param {string} providerId fact-table provider id (the artifact's provider
 *   key, already mapped — opencode's `local` maps to `llama-swap`)
 * @param {string} canonicalUrl the committed artifact's provider URL
 * @returns {string} the client route for the same upstream
 * @throws {Error} when the URL is not the fact-table upstream for the id
 */
export function routeUrlFromCanonical(base, providerId, canonicalUrl) {
	const upstream = PROVIDER_BASE_URLS[providerId];
	if (!upstream) {
		throw new Error(
			`routeUrlFromCanonical: no fact-table base URL for ${JSON.stringify(providerId)}`,
		);
	}
	if (canonicalUrl.startsWith(`${base}/`)) {
		throw new Error(
			`routeUrlFromCanonical: ${JSON.stringify(canonicalUrl)} is already under the configured base ${JSON.stringify(base)} — refusing to substitute twice (docs/d070)`,
		);
	}
	if (!canonicalUrl.startsWith(upstream)) {
		throw new Error(
			`routeUrlFromCanonical: ${JSON.stringify(canonicalUrl)} is not the fact-table upstream ${JSON.stringify(upstream)} for ${JSON.stringify(providerId)} — refusing to substitute (docs/d070)`,
		);
	}
	const suffix = canonicalUrl.slice(upstream.length);
	return `${providerRouteUrl(base, providerId)}${suffix}`;
}

/**
 * A single route probe result. `usable` is the generator-facing
 * verdict: does the route exist and deliver to the provider?
 * @typedef {object} RouteResult
 * @property {boolean} usable
 * @property {ProbeOutcome} result
 * @property {RawModelEntry[]} entries the listing (only when `result` is
 *   `ok`; empty otherwise — a 401/403 or an unexpected answer proves the
 *   route but yields no models)
 * @property {HttpError} [error] the failure itself, docs/d045 shape
 */

/**
 * Probe ONE provider's client route (`<providerRouteUrl>/models`). ANY
 * http response proves the path — with three exceptions, all of them
 * "the response did not come from the
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
 * @param {string} providerUrl the provider's client route (providerRouteUrl)
 * @param {Record<string, string>} [headers] the provider's real bearer when
 *   the caller has the key, else undefined (unauthenticated probes get
 *   401/403, which still classify the route as usable)
 * @returns {Promise<RouteResult>}
 */
async function probeRoute(providerUrl, headers) {
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
 * Probe one provider's client route across candidate reverse-proxy bases in
 * order (the vault-sourced base list, reverseProxyBaseUrls()); the first
 * candidate whose route is usable wins. This is the cloud counterpart of
 * probeCandidates: routing is per upstream HOST (providerRouteUrl,
 * docs/d047), so each provider probes its own route instead of one shared
 * catalog.
 * @param {readonly string[]} candidates reverse-proxy base URLs (trailing slashes tolerated)
 * @param {string} providerId fact-table provider id ("llama-swap" for the
 *   local learner)
 * @param {Record<string, string>} [headers] see probeRoute
 * @returns {Promise<({ url: string } & RouteResult)|null>} null when no
 *   candidate route is usable
 */
export async function probeRoutes(candidates, providerId, headers) {
	const failures = [];
	for (const base of candidates) {
		const url = providerRouteUrl(base, providerId);
		// Fail closed on an unverifiable https route: it is never probed and
		// never certified — a credentialed probe could leak the
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
		const route = await probeRoute(url, headers);
		if (route.usable) {
			return { url, ...route };
		}
		failures.push({ url, result: route.result, error: route.error });
	}
	if (failures.length > 0) {
		logWarn("reverse-proxy provider routes failed", { failures });
	}
	return null;
}

/**
 * Probe candidate base URLs in order; the first one whose catalog passes
 * `accept` wins. Authenticated with $REVERSE_PROXY_API_KEY when set — llama-swap's
 * own client-facing bearer key (used for the LOCAL GGUF /v1 route; the
 * cloud path-routes are probed per provider via probeRoutes instead,
 * docs/d027).
 * @param {string[]} candidates
 * @param {(ids: string[]) => boolean} accept does this catalog serve our concern?
 * @returns {Promise<ProbeSource|null>} null when no candidate is usable
 */
export async function probeCandidates(candidates, accept) {
	const failures = [];
	for (const baseUrl of candidates) {
		// Fail closed on unverifiable https bases — the rule every probe in
		// this module applies; http (emergency) candidates still count.
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
				bearerHeaders(process.env.REVERSE_PROXY_API_KEY?.trim()),
			);
			const ids = entries.map((e) => e.id);
			if (!accept(ids)) {
				throw new Error("no usable models for this concern");
			}
			return { baseUrl, entries };
		} catch (err) {
			failures.push({ baseUrl, error: err });
		}
	}
	if (failures.length > 0) {
		logWarn("reverse-proxy base candidates failed", { failures });
	}
	return null;
}
