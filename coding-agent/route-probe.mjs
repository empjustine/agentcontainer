/**
 * @fileoverview route-probe.mjs — shared HTTP probe + route toolkit for the
 * coding-agent generators (pi `models.json` layers, opencode config
 * layers). Owns everything about "ask an OpenAI-compatible
 * endpoint for its `/models` listing": auth headers, the 8 s timeout, the
 * `/v1/models` retry, status-carrying errors, and the classification that
 * decides WHICH LINEUP SOURCE a generator may use.
 *
 * Probes address each provider's CANONICAL upstream (the fact table) and
 * reach the serving edge through the environment proxy — NODE_USE_ENV_PROXY=1
 * plus HTTP(S)_PROXY, both set by lib/node-run.sh and the image (docs/d074),
 * so node's own fetch honors them and no repo-side dispatcher exists. The
 * prefixed reverse-proxy probe (`<base>/<upstream-host>/…`, d047/d063) is
 * gone from this path with the tunnel migration (docs/d108): a probe says
 * whether the live listing is trustworthy at the canonical endpoint right
 * now — a usable listing feeds the lineup, anything else drops the lineup to
 * the catalog/facts cache. There is deliberately no branch that falls back to
 * a direct endpoint bypassing the configured proxy env or to pi/opencode
 * built-in routing.
 *
 * What still derives URLs here is the LEGACY install-time substitution
 * (`providerRouteUrl`, `routeUrlFromCanonical`, docs/d070) and the
 * vault-sourced base list it reads. That is the reverse proxy's remaining
 * client-side dependency, scheduled for removal (docs/d108); nothing in the
 * probe or catalog-fetch path touches it.
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
// fact-table base URLs the estige allowlist is generated from —
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
 * estige (docs/d027), read from `REVERSE_PROXY_BASE_URLS` in
 * infisical's /inference path (d071 §1; the vault still sets the retired
 * `PEER_BASE_URL(S)` beside it for outside compatibility — nothing here
 * reads that), injected by lib/environment.sh alongside the key it pairs
 * with (REVERSE_PROXY_API_KEY — the base URL and the client-facing bearer
 * are one config unit).
 *
 * LEGACY, and being removed (docs/d108): its ONLY remaining consumer is the
 * install-time route substitution in generate.mjs — the client-side half of
 * the deprecated host-allowlist reverse proxy (mode A). Probes no longer read
 * it; they address canonical upstreams through the environment proxy. When
 * the removal diff lands, this whole family (base list, `providerRouteUrl`,
 * `routeUrlFromCanonical`) goes with the reverse proxy it exists to
 * address.
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
 * silently be treated as a proxy base and pass the d070 §5 verifier's
 * prefix check while pointing at the upstream itself.
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
 * compatibility, are never read here). The plural is load-bearing only for
 * the d070 §5 install verifier, which accepts the installed URL under ANY
 * configured base; the substitution itself is under the FIRST entry (d070
 * §4: availability never selects a URL). Unusable entries are dropped with a
 * warning, never repaired (see isUsableProxyBase); if that empties the list,
 * the install-time substitution fails the generation loudly.
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
 * The fetch chain for a STATIC upstream's metadata (models.dev, catwalk):
 * the canonical upstream URL, or the operator's explicit relay override.
 *
 *   - `envOverride` set non-empty → that URL alone (the operator's own
 *     relay; MODELS_DEV_RELAY_URL keeps its docs/d027 name and meaning);
 *   - `envOverride` set empty → no fetch at all: the consumer keeps its
 *     stale vendored copy (a file, not a wire URL — always in scope);
 *   - `envOverride` unset → the ONE canonical URL for that upstream. It
 *     reaches the edge through the environment proxy (NODE_USE_ENV_PROXY=1,
 *     docs/d074), which is the tunnel's job; the generator carries no route.
 *     The prefixed host-form candidates (`<base>/<host>/<path>`) are gone
 *     with the tunnel migration (docs/d108) — a fetch with no proxy env
 *     simply fails to the stale copy, never silently to a URL this repo
 *     derived.
 *
 * @param {string} upstream host of the canonical upstream ("models.dev", …)
 * @param {string} pathAndQuery path + query under that host (leading slash)
 * @param {string} [envOverride] full URL, "" (disabled), or undefined (canonical)
 * @returns {string[]} candidates in probe order; empty = stale copy only
 */
export function upstreamCandidates(upstream, pathAndQuery, envOverride) {
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
	const suffix = `${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
	return [`https://${upstream}${suffix}`];
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
 * upstream host the estige allowlist keys on (a DNS name); the
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
 * A single endpoint probe result. `usable` is the generator-facing
 * verdict: did the endpoint answer, and may its listing be trusted?
 * @typedef {object} RouteResult
 * @property {boolean} usable
 * @property {ProbeOutcome} result
 * @property {RawModelEntry[]} entries the listing (only when `result` is
 *   `ok`; empty otherwise — a 401/403 or an unexpected answer proves the
 *   endpoint but yields no models)
 * @property {HttpError} [error] the failure itself, docs/d045 shape
 */

/**
 * Probe ONE provider's canonical upstream (`<fact baseUrl>/models`), reached
 * through whatever the environment proxy resolves to (docs/d074, d108). ANY
 * http response proves the wire path — with three exceptions, all of them
 * "the response did not come from the provider's endpoint" rather than "the
 * provider refused us":
 *
 *   - 404 is NOT usable: a stale provider path, or an edge detail for an
 *     upstream it does not carry, looks exactly like this — and so would a
 *     misconfigured base URL. An endpoint that 404s on `/models` cannot be
 *     trusted to deliver, so its lineup is never used.
 *   - 502 is NOT usable: it is the relay's own RFC 9457 problem detail
 *     meaning the proxy→upstream leg failed (see estige/README) — the
 *     provider was not reached.
 *   - 504 is NOT usable: the same leg timed out (a provider that times out a
 *     GET /models is not delivering either).
 *
 * Everything else — 401/403 credential gates and any other provider answer —
 * is `usable`: the endpoint answered; the generator legitimately probes
 * without provider keys, and pi resolves its own key at request time. 200
 * with a parseable listing additionally yields the provider's live model
 * entries.
 *
 * TLS verification is required (tlsUnverifiable): with verification OFF no
 * https probe runs at all — a credentialed probe could hand the provider key
 * to whoever answered the handshake (docs/d033).
 * @param {string} url canonical upstream base (fact table)
 * @param {Record<string, string>} [headers] the provider's real bearer when
 *   the caller has the key, else undefined (unauthenticated probes get
 *   401/403, which still classify the endpoint as usable)
 * @returns {Promise<RouteResult>}
 */
export async function probeEndpoint(url, headers) {
	if (tlsUnverifiable(url)) {
		return {
			usable: false,
			result: "unreachable",
			entries: [],
			error: Object.assign(
				new Error("TLS verification disabled — https endpoint not trusted"),
				{ url },
			),
		};
	}
	try {
		const entries = await fetchModelEntries(url, headers);
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
 * Probe candidate base URLs in order; the first one whose catalog passes
 * `accept` wins. Authenticated with $REVERSE_PROXY_API_KEY when set —
 * llama-swap's own client-facing bearer key, the one row whose listing is
 * still keyed by a shared fleet secret (docs/d027). The cloud providers go
 * through probeEndpoint with their own key instead.
 * @param {readonly string[]} candidates
 * @param {(ids: string[]) => boolean} accept does this catalog serve our concern?
 * @returns {Promise<ProbeSource|null>} null when no candidate is usable
 */
export async function probeCandidates(candidates, accept) {
	const failures = [];
	for (const baseUrl of candidates) {
		// Fail closed on unverifiable https bases — the rule every probe in
		// this module applies; plain-http rows (the LAN llama-swap) still count.
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
