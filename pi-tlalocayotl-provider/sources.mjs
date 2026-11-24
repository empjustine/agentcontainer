/**
 * @fileoverview sources.mjs — THE one data source: the provider's own
 * `/v1/models` listing in the shape llama-swap serves it, plus the one-row
 * fact table that says where it lives and which key env it reads.
 *
 * Why one source (the pi-verboo-provider verdict, docs/d096, applied here): models.dev
 * carries no tlalocayotl row — the host is the operator's own llama-swap
 * gateway — so the listing IS the lineup, and it is the only place any of its
 * facts may come from. No second catalog, no fact cache.
 *
 * Contracts:
 *   - `fetchListing` is the ONLY network call. Injectable fetch for tests; no
 *     environment variable redirects it beyond the base-url pair below.
 *   - A failure THROWS. There is no committed fallback: an unreadable source
 *     means this provider cannot say what it serves today (docs/d190).
 *   - The listing is AUTH-GATED (measured 2026-11: `401 unauthorized: invalid
 *     or missing API key` without the bearer), so the bearer rides whenever
 *     the key is set. pi resolves `$TLALOCAYOTL_API_KEY` BEFORE the network
 *     refresh phase, so an unset key fails the refresh instead of probing
 *     keylessly (the same measurement recorded in pi-neuralwatt-provider).
 */

/**
 * The fact-table row this folder exists for (docs/d024): the ONE place the
 * upstream URL and the key env are declared. A one-row literal rather than a
 * shared table, because every consumer is a copy unit of its own (docs/d113)
 * and this folder depends on exactly this row.
 *
 * `baseUrl` carries the `/v1` suffix because that is the surface this folder
 * talks to (listing and chat share one base): llama-swap serves the OpenAI
 * shape under `/v1`, and the tailnet host is the operator's, so the canonical
 * value is only reachable from the tailnet — `TLALOCAYOTL_BASE_URL` retargets
 * it (a loopback port, a LAN address) without editing this file.
 *
 * Upstream reference: https://github.com/mostlygeek/llama-swap — the gateway
 * this row points at, and the source of the listing shape read below
 * (`internal/server/api.go`: `modelRecord`, `renderCapabilities`, `newRecord`).
 * The instance's own configuration is the fleet's
 * `llm-local-inference/config.d/` pair.
 */
const TLALOCAYOTL = Object.freeze({
	/** @type {string} the provider id pi namespaces model ids under. */
	id: "tlalocayotl",
	/** @type {string} human-readable name. */
	label: "Tlalocayotl",
	/** @type {string} env var holding the gateway's key. */
	apiKeyEnv: "TLALOCAYOTL_API_KEY",
	/** @type {string} the gateway's canonical upstream. */
	baseUrl: "https://tlalocayotl.coelacanth-barb.ts.net/v1",
	note: `A llama-swap gateway on the operator's tailnet: it swaps llama-server backends on demand, so a model listed as unloaded is still routable — the first request starts it. /v1/models is llama-swap's own shape (OpenAI data[] plus architecture/capabilities rendered from the model's config, meta.llamaswap as the config's own metadata block passed through, meta.n_ctx, status), key-gated by the apiKeys the instance sets to \${env.TLALOCAYOTL_API_KEY} — the same key this folder sends. Its /api/mcp (an MCP docs/config server) is key-gated by that same key and ships closed in the fleet's mcp.json.`,
});

/**
 * The upstream this unit uses: `<KEY>_BASE_URL` derived from the key env the
 * way Azure OpenAI spells the pair, absolute http(s) only, trailing slashes
 * trimmed. Unset or empty keeps the row's canonical URL. A malformed value
 * throws at load: a loud extension error beats silently using an upstream the
 * operator did not choose.
 * @param {string} apiKeyEnv
 * @param {string|undefined} canonical
 * @param {Record<string, string|undefined>} env
 * @returns {string|undefined}
 */
export function baseUrlFromEnv(apiKeyEnv, canonical, env) {
	const name = apiKeyEnv.endsWith("_API_KEY")
		? `${apiKeyEnv.slice(0, -"_API_KEY".length)}_BASE_URL`
		: null;
	const override = name === null ? undefined : env[name]?.trim();
	if (!override) {
		return canonical;
	}
	let protocol;
	try {
		protocol = new URL(override).protocol;
	} catch {
		protocol = "";
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`${name} is not an absolute http(s) URL: ${override}`);
	}
	return override.replace(/\/+$/u, "");
}

/** @type {string} this unit's effective upstream (the row's canonical by default). */
export const TLALOCAYOTL_BASE_URL = /** @type {string} */ (
	baseUrlFromEnv(TLALOCAYOTL.apiKeyEnv, TLALOCAYOTL.baseUrl, process.env)
);
/** @type {string} the env var holding the gateway's key. */
export const TLALOCAYOTL_API_KEY_ENV = TLALOCAYOTL.apiKeyEnv;
/** @type {string} the provider id pi namespaces model ids under. */
export const TLALOCAYOTL_PROVIDER_ID = TLALOCAYOTL.id;

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The request signal: the CALLER's cancellation composed with this folder's own
 * deadline. Both, never either — `signal ?? AbortSignal.timeout(…)` silently
 * drops the ceiling, because pi always hands a concrete signal (pi-ai's
 * RefreshModelsContext), and a revoked refresh would then wait on an upstream
 * that never answers (docs/d045).
 * @param {AbortSignal} [caller] pi's signal, when the caller has one
 * @returns {AbortSignal}
 */
function requestSignal(caller) {
	return caller
		? AbortSignal.any([caller, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
		: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

const MODEL_STORE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * The listing URL — the effective upstream plus the path llama-swap serves its
 * listing under, derived in ONE place.
 * @returns {string}
 */
export function listingUrl() {
	return `${TLALOCAYOTL_BASE_URL}/models`;
}

/**
 * The `meta.llamaswap` block. It is NOT a llama-swap schema: the gateway copies
 * the model's own `metadata` block from its config verbatim under this key
 * (`newRecord`, upstream `internal/server/api.go`) and adds a few internal
 * members of its own. So `contextWindow`, `maxTokens`, `input` and
 * `reasoning` are the OPERATOR's statement in
 * `llm-local-inference/config.d/` — the fleet writes exactly those keys — and a
 * model without them degrades to the rendered `architecture`/`context_*`
 * fields instead.
 *
 * `id`, `type`, `upstream`, `aliases`, `modelID` and `peerID` are declared for
 * shape honesty and deliberately unread. They tag where a row came from — a
 * local model, an alias of one (`includeAliasesInList`), a peer's proxied
 * model — and every one of them serves the same OpenAI surface, so filtering on
 * any would drop models that route.
 * @typedef {object} ListingGatewayFacts
 * @property {string} [id] the model id, echoed from config metadata
 * @property {number} [contextWindow] the window the operator starts the backend with
 * @property {number} [maxTokens] the output cap the operator publishes
 * @property {string[]} [input] the backend's input modalities
 * @property {boolean} [reasoning] whether the backend template reasons
 * @property {string} [type] "model", "alias" or "peer" — see above, unread
 * @property {string} [upstream] the detected backend kind ("llama-server") — unread
 * @property {string[]} [aliases] the model's configured aliases — unread
 * @property {string} [modelID] an alias row's target model — unread
 * @property {string} [peerID] a peer row's peer — unread
 */

/**
 * One listing row: llama-swap's `modelRecord` as far as this folder reads it.
 * `architecture`, `capabilities`, `supported_parameters`, `context_length` and
 * `context_window` are RENDERED by the gateway from the model's `capabilities`
 * config (`renderCapabilities`), which is why the window appears twice and why
 * an input modality list is the authoritative source of what the backend takes.
 * Everything but `id` is optional — the gateway may stop publishing any of them,
 * and the shaping downstream degrades field by field rather than throwing.
 *
 * `status.value` ("loaded"/"unloaded") is declared and deliberately unread:
 * llama-swap loads on demand, so an unloaded model is a routable model and
 * filtering on the status would leave the selector with whatever happens to be
 * resident.
 * @typedef {object} ListingRow
 * @property {string} id
 * @property {string} [name] the config's `name`, absent when it sets none
 * @property {{input_modalities?: string[], output_modalities?: string[]}} [architecture]
 * @property {{vision?: boolean, function_calling?: boolean, decisions?: boolean}} [capabilities]
 * @property {string[]} [supported_parameters]
 * @property {number} [context_length]
 * @property {number} [context_window]
 * @property {{llamaswap?: ListingGatewayFacts, n_ctx?: number}} [meta]
 * @property {{value?: string}} [status]
 */

/**
 * One listing fetch, returning the RAW rows: interpretation belongs to
 * merge.mjs, so a parse change is a shaping change in one place.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl] injected by tests
 * @param {string} [options.url] injected by tests
 * @returns {Promise<ListingRow[]>}
 * @throws {Error} on a transport failure, a non-2xx answer, or a payload with
 *   no usable rows — the caller has nothing to publish (docs/d190)
 */
export async function fetchListing({
	signal,
	fetchImpl = fetch,
	url = listingUrl(),
} = {}) {
	const key = process.env[TLALOCAYOTL.apiKeyEnv]?.trim();
	const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
	const res = await fetchImpl(url, {
		...(headers ? { headers } : {}),
		signal: requestSignal(signal),
	});
	if (!res.ok) {
		throw new Error(
			`model listing answered ${res.status} — nothing to publish`,
		);
	}
	const payload = /** @type {unknown} */ (await res.json());
	// llama-swap wraps its rows in the OpenAI envelope ({data: [...]}); a bare
	// array is tolerated because compatible gateways serve that too, and
	// accepting it costs nothing.
	const payloadRows = Array.isArray(payload)
		? payload
		: Array.isArray(/** @type {{data?: unknown}} */ (payload)?.data)
			? /** @type {unknown[]} */ (
					/** @type {{data?: unknown}} */ (payload).data
				)
			: [];
	const rows = /** @type {{id?: unknown}[]} */ (payloadRows);
	/** @type {ListingRow[]} */
	const kept = [];
	for (const row of rows) {
		if (typeof row?.id !== "string") {
			continue;
		}
		kept.push(/** @type {ListingRow} */ (row));
	}
	if (kept.length === 0) {
		throw new Error("model listing carried no usable rows");
	}
	return kept;
}

/**
 * Whether a persisted model store is still inside the refresh TTL — the gate
 * that keeps a model-selector open from re-fetching, not a remembered lineup
 * (docs/d190: an unreadable source still throws).
 * @param {number} checkedAt epoch ms of the stored catalog
 * @returns {boolean}
 */
export function storeIsFresh(checkedAt) {
	return Date.now() - checkedAt < MODEL_STORE_TTL_MS;
}
