/**
 * @fileoverview cloud-providers.mjs — the ONE fact table for the providers
 * every generator family touches (docs/d023 c3/c4 follow-up,
 * docs/d024): provider id, display label, the env var holding the provider's real
 * key, and the provider's real (default) base URL. Previously these facts
 * were re-declared per family with drifting field names
 * (`generate-models.json.mjs` `baseUrl`, `generate-opencode.mjs`
 * `realBase`, `llm-local-inference/gen-lib.mjs` `defaultBaseUrl`) — a
 * base-url or key-env change needed two/three edits in files with different
 * output renderers. Now every consumer derives from this table and only the
 * per-family *rendering* stays local (pi-shaped layer vs opencode V1 config
 * vs llama-swap entry).
 *
 * The table is also d070's canonical-URL source: committed artifacts carry
 * these `baseUrl`s verbatim, the client route is derived from them
 * (route-probe.mjs), the proxy allowlist is generated from them, and the
 * install-time verifier's host set is built from them — one source for
 * "which upstream does this provider sit on" everywhere (docs/d047, d070).
 *
 * This table is FACTS only — which subset a family consumes, and how, is the
 * consumer's decision:
 *   - `coding-agent/generate-pi-coding-agent.mjs` consumes the
 *     pi-native set (openrouter / opencode / opencode-go / mistral / google):
 *     pi ships these natively, so it only ever emits an override layer.
 *   - `coding-agent/generate-opencode.mjs` consumes
 *     opencode / opencode-go / openrouter (opencode has no built-in
 *     cline-pass or hyper; both are owned exclusively by
 *     generate-pi-coding-agent.mjs's full rows).
 *   - the deployed `llm-reverse-proxy.json` maps every provider id in this
 *     table to its FULL real baseUrl (see llm-reverse-proxy/generate.mjs,
 *     docs/d027) — that path-prefix map IS the simplified cloud router.
 *
 * Import via the LIB_DIR convention (docs/d023): the generators resolve this
 * file through `process.env.LIB_DIR ?? "../lib"`.
 */

/**
 * The stable facts of a provider — the part every family agrees on.
 * `baseUrl` is the provider's REAL endpoint: the upstream the deployed
 * llm-reverse-proxy allowlist keys on (its HOST, and the base path the
 * client route carries client-side — docs/d047), the URL committed
 * artifacts embed verbatim (docs/d070), and the source for the
 * fact-table facts endpoint. Generators never REQUEST it directly — probes
 * walk client routes (docs/d063) and generate substitutes the route at
 * install (d070 §3); llm-reverse-proxy fetches it as the allowlist
 * upstream.
 * @typedef {object} CloudProviderFacts
 * @property {string} id provider id (matches pi's and opencode's
 *   built-in provider names and the llama-swap farm id)
 * @property {string} label human-readable name (opencode config renderer)
 * @property {string} apiKeyEnv env var holding the provider's real key, used
 *   for the facts-refresh bearer and the `${env.*}` reference emitted
 *   layers carry — never inlined into an emitted artifact
 * @property {string} baseUrl the provider's real default endpoint (upstream
 *   for the proxy allowlist; canonical artifact URL, docs/d070)
 * @property {SupportTier} support docs/d064's promise for this row — how
 *   much line-up/liveness work the generators do for it
 */

/**
 * docs/d064's support tiers — what this repo PROMISES per provider:
 * `first-class` (full lineup cascade, regressions are fix priorities,
 * stale-preserve on outages), `best-effort` (same cascade, fixed when
 * convenient), `superficial` (proxy-level support + metadata presence only,
 * not smoke-tested, metadata may be stale).
 * @typedef {"first-class"|"best-effort"|"superficial"} SupportTier
 */

/** @type {Readonly<Record<string, CloudProviderFacts>>} */
export const CLOUD_PROVIDERS = Object.freeze({
	openrouter: Object.freeze({
		id: "openrouter",
		label: "OpenRouter",
		apiKeyEnv: "OPENROUTER_API_KEY",
		baseUrl: "https://openrouter.ai/api/v1",
		support: /** @type {SupportTier} */ ("best-effort"),
	}),
	opencode: Object.freeze({
		id: "opencode",
		label: "OpenCode Zen",
		apiKeyEnv: "OPENCODE_API_KEY",
		baseUrl: "https://opencode.ai/zen/v1",
		support: /** @type {SupportTier} */ ("superficial"),
	}),
	"opencode-go": Object.freeze({
		id: "opencode-go",
		label: "OpenCode Go",
		apiKeyEnv: "OPENCODE_API_KEY",
		baseUrl: "https://opencode.ai/zen/go/v1",
		support: /** @type {SupportTier} */ ("first-class"),
	}),
	"cline-pass": Object.freeze({
		id: "cline-pass",
		label: "ClinePass",
		apiKeyEnv: "CLINE_API_KEY",
		baseUrl: "https://api.cline.bot/api/v1",
		support: /** @type {SupportTier} */ ("first-class"),
	}),
	hyper: Object.freeze({
		id: "hyper",
		label: "Charm Hyper",
		apiKeyEnv: "HYPER_API_KEY",
		baseUrl: "https://hyper.charm.land/v1",
		support: /** @type {SupportTier} */ ("first-class"),
	}),
	inferx: Object.freeze({
		id: "inferx",
		label: "InferX",
		apiKeyEnv: "INFERX_API_KEY",
		baseUrl: "https://model.inferx.net/endpoints/v1",
		support: /** @type {SupportTier} */ ("best-effort"),
	}),
	verboo: Object.freeze({
		id: "verboo",
		label: "Verboo",
		apiKeyEnv: "VERBOO_API_KEY",
		// The FULL real base, path suffix included (docs/d027): the upstream
		// serves its OpenAI surface under /router/v1, and the client route
		// carries that path client-side (providerRouteUrl, docs/d047) — the
		// allowlist row itself is the host root only.
		//
		// Also the ONE fact-table provider with no models.dev catalog row at
		// all, and catwalk does not carry it either — the vendored catalog is
		// replaced wholesale on every refresh, so a hand-added row would be
		// transient (docs/d032 F1). Its lineup therefore comes from
		// coding-agent/catalog-facts.mjs's cache of the provider's own
		// `<base>/models` listing, which also makes this row the one whose
		// baseUrl — not a catalog `api` — is the facts endpoint
		// (catalogOptional, docs/d057).
		baseUrl: "https://code.verboo.ai/router/v1",
		support: /** @type {SupportTier} */ ("first-class"),
	}),
	synthetic: Object.freeze({
		id: "synthetic",
		label: "Synthetic",
		apiKeyEnv: "SYNTHETIC_API_KEY",
		// The FULL real base, path suffix included (docs/d027): the upstream
		// serves its OpenAI surface under /openai/v1 and both catalogs
		// (models.dev `api`, catwalk `api_endpoint`) agree with it, so no
		// drift whitelist (docs/d032 F3) applies.
		//
		// Unlike verboo, BOTH catalogs carry this provider (models.dev with
		// the full per-model records, catwalk with live prices), so the
		// lineup rides the standard catalog cascade — no catalogOptional
		// facts-cache needed (docs/d057). First-class: its hf:-prefixed
		// lineup is the fleet's main non-subscription reasoning source.
		baseUrl: "https://api.synthetic.new/openai/v1",
		support: /** @type {SupportTier} */ ("first-class"),
	}),
	mistral: Object.freeze({
		id: "mistral",
		label: "Mistral",
		apiKeyEnv: "MISTRAL_API_KEY",
		baseUrl: "https://api.mistral.ai/v1",
		support: /** @type {SupportTier} */ ("best-effort"),
	}),
	google: Object.freeze({
		id: "google",
		label: "Google Gemini",
		// The catalog lists GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY /
		// GEMINI_API_KEY; GEMINI_API_KEY is the name coding-agent/run.sh
		// forwards into the container (and what lib/environment.sh exports).
		apiKeyEnv: "GEMINI_API_KEY",
		// pi's native google provider appends `models/<id>:generateContent`
		// and friends directly under /v1beta — this is the FULL base, so the
		// client route `<base>/google` carries the native generative-ai
		// wire format byte-for-byte (impossible through llama-swap's
		// openai-completions-only llama-swap routing — docs/d027). NOTE: /v1beta/models
		// itself authenticates via an api-key parameter, not the bearer the
		// generator's probe sends, so google is a catalogOnly row — the
		// models.dev slice is its lineup source, no probes (docs/d033).
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		support: /** @type {SupportTier} */ ("best-effort"),
	}),
	nvidia: Object.freeze({
		id: "nvidia",
		label: "NVIDIA NIM",
		// build.nvidia.com cloud NIM endpoint — OpenAI-compatible, no local
		// hardware involved (docs/d028). pi ships it natively
		// (packages/ai/src/providers/nvidia.ts: openai-completions,
		// NVIDIA_API_KEY, NVCF-POLL-SECONDS header). Note: NIM's GET /v1/models
		// is a stale bare listing (EOL models included, zero capability flags)
		// — model metadata comes from models.dev + pi's generated compat table,
		// never from the API's listing.
		apiKeyEnv: "NVIDIA_API_KEY",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		support: /** @type {SupportTier} */ ("superficial"),
	}),
	// The LOCAL GGUF farm — first-class (docs/d064), and since d070 a
	// fact-table row LIKE ANY OTHER: its upstream is the llama-swap host's
	// tsnet-only `tailscale serve` hostname, ROOTED at the hostname itself
	// (no path prefix — the serve endpoint maps the host root onto
	// llama-swap's LAN :8101), so the v2 host-form route, the allowlist row
	// and the canonical artifact URL all derive the same way as for cloud
	// providers — no loopback or logical-name exception anywhere (docs/d070
	// §2, precondition: that serve endpoint must exist in the same change
	// that regenerates the local layer; the hostname resolves only for
	// tailnet machines — tsnet-only, same visibility class as the funnel).
	// The client-facing bearer is llama-swap's own REVERSE_PROXY_API_KEY
	// (renamed from PEER_API_KEY, docs/d071 §2) — cloud path-routes never
	// use it.
	"llama-swap": Object.freeze({
		id: "llama-swap",
		label: "Local LLM",
		apiKeyEnv: "REVERSE_PROXY_API_KEY",
		baseUrl: "https://bazzite.coelacanth-barb.ts.net",
		support: /** @type {SupportTier} */ ("first-class"),
	}),
});

/**
 * One row's docs/d064 support tier. The fleet table (incl. the local
 * llama-swap farm) is all that gets a promise; everything outside it is
 * superficial: this repo promises nothing about providers it does not track.
 * @param {string} id fact-table provider id
 * @returns {SupportTier}
 */
export function supportTier(id) {
	return CLOUD_PROVIDERS[id]?.support ?? "superficial";
}

/**
 * The pi-native cloud providers: providers pi-coding-agent ships natively,
 * where a
 * layer is only ever an override ("swap only baseUrl"). cline-pass
 * is deliberately absent (pi does NOT ship it natively — the authoritative
 * full-block layer is owned by generate-pi-coding-agent.mjs's full rows,
 * docs/d022), and so are hyper, inferx and verboo (same reasoning, model-016,
 * model-017 and model-018). `google` IS
 * pi-native (built-in google provider, google-generative-ai wire format) and
 * gains a client route only since the simplified router forwards its
 * native dialect untouched (docs/d027) — previously Google could never be
 * routed and silently relied on direct reachability. `nvidia` IS
 * pi-native too (built-in openai-completions provider against the cloud NIM
 * endpoint, no local hardware — docs/d028).
 * There is no
 * `openai` provider in this table and never was: no
 * route or generator here consumes api.openai.com and no OPENAI_API_KEY
 * exists — "openai" only ever appears as the API *shape* other providers
 * (opencode, opencode-go, cline-pass, ...) speak.
 * @type {readonly string[]}
 */
export const PI_NATIVE_CLOUD_IDS = Object.freeze([
	"openrouter",
	"opencode",
	"opencode-go",
	"mistral",
	"google",
	"nvidia",
]);

/**
 * The table's baseUrl per id — the projection every URL-shape rule needs
 * (route derivation in route-probe.mjs, the d070 verifier, install-time
 * substitution). Kept here rather than re-derived in each consumer so an
 * artifact can never be checked against a stale copy of the table.
 * @type {Readonly<Record<string, string>>}
 */
export const PROVIDER_BASE_URLS = Object.freeze(
	Object.fromEntries(
		Object.entries(CLOUD_PROVIDERS).map(([id, f]) => [id, f.baseUrl]),
	),
);

/**
 * Every row's baseUrl as a list — the CANONICAL upstreams (docs/d070 §1) a
 * committed artifact carries and an installed one must not.
 * @type {readonly string[]}
 */
export const FACT_UPSTREAMS = Object.freeze(
	Object.values(CLOUD_PROVIDERS).map((f) => f.baseUrl),
);

/**
 * The upstreams' hostnames. d070's v2 route form embeds the upstream host as
 * a path segment (`<base>/<host>/…`, docs/d047), so a matching segment is the
 * structural marker that a URL under a colliding base host is routed rather
 * than canonical — the bazzite funnel and the bazzite llama-swap row share a
 * host (docs/d027), and a host-set check on the BASE would flag every
 * install there.
 * @type {ReadonlySet<string>}
 */
export const FACT_HOSTS = new Set(FACT_UPSTREAMS.map((u) => new URL(u).host));
