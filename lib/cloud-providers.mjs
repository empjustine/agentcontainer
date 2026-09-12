/**
 * @fileoverview cloud-providers.mjs — the ONE fact table for the cloud
 * providers every generator family touches (docs/d023 c3/c4 follow-up,
 * docs/d024): peer id, display label, the env var holding the provider's real
 * key, and the provider's real (default) base URL. Previously these facts
 * were re-declared per family with drifting field names
 * (`generate-models.json.mjs` `baseUrl`, `generate-opencode.jsonc.mjs`
 * `realBase`, `llm-local-inference/gen-lib.mjs` `defaultBaseUrl`) — a
 * base-url or key-env change needed two/three edits in files with different
 * output renderers. Now every consumer derives from this table and only the
 * per-family *rendering* stays local (pi-shaped layer vs opencode V1 config
 * vs llama-swap peer entry).
 *
 * This table is FACTS only — which subset a family consumes, and how, is the
 * consumer's decision:
 *   - `coding-agent/generate-cloud-pi-native-providers.mjs` consumes the
 *     pi-native set (openrouter / opencode / opencode-go / mistral / google):
 *     pi ships these natively, so it only ever emits an override layer.
 *   - `coding-agent/generate-opencode.jsonc.mjs` consumes
 *     opencode / opencode-go / openrouter (opencode has no built-in
 *     cline-pass or hyper; both are owned exclusively by
 *     `generate-cloud-alternative-providers.mjs`).
 *   - the deployed `llm-reverse-proxy.json` maps every provider id in this
 *     table to its FULL real baseUrl (see llm-reverse-proxy/generate-config.mjs,
 *     docs/d027) — that path-prefix map IS the simplified cloud router.
 *
 * Import via the LIB_DIR convention (docs/d023): the generators resolve this
 * file through `process.env.LIB_DIR ?? "../lib"`.
 */

/**
 * The stable facts of a cloud provider — the part every family agrees on.
 * `baseUrl` is the provider's REAL endpoint (used for the direct-first
 * reachability probe, as the FULL upstream base in the deployed
 * llm-reverse-proxy.json — docs/d027 — and, in gen-lib's case, as the
 * llama-swap peer proxy target); never a peer route — peer routes are
 * resolved at generation time by the probe cascade as
 * `<peerBase>/<id>` (docs/d027).
 * @typedef {object} CloudProviderFacts
 * @property {string} id provider/peer id (matches pi's and opencode's
 *   built-in provider names and the llama-swap peer id)
 * @property {string} label human-readable name (opencode config renderer)
 * @property {string} apiKeyEnv env var holding the provider's real key, used
 *   only for the direct-reachability probe and llama-swap's `${env.*}`
 *   reference — never inlined into an emitted artifact
 * @property {string} baseUrl the provider's real default endpoint
 */

/** @type {Readonly<Record<string, CloudProviderFacts>>} */
export const CLOUD_PROVIDERS = Object.freeze({
	openrouter: Object.freeze({
		id: "openrouter",
		label: "OpenRouter",
		apiKeyEnv: "OPENROUTER_API_KEY",
		baseUrl: "https://openrouter.ai/api/v1",
	}),
	opencode: Object.freeze({
		id: "opencode",
		label: "OpenCode Zen",
		apiKeyEnv: "OPENCODE_API_KEY",
		baseUrl: "https://opencode.ai/zen/v1",
	}),
	"opencode-go": Object.freeze({
		id: "opencode-go",
		label: "OpenCode Go",
		apiKeyEnv: "OPENCODE_API_KEY",
		baseUrl: "https://opencode.ai/zen/go/v1",
	}),
	"cline-pass": Object.freeze({
		id: "cline-pass",
		label: "ClinePass",
		apiKeyEnv: "CLINE_API_KEY",
		baseUrl: "https://api.cline.bot/api/v1",
	}),
	hyper: Object.freeze({
		id: "hyper",
		label: "Charm Hyper",
		apiKeyEnv: "HYPER_API_KEY",
		baseUrl: "https://hyper.charm.land/v1",
	}),
	mistral: Object.freeze({
		id: "mistral",
		label: "Mistral",
		apiKeyEnv: "MISTRAL_API_KEY",
		baseUrl: "https://api.mistral.ai/v1",
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
		// peer path-route `<peerBase>/google` carries the native generative-ai
		// wire format byte-for-byte (impossible through llama-swap's
		// openai-completions-only peer routing — docs/d027).
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
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
	}),
});

/**
 * The pi-native cloud providers: providers pi-coding-agent ships natively,
 * where a
 * layer is only ever an override ("swap only baseUrl"). cline-pass
 * is deliberately absent (pi does NOT ship it natively — the authoritative
 * full-block layer is owned by `generate-cloud-alternative-providers.mjs`,
 * docs/d022), and so is hyper (same reasoning, model-016). `google` IS
 * pi-native (built-in google provider, google-generative-ai wire format) and
 * gains a peer path-route only since the simplified router forwards its
 * native dialect untouched (docs/d027) — previously Google could never be
 * peer-routed and silently relied on direct reachability. `nvidia` IS
 * pi-native too (built-in openai-completions provider against the cloud NIM
 * endpoint, no local hardware — docs/d028).
 * There is no
 * `openai` provider in this table and never was: no
 * peer or generator here consumes api.openai.com and no OPENAI_API_KEY
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
