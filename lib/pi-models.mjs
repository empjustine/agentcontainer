/**
 * @fileoverview pi-models.mjs — shape probe results into pi `models.json`
 * entries. The two coding-agent generators that emit pi layers off a peer
 * catalog (`generate-local-llama-swap.mjs` and
 * `generate-cloud-pi-native-providers.mjs`) share this shaping: llama-swap
 * serves the SAME metadata shape for local GGUF and for cloud peers routed
 * through it (`meta.llamaswap` on `/v1/models`), so the RawModelEntry →
 * PiModel mapping and the provider wrapper (compat block, `/v1`
 * normalization, the `$PEER_API_KEY` reference) are one implementation
 * (docs/d024). Previously they lived inside the catch-all
 * `generate-models.json.mjs` that the split replaced.
 *
 * Import via the LIB_DIR convention (docs/d023); the probe types this module
 * consumes live in the sibling `./peer-probe.mjs`.
 */

// Shared /models shapes — the types live next to the probe toolkit.
/** @typedef {import("./peer-probe.mjs").RawModelEntry} RawModelEntry */
/** @typedef {import("./peer-probe.mjs").Cost} Cost */

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
 * A pi `models.json` provider entry. `api` and `compat` are optional: full
 * entries (providerEntry) always set them; reroute-only overrides for
 * pi-native providers (providerReroute) deliberately omit both so pi's
 * built-in provider definition supplies the dialect.
 * @typedef {object} PiProvider
 * @property {string} baseUrl
 * @property {string} [api]
 * @property {LlmCompat} [compat]
 * @property {string} [apiKey]
 * @property {PiModel[]} models
 */

/** @type {Readonly<LlmCompat>} */
export const LLAMA_SWAP_COMPAT = Object.freeze({
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
});

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
export function piModel(entry) {
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
 * A provider routed through `baseUrl` (the local llama-swap instance) under
 * the openai-completions protocol. The compat block is set EXPLICITLY: these
 * providers are hand-defined, so pi's provider-composer must not auto-inherit
 * the built-in `llama.cpp` provider's compat — only `api`/`baseUrl` are
 * inherited from built-in defaults. `apiKey` is the literal "$PEER_API_KEY",
 * llama-swap's own client-facing bearer (the cloud path-routes on the
 * simplified proxy do NOT use it — they forward pi's built-in provider auth,
 * see providerReroute, docs/d027); omitted when the generator's own
 * environment has no PEER_API_KEY at all.
 * @param {string} baseUrl
 * @param {PiModel[]} models
 * @returns {PiProvider}
 */
export function providerEntry(baseUrl, models) {
	return {
		// Literal url — pi does not expand environment references in baseUrl.
		baseUrl: `${baseUrl}/v1`,
		api: "openai-completions",
		compat: LLAMA_SWAP_COMPAT,
		...(process.env.PEER_API_KEY?.trim() ? { apiKey: "$PEER_API_KEY" } : {}),
		models,
	};
}

/**
 * A REROUTE-ONLY override for a provider pi ships NATIVELY (the
 * PI_NATIVE_CLOUD_IDS set): carries just the peer path-route `baseUrl`
 * (`<peerBase>/<providerId>`, docs/d027) and the peer-visible models —
 * deliberately NO `api`, NO `compat`, and NO `apiKey`.
 *
 * Emitting an `api` compatibility key here would blindly pin the dialect for
 * providers whose built-in definition is richer than anything we can infer:
 * opencode registers a per-model api map (anthropic-messages /
 * google-generative-ai / openai-completions / openai-responses), opencode-go
 * a three-way one, mistral speaks its own `mistral-conversations` wire
 * format, google the native `google-generative-ai` one — and the public
 * models.dev API does not expose which model uses which. Omitting the key
 * lets pi's built-in provider definition supply the api implementation and
 * compat, so the override only changes WHERE requests go, never HOW they are
 * encoded. This is exactly what makes mistral's non-completions endpoints
 * and google's native dialect work through the peer (docs/d027): the
 * simplified proxy forwards every path under `<peerBase>/<providerId>`
 * byte-for-byte, whatever wire format pi speaks.
 *
 * `apiKey` is likewise omitted: llm-reverse-proxy does NO credential
 * handling (requests must already carry valid provider keys), so the
 * credentials are pi's own built-in per-provider auth (env key or OAuth,
 * resolved at request time) forwarded untouched. The former
 * `"$PEER_API_KEY"` reference belonged to llama-swap's gateway auth and has
 * no meaning here — PEER_API_KEY now only guards the LOCAL llama-swap /v1
 * route (docs/d027).
 * @param {string} providerUrl the provider's FULL peer path-route
 *   (peerProviderUrl output — used verbatim; the legacy `\`/v1\`` append
 *   was llama-swap's model-id-magic surface and is gone)
 * @param {PiModel[]} models
 * @returns {PiProvider}
 */
export function providerReroute(providerUrl, models) {
	return {
		// Literal url — pi does not expand environment references in baseUrl.
		baseUrl: providerUrl,
		models,
	};
}
