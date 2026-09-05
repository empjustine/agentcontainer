/**
 * @fileoverview generate-models.json.mjs — Emit the pi overlay
 * `model-010-local-default.json`: one layer of the layered models.json (the layer contract
 * — naming, order, merge semantics — lives in merge-models-json.mjs) carrying every
 * provider whose default routing is NOT usable from this host, rewritten to routes that
 * are.
 *
 * Detection cascade:
 *
 *   1. Local inference (provider id `llama-swap`): probe the multipurpose
 *      llama-swap instance — $PEER_BASE_URL, then the co-located LAN port
 *      :8080 (tailscale funnel reverse-proxies this same port, so the
 *      world-visible FQDN serves the identical catalog), then the bazzite
 *      tailscale URL.  First candidate serving GGUF models wins; its model
 *      catalog becomes the `llama-swap` provider (pi-shaped metadata mirrored
 *      from meta.llamaswap).  (The legacy :18080 local-inference port is
 *      DEPRECATED with the serving-dir squash — do not add it back.)
 *
 *   2. Cloud providers (`openrouter`, `opencode`, `opencode-go`, `cline-pass`):
 *      probe each provider's DEFAULT /v1/models endpoint.  Reachable ⇒ pi's
 *      built-in provider handles it natively, nothing is emitted.  Unreachable
 *      ⇒ look for the models behind a llama-swap peer router ($PEER_BASE_URL,
 *      the co-located multipurpose openai-completions instance, then the
 *      bazzite tailscale URL); if found, emit a provider override so pi routes
 *      that provider through the peer instead.  The peer is probed lazily: no
 *      unreachable provider means no peer route is needed, so we never spend
 *      the request (or log its failures).
 *
 * "Reachable" is about the NETWORK PATH, not about credentials: a 401/403 is
 * what an OpenAI-compatible endpoint returns to any unauthenticated request,
 * and this generator legitimately runs without provider keys (pi resolves its
 * own key / OAuth login at request time). Such a response proves the endpoint
 * is reachable and says nothing about whether pi's built-in provider works, so
 * it must NOT trigger a peer override. Only the absence of ANY http response
 * (dns failure, connection refused, tls failure, timeout) is evidence that
 * this host cannot reach the endpoint. Same rule as
 * generate-opencode.jsonc.mjs.
 *
 * Emitted layer, per provider:
 *
 * - `baseUrl` is a LITERAL url resolved at generation time (pi does not expand
 *   ${vars} in baseUrl) and is normalized to `/v1`; `api` is
 *   `openai-completions`. `apiKey` is the literal "$PEER_API_KEY", which pi
 *   resolves from the environment at request time.
 * - `compat` is the exact block the built-in llama.cpp provider attaches per
 *   model (pi docs/models.md), placed at the provider level so every model
 *   shares it. It is set EXPLICITLY: this provider is hand-defined here, so
 *   pi's provider-composer does not auto-inherit that compat from the
 *   `llama.cpp` provider id — only `api`/`baseUrl` are inherited from built-in
 *   defaults.
 * - `models` are full pi-shaped entries, deduplicated by id, order preserved,
 *   and ALL are listed — both `loaded` and `unloaded` — because llama-swap
 *   swaps models in/out on demand (unlike pi's built-in llama.cpp provider,
 *   which lists only `status: loaded`).
 * - Per-model metadata mirrors what llama-swap publishes upstream: it serves
 *   each config.d/ entry's `metadata` block on `/v1/models` under
 *   `meta.llamaswap`, which is already pi-shaped, so it is copied field by
 *   field (`reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`). Older
 *   builds without that block fall back to the OpenAI-ish top-level fields
 *   (`context_length`, `architecture.input_modalities`,
 *   `capabilities.vision`). `name` is derived from the model id
 *   (`<repo-basename> <quant>`) purely for display.
 * - Cloud-model attribution: through the peers-only router ids arrive fully
 *   qualified as `<peerId>/<modelId>` (`openrouter/org/model:free`); that peer
 *   prefix is authoritative when present, and bare ids fall back to the suffix
 *   heuristics in classifyCloud().
 * - If nothing usable is detected, nothing is written and any existing layer is
 *   left untouched.
 *
 * Usage: node generate-models.json.mjs [out]
 *   out defaults to $PI_MODELS_JSON else ./model-010-local-default.json.
 *   Env: PEER_BASE_URL (first probe candidate), PEER_API_KEY (peer bearer).
 *   Typical run, then merge — see merge-models-json.mjs:
 *     node generate-models.json.mjs   # -> model-010-local-default.json
 *     node merge-models-json.mjs       # -> models.json
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
setLogTool("coding-agent/generate-models.json");

const scriptDir = dirname(fileURLToPath(import.meta.url));

const REQUEST_TIMEOUT_MS = 8000;

const OPENAI_COMPLETIONS_API = "openai-completions";

/**
 * An error that carries the http status when the failure came from a response
 * (vs. a transport-level failure, which has no status at all).
 * @typedef {Error & { status?: number }} HttpError
 */

/**
 * Per-model metadata llama-swap mirrors from its own model config.
 * @typedef {object} LlamaSwapMeta
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {boolean} [reasoning]
 * @property {string[]} [input]
 * @property {Cost} [cost]
 */

/**
 * @typedef {object} Cost
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 */

/**
 * An unvalidated `/models` entry: `id` is the only required field, everything
 * else is best-effort (llama.cpp, llama-swap and cloud providers each spell the
 * same concepts differently).
 * @typedef {object} RawModelEntry
 * @property {string} id
 * @property {number} [context_length]
 * @property {{ input_modalities?: string[] }} [architecture]
 * @property {{ vision?: boolean }} [capabilities]
 * @property {{ llamaswap?: LlamaSwapMeta, n_ctx?: number }} [meta]
 */

/**
 * A pi-shaped model entry: what pi needs to route and price a model.
 * @typedef {object} PiModel
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} reasoning
 * @property {string[]} input
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {Cost} cost
 */

/**
 * Provider-level compat shared by every llama-swap-routed model — same block
 * the built-in llama.cpp extension attaches per-model (see pi docs/models.md).
 * @typedef {object} LlmCompat
 * @property {boolean} supportsStore
 * @property {boolean} supportsDeveloperRole
 * @property {boolean} supportsReasoningEffort
 * @property {boolean} supportsUsageInStreaming
 * @property {boolean} supportsStrictMode
 * @property {string} maxTokensField
 */

/**
 * A pi `models.json` provider entry.
 * @typedef {object} PiProvider
 * @property {string} baseUrl
 * @property {string} api
 * @property {LlmCompat} compat
 * @property {string} [apiKey]
 * @property {PiModel[]} models
 */

/**
 * A peer/source candidate that answered with a usable `/models` listing.
 * @typedef {object} PeerSource
 * @property {string} baseUrl
 * @property {RawModelEntry[]} entries
 */

/**
 * Outcome of probing a provider's DEFAULT endpoint:
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
 * A cloud provider pi can reach natively; overridden only when its default
 * endpoint is unreachable. `matches` attributes a peer-catalog model id to
 * this provider.
 * @typedef {object} CloudProvider
 * @property {string} baseUrl
 * @property {string} apiKeyEnv
 * @property {(id: string) => boolean} matches
 */

/**
 * @typedef {"openrouter"|"opencode"|"opencode-go"|"cline-pass"} CloudProviderId
 */

/** @type {Readonly<LlmCompat>} */
const LLAMA_SWAP_COMPAT = Object.freeze({
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
});

// The bazzite tailscale URL reverse-proxies the LAN llama-swap instance
// (:8080), which serves BOTH concerns — local GGUF (FQN "gfx1030/<id>" when
// reached remotely) and cloud peers — so it is a valid candidate for either.
const BAZZITE_ROUTER_TAILSCALE_URL =
	"https://bazzite.coelacanth-barb.ts.net/8654b72a-de9b-402b-abe6-7201dcb38438";

// Ordered best-first: explicit override, co-located LAN port, remote proxy.
const LOCAL_SOURCE_CANDIDATES = /** @type {string[]} */ (
	[
		process.env.PEER_BASE_URL?.replace(/\/+$/, ""),
		"http://localhost:8080",
		BAZZITE_ROUTER_TAILSCALE_URL,
	].filter(Boolean)
);

// Cloud peers are served by the same multipurpose llama-swap instance as
// local GGUF — one instance per host since the openai-completions squash, on
// the LAN port :8080 (also what the tailscale funnel reverse-proxies).
const CLOUD_PEER_CANDIDATES = /** @type {string[]} */ (
	[
		process.env.PEER_BASE_URL?.replace(/\/+$/, ""),
		"http://localhost:8080",
		BAZZITE_ROUTER_TAILSCALE_URL,
	].filter(Boolean)
);

// Cloud providers are attributed by their llama-swap peer id when models are
// seen through the peers-only router (ids arrive fully qualified as
// "<peerId>/<modelId>"); bare ids fall back to the same suffix heuristics the
// peer generators use (":free" -> openrouter, "-free" -> opencode, remainder
// -> opencode-go minus grok).  cline-pass is included because the
// openai-completions peer router (config.d/peer-cloud.yaml) carries a
// `peers.cline-pass` block too — see gen-lib.mjs PROVIDERS / d018.
const CLOUD_PEER_IDS = ["openrouter", "opencode", "opencode-go", "cline-pass"];

/**
 * Attribute a peer-catalog model id to a cloud provider.
 * @param {string} id
 * @returns {CloudProviderId|undefined} undefined when the id belongs to
 *   neither concern (local GGUF, grok, ...)
 */
function classifyCloud(id) {
	const slash = id.indexOf("/");
	const head = slash === -1 ? undefined : id.slice(0, slash);
	const prefixed = CLOUD_PEER_IDS.includes(head ?? "");
	const bare = prefixed ? id.slice(slash + 1) : id;
	const owner = prefixed ? /** @type {CloudProviderId} */ (head) : undefined;
	if (bare.endsWith(":free")) return owner ?? "openrouter";
	if (bare.endsWith("-free")) return owner ?? "opencode";
	if (
		!bare.includes("/") &&
		!id.toLowerCase().includes("grok") &&
		!id.includes("-GGUF")
	) {
		return owner ?? "opencode-go";
	}
	return undefined;
}

// Statuses that mean "we reached the endpoint, we merely lack usable
// credentials for it" — see the "Reachable" note in the header comment.
const AUTH_REJECTED_STATUSES = new Set([401, 403]);

/** @type {Record<string, CloudProvider>} */
const CLOUD_PROVIDERS = {
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		apiKeyEnv: "OPENROUTER_API_KEY",
		matches: (id) => classifyCloud(id) === "openrouter",
	},
	opencode: {
		baseUrl: "https://opencode.ai/zen/v1",
		apiKeyEnv: "OPENCODE_API_KEY",
		matches: (id) => classifyCloud(id) === "opencode",
	},
	"opencode-go": {
		baseUrl: "https://opencode.ai/zen/go/v1",
		apiKeyEnv: "OPENCODE_API_KEY",
		matches: (id) => classifyCloud(id) === "opencode-go",
	},
	"cline-pass": {
		baseUrl: "https://api.cline.bot/api/v1",
		apiKeyEnv: "CLINE_API_KEY",
		matches: (id) => classifyCloud(id) === "cline-pass",
	},
};

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
 * @returns {Promise<RawModelEntry[]>}
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
	if (!Array.isArray(data)) {
		throw new Error(`GET ${url} returned no models array`);
	}
	return /** @type {RawModelEntry[]} */ (data).filter((entry) =>
		Boolean(entry?.id),
	);
}

/**
 * Probe a provider's DEFAULT endpoint and classify the outcome.
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
 * "<slug>-ctx<NNN>-<org>/<repo>[:<quant>]" -> "Qwen3.8-27B UD-Q6_K"
 * @param {string} id
 * @returns {string|undefined} undefined for ids that don't follow the scheme
 *   (pi then falls back to the raw id)
 */
function displayName(id) {
	const m = /^([^-]+)-ctx(\d+)-(.+)$/.exec(id);
	if (!m) return undefined;
	const [, , , repoFull] = m;
	const [repoPath, quant] = repoFull.split(":");
	const base = (repoPath.split("/").pop() ?? "").replace(/-GGUF$/i, "");
	return [base, quant].filter(Boolean).join(" ");
}

/**
 * Mirror a raw `/models` entry into pi's model shape, preferring llama-swap's
 * own metadata over the llama.cpp fields.
 * @param {RawModelEntry} entry
 * @returns {PiModel}
 */
function piModel(entry) {
	const meta = entry.meta?.llamaswap;
	const contextWindow =
		meta?.contextWindow ??
		entry.context_length ??
		entry.meta?.n_ctx ??
		undefined;
	const input =
		meta?.input ??
		entry.architecture?.input_modalities ??
		(entry.capabilities?.vision ? ["text", "image"] : ["text"]);
	return {
		id: entry.id,
		...(displayName(entry.id) ? { name: displayName(entry.id) } : {}),
		reasoning: meta?.reasoning ?? true,
		input,
		contextWindow,
		maxTokens: meta?.maxTokens ?? contextWindow,
		cost: meta?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/**
 * A provider routed through `baseUrl` (peer or local instance) under the
 * openai-completions protocol.
 * @param {string} baseUrl
 * @param {PiModel[]} models
 * @returns {PiProvider}
 */
function providerEntry(baseUrl, models) {
	return {
		// Literal url — pi does not expand environment references in baseUrl.
		baseUrl: `${baseUrl}/v1`,
		api: OPENAI_COMPLETIONS_API,
		compat: LLAMA_SWAP_COMPAT,
		...(process.env.PEER_API_KEY?.trim() ? { apiKey: "$PEER_API_KEY" } : {}),
		models,
	};
}

/** @returns {Promise<void>} */
async function main() {
	const out =
		process.argv[2] ??
		process.env.PI_MODELS_JSON ??
		join(scriptDir, "model-010-local-default.json");

	// --- 1. local inference -------------------------------------------------
	const local = await probeCandidates(LOCAL_SOURCE_CANDIDATES, (ids) =>
		ids.some((id) => id.includes("-GGUF")),
	);
	/** @type {Record<string, PiProvider>} */
	const providers = {};
	if (local) {
		const gguf = local.entries.filter((e) => e.id.includes("-GGUF"));
		providers["llama-swap"] = providerEntry(local.baseUrl, gguf.map(piModel));
	} else {
		logInfo("no local GGUF source reachable — omitting llama-swap provider");
	}

	// --- 2. cloud providers -------------------------------------------------
	// Direct-first: probe each provider's DEFAULT endpoint; only if that fails
	// do we look for a llama-swap peer route (lazy — no peer probe, no 401
	// noise, when every direct endpoint is reachable).
	/** @type {[string, CloudProvider][]} */
	const needsPeer = [];
	for (const [id, p] of Object.entries(CLOUD_PROVIDERS)) {
		const { result, error } = await probeDirect(
			p.baseUrl,
			bearerOrBasic(process.env[p.apiKeyEnv]?.trim()),
		);
		if (result !== "unreachable") {
			if (result === "auth") {
				// Not a routing problem: the endpoint answered and refused our
				// (absent) credentials — pi authenticates itself at request time.
				logInfo(
					"default endpoint reachable but credential-gated — keeping built-in routing",
					{ provider: id, error },
				);
			} else if (result === "reachable") {
				logWarn(
					"default endpoint reachable but answered unexpectedly — keeping built-in routing",
					{ provider: id, error },
				);
			}
			continue; // direct endpoint reachable — pi's built-in provider handles it
		}
		logInfo("default endpoint unreachable — will probe peer route", {
			provider: id,
			error,
		});
		needsPeer.push([id, p]);
	}

	if (needsPeer.length > 0) {
		const peer = await probeCandidates(CLOUD_PEER_CANDIDATES, (ids) =>
			ids.some((id) => classifyCloud(id) !== undefined),
		);
		if (!peer)
			logInfo("no cloud-peer route visible — keeping built-in cloud routing");
		for (const [id, p] of needsPeer) {
			if (!peer) continue;
			const models = peer.entries.filter((e) => p.matches(e.id)).map(piModel);
			if (models.length === 0) {
				logWarn("provider models not visible via peer — skipping", {
					provider: id,
					peerBaseUrl: peer.baseUrl,
				});
				continue;
			}
			providers[id] = providerEntry(peer.baseUrl, models);
		}
	}

	if (Object.keys(providers).length === 0) {
		logWarn("nothing usable detected — output left untouched", { out });
		return;
	}

	const tmp = `${out}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ providers }, null, 2)}\n`);
	renameSync(tmp, out); // atomic on the same filesystem
	const summary = Object.entries(providers)
		.map(([id, p]) => `${id}=${p.baseUrl}(${p.models.length})`)
		.join(", ");
	logInfo("wrote models layer", { path: out, providers: summary });
}

await main();
