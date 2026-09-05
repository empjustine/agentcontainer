/**
 * @fileoverview generate-opencode.jsonc.mjs — Emit opencode's overlay config: one
 * `provider` map holding ONLY the providers whose built-in routing does not work from this
 * host, rewritten to route through the llama-swap peer. This is opencode's counterpart to
 * pi's generate-models.json.mjs — same detection cascade, different output schema.
 *
 * The peer is a llama-swap instance with peer routing enabled: a reverse proxy
 * that listens on /v1/completions, /v1/responses and /v1/messages and routes
 * to the correct upstream model endpoint based on the "model" body. So for
 * every provider, in peer mode, the base URL is simply the peer — opencode
 * keeps using its native protocol and the peer forwards by composite
 * "provider/model" model id (e.g. `opencode/hy3-free`, `openrouter/gpt-4`),
 * which we pass through unchanged. Auth is a bearer PEER_API_KEY (the peer
 * accepts bearer tokens).
 *
 * The emitted file uses opencode's V1 config schema: the provider map lives
 * under the top-level key `provider` (SINGULAR) — `providers` is only a V2 key
 * and is rejected/ignored by the V1 loader (see opencode
 * packages/core/src/v1/config/config.ts, `provider: Schema.Record(...)`).
 *
 * Detection cascade:
 *   1. Cloud providers: if the REAL default endpoint is reachable, opencode's
 *      built-in provider just works — emit nothing. Unreachable + visible via
 *      the peer -> emit an override routing that provider through the peer.
 *      The peer is probed lazily: no unreachable provider means no peer route
 *      is needed, so we never spend the request (or log its failures).
 *   2. Local GGUF: probe PEER_BASE_URL, the co-located LAN :8080, then the
 *      tailscale router; emit an openai-compatible provider for GGUF models.
 *      (The legacy :18080 local-inference port is deprecated — the single
 *      multipurpose instance lives on the LAN port :8080.)
 *
 * "Reachable" is about the NETWORK PATH, not about credentials. A 401/403 from
 * e.g. https://api.openai.com/v1/models is what an OpenAI-compatible endpoint
 * returns to any unauthenticated request — this generator runs without
 * provider keys by design (opencode holds its own OAuth login / key at
 * runtime, and we will never have an OPENAI_API_KEY here), so such a response
 * proves the endpoint is reachable and says nothing about whether opencode's
 * built-in provider works. Treating it as "unreachable" used to rewrite
 * perfectly reachable providers onto the peer for no reason. Only the absence
 * of ANY http response (DNS failure, connection refused, TLS failure,
 * timeout) is evidence that this host cannot reach the endpoint.
 *
 * opencode-go IS included: the opencode models.dev catalog ships a built-in
 * `opencode-go` provider (env OPENCODE_API_KEY, api
 * https://opencode.ai/zen/go/v1).
 *
 * Usage: node generate-opencode.jsonc.mjs [out]
 *   out defaults to ./opencode.jsonc.
 */

import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Structured logging (JSON lines on stderr; see lib/log.mjs).  The env
// override lets generate.sh point this at its scratch-dir copy.
// String() and not a bare URL: `import()` wants a string specifier, and a
// file: URL stringifies back to itself, so the default keeps working.
const { logInfo, logWarn, setLogTool } = await import(
	String(process.env.LOG_LIB ?? new URL("../lib/log.mjs", import.meta.url))
);
setLogTool("coding-agent/generate-opencode");

const scriptDir = dirname(fileURLToPath(import.meta.url));

const REQUEST_TIMEOUT_MS = 8000;

/**
 * An error that carries the http status when the failure came from a response
 * (vs. a transport-level failure, which has no status at all).
 * @typedef {Error & { status?: number }} HttpError
 */

/**
 * An unvalidated `/models` entry — only `id` matters here, and it may be
 * missing from a malformed listing.
 * @typedef {object} RawModelEntry
 * @property {string} [id]
 */

/**
 * A validated `/models` entry.
 * @typedef {object} ModelEntry
 * @property {string} id
 */

/**
 * A peer/source candidate that answered with a usable `/models` listing.
 * @typedef {object} PeerSource
 * @property {string} baseUrl
 * @property {ModelEntry[]} entries
 */

/**
 * Outcome of probing a provider's REAL endpoint:
 * - `ok` — 2xx with a parseable model list: built-in routing works.
 * - `auth` — 401/403: reachable, we merely have no usable credentials here.
 * - `reachable` — some other http response: the host answered, so the path is
 *   fine even though the answer was not a model list.
 * - `unreachable` — no http response at all (dns/conn-refused/tls/timeout).
 * Only `unreachable` justifies rerouting the provider through the peer.
 * @typedef {"ok"|"auth"|"reachable"|"unreachable"} ProbeOutcome
 */

/**
 * @typedef {object} ProbeResult
 * @property {ProbeOutcome} result
 * @property {string} [error] cause, present unless `result` is `ok`
 */

/**
 * A cloud provider opencode can reach natively; overridden only when its real
 * endpoint is unreachable. `keyEnv` names the env var holding the real
 * provider key, used only for the direct-reachability probe — in peer mode the
 * provider's base URL is the peer itself.
 * @typedef {object} CloudProvider
 * @property {string} label
 * @property {string} realBase
 * @property {string} keyEnv
 */

/**
 * The provider id a model belongs to once routed through the peer (`local`
 * being the GGUF catalog, which has no built-in opencode provider).
 * @typedef {"opencode"|"opencode-go"|"openrouter"|"openai"|"local"} ProviderKind
 */

/**
 * An opencode V1 provider entry (the values under the top-level `provider`
 * key).
 * @typedef {object} OpenCodeProvider
 * @property {string} name
 * @property {string[]} env
 * @property {string} npm
 * @property {{ baseURL: string }} options
 * @property {Record<string, { name: string }>} models
 */

// The bazzite tailscale URL reverse-proxies the LAN llama-swap instance
// (:8080), which serves BOTH concerns, so it is a valid candidate for either.
const BAZZITE_ROUTER_TAILSCALE_URL =
	"https://bazzite.coelacanth-barb.ts.net/8654b72a-de9b-402b-abe6-7201dcb38438";

// Peer base URL; must be set via env (no localhost:8080 fallback — the peer
// router is never addressed directly without an explicit PEER_BASE_URL).
const PEER_BASE_URL = (process.env.PEER_BASE_URL ?? "").replace(/\/+$/, "");

// Peer candidates: explicit override, the co-located multipurpose instance
// (LAN :8080 — serves local GGUF + cloud peers on one port), then the remote
// tailscale proxy.
const CLOUD_PEER_CANDIDATES = [
	PEER_BASE_URL,
	"http://localhost:8080",
	BAZZITE_ROUTER_TAILSCALE_URL,
].filter(Boolean);

// Local GGUF is served by the same multipurpose llama-swap instance (:8080
// LAN); fall back to PEER_BASE_URL / the tailscale router (which exposes the
// gfx1030 catalog as FQN ids) and the tailscale router.
const LOCAL_SOURCE_CANDIDATES = [
	PEER_BASE_URL,
	"http://localhost:8080",
	BAZZITE_ROUTER_TAILSCALE_URL,
].filter(Boolean);

/** @type {Record<string, CloudProvider>} */
const CLOUD_PROVIDERS = {
	opencode: {
		label: "OpenCode Zen",
		realBase: "https://opencode.ai/zen/v1",
		keyEnv: "OPENCODE_API_KEY",
	},
	"opencode-go": {
		label: "OpenCode Go",
		realBase: "https://opencode.ai/zen/go/v1",
		keyEnv: "OPENCODE_API_KEY",
	},
	openrouter: {
		label: "OpenRouter",
		realBase: "https://openrouter.ai/api/v1",
		keyEnv: "OPENROUTER_API_KEY",
	},
	openai: {
		label: "OpenAI",
		realBase: "https://api.openai.com/v1",
		keyEnv: "OPENAI_API_KEY",
	},
};

// Statuses that mean "we reached the endpoint, we merely lack usable
// credentials for it" — see the "Reachable" note in the header comment.
const AUTH_REJECTED_STATUSES = new Set([401, 403]);

/**
 * Bearer auth headers for a peer/provider key, or undefined to probe
 * unauthenticated.
 * @param {string} [key]
 * @returns {Record<string, string>|undefined}
 */
function bearerOrBasic(key) {
	return key ? { Authorization: `Bearer ${key}` } : undefined;
}

/**
 * Fetch an OpenAI-compatible `/models` listing, tolerating peers that serve it
 * under `/v1/models` instead of `/models`.
 * @param {string} serverUrl base URL, with or without the `/v1` suffix
 * @param {Record<string, string>} [headers]
 * @returns {Promise<ModelEntry[]>}
 * @throws {HttpError} `status` is set when the endpoint answered non-2xx
 */
async function fetchModelEntries(serverUrl, headers) {
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
		throw Object.assign(
			new Error(`GET ${url} -> ${res.status} ${res.statusText}`),
			{
				status: res.status,
			},
		);
	}
	/** @type {unknown} */
	const body = await res.json();
	const container = /** @type {{ data?: unknown, models?: unknown }} */ (body);
	const data = container.data ?? container.models ?? body;
	if (!Array.isArray(data))
		throw new Error(`GET ${url} returned no models array`);
	const entries = /** @type {RawModelEntry[]} */ (data);
	return entries
		.filter((entry) => Boolean(entry?.id))
		.map(
			(entry) =>
				/** @type {ModelEntry} */ ({ id: /** @type {string} */ (entry.id) }),
		);
}

/**
 * Probe a provider's REAL endpoint and classify the outcome.
 * @param {string} baseUrl
 * @param {Record<string, string>} [headers]
 * @returns {Promise<ProbeResult>}
 */
async function probeDirect(baseUrl, headers) {
	try {
		await fetchModelEntries(baseUrl, headers);
		return { result: "ok" };
	} catch (err) {
		const { message, status } = /** @type {HttpError} */ (err);
		if (status !== undefined && AUTH_REJECTED_STATUSES.has(status))
			return { result: "auth", error: message };
		return {
			result: status === undefined ? "unreachable" : "reachable",
			error: message,
		};
	}
}

/**
 * Probe candidate base URLs in order; the first one whose catalog passes
 * `accept` wins.
 * @param {string[]} candidates
 * @param {(ids: string[]) => boolean} accept does this catalog serve our concern?
 * @returns {Promise<PeerSource|null>} null when no candidate is usable
 */
async function probeCandidates(candidates, accept) {
	const failures = [];
	for (const baseUrl of candidates) {
		try {
			const entries = await fetchModelEntries(
				baseUrl,
				bearerOrBasic(process.env.PEER_API_KEY?.trim()),
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

/**
 * Map a (possibly composite) model id to the provider that owns it, or null to
 * skip the model. Peer catalogs serve cloud models fully qualified
 * (`openrouter/<id>`); bare ids fall back to the suffix conventions.
 * @param {string} id
 * @returns {ProviderKind|null}
 */
function classify(id) {
	const slash = id.indexOf("/");
	const head = slash === -1 ? undefined : id.slice(0, slash);
	const bare = slash === -1 ? id : id.slice(slash + 1);
	switch (head) {
		case "opencode":
			return "opencode";
		case "opencode-go":
			return "opencode-go";
		case "openrouter":
			return "openrouter";
		case "openai":
			return "openai";
		case "gfx1030":
			return "local";
		default:
			break;
	}
	if (id.includes("-GGUF")) return "local";
	if (bare.endsWith(":free")) return "openrouter";
	if (bare.endsWith("-free")) return "opencode";
	return null;
}

/**
 * Build an opencode provider entry routing `label`'s models through the peer
 * that was actually detected (NOT the literal PEER_BASE_URL — the winning
 * candidate may be localhost:8080 or the tailscale router), under the /v1
 * suffix the peer's OpenAI-compatible endpoints live under.
 * @param {string} label
 * @param {PeerSource} peer
 * @param {ModelEntry[]} models
 * @returns {OpenCodeProvider}
 */
function peerProvider(label, peer, models) {
	return {
		name: `Peer: ${label}`,
		env: ["PEER_API_KEY"],
		npm: "@ai-sdk/openai-compatible",
		options: { baseURL: `${peer.baseUrl}/v1` },
		models: Object.fromEntries(models.map((e) => [e.id, { name: e.id }])),
	};
}

/** @returns {Promise<void>} */
async function main() {
	const out = process.argv[2] ?? join(scriptDir, "opencode.jsonc");

	const local = await probeCandidates(LOCAL_SOURCE_CANDIDATES, (ids) =>
		ids.some((id) => classify(id) === "local"),
	);

	/** @type {Record<string, OpenCodeProvider>} */
	const providers = {};

	// --- 1. cloud providers: direct first -------------------------------
	// Only providers whose real endpoint is genuinely UNREACHABLE are peer
	// candidates; a 401/403 (or any other http answer) keeps the built-in
	// routing opencode already has.
	const needsPeer = [];
	for (const [id, cfg] of Object.entries(CLOUD_PROVIDERS)) {
		const { result, error } = await probeDirect(
			cfg.realBase,
			bearerOrBasic(process.env[cfg.keyEnv]?.trim()),
		);
		if (result !== "unreachable") {
			if (result === "ok") {
				logInfo("reachable directly — keeping built-in routing", {
					provider: id,
				});
			} else if (result === "auth") {
				// Not a routing problem: the endpoint answered and refused our
				// (absent) credentials. opencode authenticates itself at runtime.
				logInfo("reachable but credential-gated — keeping built-in routing", {
					provider: id,
					error,
				});
			} else {
				logWarn("reachable but unexpected answer — keeping built-in routing", {
					provider: id,
					error,
				});
			}
			continue;
		}
		logInfo("default endpoint unreachable — will check peer routing", {
			provider: id,
			error,
		});
		needsPeer.push(id);
	}

	const peer =
		needsPeer.length > 0
			? await probeCandidates(CLOUD_PEER_CANDIDATES, (ids) =>
					ids.some((id) => classify(id) !== null),
				)
			: null;

	for (const id of needsPeer) {
		const cfg = CLOUD_PROVIDERS[id];
		if (!peer) {
			logWarn("no peer route visible — skipping", { provider: id });
			continue;
		}
		const models = peer.entries.filter((e) => classify(e.id) === id);
		if (models.length === 0) {
			logWarn("no models visible via peer — skipping", { provider: id });
			continue;
		}
		providers[id] = peerProvider(cfg.label, peer, models);
	}

	// --- 2. local GGUF ---------------------------------------------------
	if (local) {
		const models = local.entries.filter((e) => classify(e.id) === "local");
		if (models.length > 0) {
			providers["local"] = peerProvider("Local LLM", local, models);
		} else {
			logInfo("no local GGUF models visible — omitting local provider");
		}
	} else {
		logInfo("no local GGUF source reachable — omitting local provider");
	}

	if (Object.keys(providers).length === 0) {
		logWarn("nothing usable detected — output left untouched", { out });
		return;
	}

	// opencode V1 config: the provider map key is `provider` (singular).
	const tmp = `${out}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ provider: providers }, null, 2)}\n`);
	renameSync(tmp, out); // atomic on the same filesystem
	const summary = Object.entries(providers)
		.map(
			([id, p]) =>
				`${id}=${p.options.baseURL}(${Object.keys(p.models).length})`,
		)
		.join(", ");
	logInfo("wrote opencode config", { path: out, providers: summary });
}

await main();
