/**
 * @fileoverview generate.mjs — the llm-reverse-proxy generator (d041 folded
 * the former generate.sh orchestration in): emit `llm-reverse-proxy.json`, the
 * deployed llm-reverse-proxy routing table, as the UNION of THREE provider
 * sources (docs/d038), merged under an explicit priority:
 *
 *   1. pi-ai        — the PI_AI_PROVIDERS table below (pi-coding-agent's
 *                     built-in registry, extracted from the installed pi)
 *   2. models.dev   — the vendored + best-effort refreshed
 *                     lib/models.dev.api.json (ai-sdk/opencode's catalog):
 *                     a record's `api` field IS its base URL; records
 *                     without one fall back to the ai-sdk package map
 *                     (AI_SDK_PACKAGE_ENDPOINTS below)
 *   3. catwalk      — the vendored + refreshable lib/catwalk-facts.json
 *                     (crush's catalog): each provider carries
 *                     `api_endpoint`
 *
 * Merge rules (docs/d038): the route namespace is the provider NAME. The
 * same name from several sources ⇒ the higher-priority source wins (every
 * win is logged with what it replaced). Different names for the same vendor
 * ⇒ each name is served under its own route (pi's "google" and catwalk's
 * "gemini" both exist; pi's "together" and models.dev's "togetherai" both
 * exist). Rows whose endpoint is not a single fixed public URL are skipped
 * with the reason: env-placeholder / account-scoped URLs (`$VAR`,
 * `{PLACEHOLDER}` — e.g. catwalk's $ANTHROPIC_API_ENDPOINT, the cloudflare
 * gateways), per-region bedrock, per-project vertex, and models.dev records
 * whose npm package has no canonical endpoint.
 *
 * The path-prefix contract this table serves is unchanged (docs/d027): every
 * entry maps a route name to the upstream's FULL real base URL — path
 * suffixes included — so a client route is deterministic:
 * `<peerBase>/<providerId>` (the peerProviderUrl contract, docs/d027). The proxy
 * strips the leading `/<providerId>` and single-joins the rest onto the
 * configured base. Keys are deliberately NOT consulted: llm-reverse-proxy
 * performs NO credential handling — requests must already carry valid
 * provider keys, so every routable provider is exposed unconditionally.
 *
 * The deployed config also carries the hand-added entries the catalogs do
 * not know about: `llama-swap`, the LOCAL GGUF peer (env
 * LLAMA_SWAP_BASE_URL, default http://127.0.0.1:8101 — loopback is
 * deliberate: llama-swap's inbound auth is its bearer key and the loopback
 * hop never leaves the host), plus two static metadata passthroughs,
 * `models.dev` and `catwalk` (public, no keys, never drift-checked).
 *
 * Drift checking is unchanged: lib/cloud-providers.mjs (docs/d024) stays the
 * reference for ITS nine ids — a deployed value that differs from the fact
 * table warns. Those nine resolve through the pi-ai/models.dev rows, which
 * must therefore agree with the fact table.
 *
 * Overwrite semantics follow the repo-wide generator standard
 * (lib/artifact.mjs): a rerun REPLACES the deployed config by default;
 * DRY_RUN=1 writes an inspectable .dry-run preview instead.
 *
 * Usage: ./generate.sh (the standard wrapper — node_run interpreter
 * selection, same as the other environments) or node generate-config.mjs
 * [out]
 *   out defaults to ./llm-reverse-proxy.json (the path run.sh serves).
 *   Env: LIB_DIR (default ../lib), DRY_RUN, LLAMA_SWAP_BASE_URL,
 *   MODELS_DEV_JSON, CATWALK_FACTS_JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logError, logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);
const { writeArtifact, isDryRun } =
	/** @type {typeof import("../lib/artifact.mjs")} */ (
		await import(`${LIB_DIR}/artifact.mjs`)
	);
setLogTool("llm-reverse-proxy/generate");

const out = process.argv[2] ?? join(scriptDir, "llm-reverse-proxy.json");
const MODELS_DEV_JSON =
	process.env.MODELS_DEV_JSON ?? join(LIB_DIR, "models.dev.api.json");
const CATWALK_FACTS_JSON =
	process.env.CATWALK_FACTS_JSON ?? join(LIB_DIR, "catwalk-facts.json");

// ---------------------------------------------------------------------------
// Source 1 fact table: pi-ai's BUILT-IN cloud providers (folded in from the
// former lib/pi-ai-providers.mjs — docs/d039; rationale docs/d038). Facts
// were extracted from the installed pi 0.85.1 provider registry and
// cross-checked against pi-mono's packages/ai/src/providers/*.ts. Like every
// vendored catalog here, the copy is a floor, not a feed: a stale row is a
// drifted route, so re-extract when the host's pi version moves.
//
// Only providers with a STABLE, account-independent HTTPS base URL are
// routable through a path-prefix proxy. Everything else lives in
// PI_AI_NON_ROUTABLE with the reason — the proxy forwards
// `<peerBase>/<id>` to one fixed upstream base, so per-region /
// per-project / per-account / OAuth endpoints cannot be expressed.
//
// `api` is the wire dialect pi-ai speaks against that base (informational:
// the proxy forwards byte-for-byte whatever the client sends, docs/d027).
// Multi-dialect providers register several (api, baseUrl) pairs — e.g.
// opencode speaks four dialects against two bases; the row records the
// openai-completions base (the one the fact table and models.dev agree on)
// and lists the rest in `otherApis`, mirroring the single-baseUrl limitation
// pi's own models.json overrides already accepted (docs/d027).
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PiAiProviderFacts
 * @property {string} id pi provider id (the route name)
 * @property {string} label human-readable name
 * @property {string} api the primary wire dialect pi-ai speaks at baseUrl
 * @property {string} baseUrl pi-ai's built-in base URL (FULL; never a peer
 *   route — peer routes are `<peerBase>/<id>` at request time, docs/d027)
 * @property {string} apiKeyEnv env var pi resolves the provider's key from
 *   (informational — the proxy performs no credential handling)
 * @property {Record<string, string>} [otherApis] dialect → base for the
 *   provider's remaining registrations
 */

/**
 * A pi-ai provider that cannot be routed through a path-prefix proxy.
 * @typedef {object} PiAiNonRoutable
 * @property {string} id pi provider id
 * @property {string} reason why no single fixed upstream base exists
 */

/** @type {Readonly<Record<string, PiAiProviderFacts>>} */
const PI_AI_PROVIDERS = Object.freeze({
	anthropic: Object.freeze({
		id: "anthropic",
		label: "Anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		apiKeyEnv: "ANTHROPIC_API_KEY",
	}),
	openai: Object.freeze({
		id: "openai",
		label: "OpenAI",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		apiKeyEnv: "OPENAI_API_KEY",
	}),
	deepseek: Object.freeze({
		id: "deepseek",
		label: "DeepSeek",
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com",
		apiKeyEnv: "DEEPSEEK_API_KEY",
	}),
	google: Object.freeze({
		id: "google",
		label: "Google Gemini",
		api: "google-generative-ai",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		apiKeyEnv: "GEMINI_API_KEY",
	}),
	mistral: Object.freeze({
		id: "mistral",
		label: "Mistral",
		api: "mistral-conversations",
		baseUrl: "https://api.mistral.ai",
		apiKeyEnv: "MISTRAL_API_KEY",
	}),
	groq: Object.freeze({
		id: "groq",
		label: "Groq",
		api: "openai-completions",
		baseUrl: "https://api.groq.com/openai/v1",
		apiKeyEnv: "GROQ_API_KEY",
	}),
	cerebras: Object.freeze({
		id: "cerebras",
		label: "Cerebras",
		api: "openai-completions",
		baseUrl: "https://api.cerebras.ai/v1",
		apiKeyEnv: "CEREBRAS_API_KEY",
	}),
	xai: Object.freeze({
		id: "xai",
		label: "xAI",
		api: "openai-responses",
		baseUrl: "https://api.x.ai/v1",
		apiKeyEnv: "XAI_API_KEY",
	}),
	openrouter: Object.freeze({
		id: "openrouter",
		label: "OpenRouter",
		api: "openai-completions",
		baseUrl: "https://openrouter.ai/api/v1",
		apiKeyEnv: "OPENROUTER_API_KEY",
	}),
	opencode: Object.freeze({
		id: "opencode",
		label: "OpenCode Zen",
		api: "openai-completions",
		// Four dialects against two bases (zen vs zen/v1); the
		// openai-completions base is the one the fact table and models.dev
		// already route — see the header's single-base note.
		baseUrl: "https://opencode.ai/zen/v1",
		apiKeyEnv: "OPENCODE_API_KEY",
		otherApis: Object.freeze({
			"anthropic-messages": "https://opencode.ai/zen",
			"google-generative-ai": "https://opencode.ai/zen/v1",
			"openai-responses": "https://opencode.ai/zen/v1",
		}),
	}),
	"opencode-go": Object.freeze({
		id: "opencode-go",
		label: "OpenCode Go",
		api: "openai-completions",
		baseUrl: "https://opencode.ai/zen/go/v1",
		apiKeyEnv: "OPENCODE_API_KEY",
		otherApis: Object.freeze({
			"anthropic-messages": "https://opencode.ai/zen/go",
			"openai-responses": "https://opencode.ai/zen/go/v1",
		}),
	}),
	together: Object.freeze({
		id: "together",
		label: "Together AI",
		api: "openai-completions",
		baseUrl: "https://api.together.ai/v1",
		apiKeyEnv: "TOGETHER_API_KEY",
	}),
	baseten: Object.freeze({
		id: "baseten",
		label: "Baseten",
		api: "openai-completions",
		baseUrl: "https://inference.baseten.co/v1",
		apiKeyEnv: "BASETEN_API_KEY",
	}),
	fireworks: Object.freeze({
		id: "fireworks",
		label: "Fireworks",
		api: "openai-completions",
		// pi-mono providers/fireworks.ts: base WITHOUT the /v1 the ai-sdk
		// dialect appends — pi's own path composition supplies it.
		baseUrl: "https://api.fireworks.ai/inference",
		apiKeyEnv: "FIREWORKS_API_KEY",
	}),
	huggingface: Object.freeze({
		id: "huggingface",
		label: "Hugging Face",
		api: "openai-completions",
		baseUrl: "https://router.huggingface.co/v1",
		apiKeyEnv: "HF_TOKEN",
	}),
	"kimi-coding": Object.freeze({
		id: "kimi-coding",
		label: "Kimi For Coding",
		api: "anthropic-messages",
		baseUrl: "https://api.kimi.com/coding",
		apiKeyEnv: "KIMI_API_KEY",
	}),
	minimax: Object.freeze({
		id: "minimax",
		label: "MiniMax",
		api: "anthropic-messages",
		baseUrl: "https://api.minimax.io/anthropic",
		apiKeyEnv: "MINIMAX_API_KEY",
	}),
	"minimax-cn": Object.freeze({
		id: "minimax-cn",
		label: "MiniMax (China)",
		api: "anthropic-messages",
		baseUrl: "https://api.minimaxi.com/anthropic",
		apiKeyEnv: "MINIMAX_CN_API_KEY",
	}),
	moonshotai: Object.freeze({
		id: "moonshotai",
		label: "Moonshot",
		api: "openai-completions",
		baseUrl: "https://api.moonshot.ai/v1",
		apiKeyEnv: "MOONSHOT_API_KEY",
	}),
	"moonshotai-cn": Object.freeze({
		id: "moonshotai-cn",
		label: "Moonshot (China)",
		api: "openai-completions",
		baseUrl: "https://api.moonshot.cn/v1",
		apiKeyEnv: "MOONSHOT_API_KEY",
	}),
	zai: Object.freeze({
		id: "zai",
		label: "Z.AI",
		api: "openai-completions",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		apiKeyEnv: "ZAI_API_KEY",
	}),
	"zai-coding-cn": Object.freeze({
		id: "zai-coding-cn",
		label: "ZAI Coding Plan (China)",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		apiKeyEnv: "ZAI_CODING_CN_API_KEY",
	}),
	"ant-ling": Object.freeze({
		id: "ant-ling",
		label: "Ant Ling",
		api: "openai-completions",
		baseUrl: "https://api.ant-ling.com/v1",
		apiKeyEnv: "ANT_LING_API_KEY",
	}),
	"vercel-ai-gateway": Object.freeze({
		id: "vercel-ai-gateway",
		label: "Vercel AI Gateway",
		api: "anthropic-messages",
		// pi-mono providers/vercel-ai-gateway.ts registers WITHOUT /v1; the
		// dialect supplies it. Distinct NAME from models.dev/catwalk's
		// "vercel" row — both names are served (docs/d038).
		baseUrl: "https://ai-gateway.vercel.sh",
		apiKeyEnv: "AI_GATEWAY_API_KEY",
	}),
	"qwen-token-plan": Object.freeze({
		id: "qwen-token-plan",
		label: "Qwen Token Plan",
		api: "openai-completions",
		baseUrl:
			"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		apiKeyEnv: "QWEN_TOKEN_PLAN_API_KEY",
	}),
	"qwen-token-plan-cn": Object.freeze({
		id: "qwen-token-plan-cn",
		label: "Qwen Token Plan (China)",
		api: "openai-completions",
		baseUrl:
			"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		apiKeyEnv: "QWEN_TOKEN_PLAN_CN_API_KEY",
	}),
	"qwen-token-plan-individual": Object.freeze({
		id: "qwen-token-plan-individual",
		label: "Qwen Token Plan (Individual)",
		api: "openai-completions",
		// Same base as qwen-token-plan — a distinct NAME at the same endpoint;
		// served under its own name (docs/d038).
		baseUrl:
			"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		apiKeyEnv: "QWEN_TOKEN_PLAN_API_KEY",
	}),
	xiaomi: Object.freeze({
		id: "xiaomi",
		label: "Xiaomi MiMo",
		api: "openai-completions",
		baseUrl: "https://api.xiaomimimo.com/v1",
		apiKeyEnv: "XIAOMI_API_KEY",
	}),
	"xiaomi-token-plan-cn": Object.freeze({
		id: "xiaomi-token-plan-cn",
		label: "Xiaomi MiMo Token Plan (China)",
		api: "openai-completions",
		baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
		apiKeyEnv: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
	}),
	"xiaomi-token-plan-ams": Object.freeze({
		id: "xiaomi-token-plan-ams",
		label: "Xiaomi MiMo Token Plan (Amsterdam)",
		api: "openai-completions",
		baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
		apiKeyEnv: "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	}),
	"xiaomi-token-plan-sgp": Object.freeze({
		id: "xiaomi-token-plan-sgp",
		label: "Xiaomi MiMo Token Plan (Singapore)",
		api: "openai-completions",
		baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		apiKeyEnv: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	}),
});

/**
 * pi-ai providers with NO single fixed upstream base — documented so the
 * gap is a decision, never an oversight (docs/d038).
 * @type {Readonly<Record<string, PiAiNonRoutable>>}
 */
const PI_AI_NON_ROUTABLE = Object.freeze({
	"amazon-bedrock": Object.freeze({
		id: "amazon-bedrock",
		reason:
			"per-region SigV4 endpoints (bedrock-runtime.<region>.amazonaws.com)",
	}),
	"google-vertex": Object.freeze({
		id: "google-vertex",
		reason:
			"per-project + per-location endpoints ({location}-aiplatform.googleapis.com)",
	}),
	"azure-openai-responses": Object.freeze({
		id: "azure-openai-responses",
		reason: "per-resource endpoints (<resource>.openai.azure.com)",
	}),
	"cloudflare-ai-gateway": Object.freeze({
		id: "cloudflare-ai-gateway",
		reason:
			"per-account gateway URL ({CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID} placeholders)",
	}),
	"cloudflare-workers-ai": Object.freeze({
		id: "cloudflare-workers-ai",
		reason:
			"per-account URL (api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID})",
	}),
	"openai-codex": Object.freeze({
		id: "openai-codex",
		reason:
			"ChatGPT subscription OAuth backend (chatgpt.com/backend-api), not a public provider endpoint",
	}),
	"github-copilot": Object.freeze({
		id: "github-copilot",
		reason:
			"GitHub subscription OAuth with per-user endpoints (api.individual.githubcopilot.com)",
	}),
	radius: Object.freeze({
		id: "radius",
		reason:
			"dynamic gateway — the base URL is per-deployment configuration, not a registry fact",
	}),
	faux: Object.freeze({
		id: "faux",
		reason: "pi's built-in test provider — no network endpoint",
	}),
});

// ---------------------------------------------------------------------------
// Source 2 fallback: map from the ai-sdk npm package each models.dev provider
// record names (`npm` field) to the package's canonical public endpoint
// (folded in from the former lib/ai-sdk-package-endpoints.mjs — docs/d039;
// rationale docs/d038). Used for records that carry no `api` base URL. Only
// packages whose endpoint is CANONICAL AND PUBLIC are mapped — the same
// stable-endpoint rule as the pi-ai table above. Account-scoped or
// per-deployment packages map to null with a reason, so a gap in the routing
// table is always a documented decision, never an oversight. Endpoints were
// verified against the vendors' published API references; a wrong row here
// silently reroutes every model of a provider, so a row must be able to cite
// its source in one line.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AiSdkPackageEndpoint
 * @property {string|null} endpoint the package's canonical public API base,
 *   or null when no single fixed public endpoint exists
 * @property {string} [reason] why endpoint is null (required when null)
 */

/** @type {Readonly<Record<string, AiSdkPackageEndpoint>>} */
const AI_SDK_PACKAGE_ENDPOINTS = Object.freeze({
	// --- canonical, public (routable) -----------------------------------
	"@ai-sdk/anthropic": Object.freeze({
		endpoint: "https://api.anthropic.com/v1",
	}),
	"@ai-sdk/openai": Object.freeze({
		endpoint: "https://api.openai.com/v1",
	}),
	"@ai-sdk/google": Object.freeze({
		endpoint: "https://generativelanguage.googleapis.com/v1beta",
	}),
	"@ai-sdk/groq": Object.freeze({
		endpoint: "https://api.groq.com/openai/v1",
	}),
	"@ai-sdk/xai": Object.freeze({
		endpoint: "https://api.x.ai/v1",
	}),
	"@ai-sdk/mistral": Object.freeze({
		endpoint: "https://api.mistral.ai/v1",
	}),
	"@ai-sdk/cerebras": Object.freeze({
		endpoint: "https://api.cerebras.ai/v1",
	}),
	"@ai-sdk/togetherai": Object.freeze({
		endpoint: "https://api.together.xyz/v1",
	}),
	// Cohere's OpenAI-COMPATIBILITY endpoint (the plain v2 dialect is not
	// OpenAI-shaped; the compat route is what the ai-sdk package speaks).
	"@ai-sdk/cohere": Object.freeze({
		endpoint: "https://api.cohere.com/compatibility/v1",
	}),
	"@ai-sdk/perplexity": Object.freeze({
		endpoint: "https://api.perplexity.ai",
	}),
	"@ai-sdk/deepinfra": Object.freeze({
		endpoint: "https://api.deepinfra.com/v1/openai",
	}),
	// models.dev's "vercel" record (@ai-sdk/gateway): the public gateway edge.
	// Distinct NAME from pi's "vercel-ai-gateway" row — both are served
	// (docs/d038).
	"@ai-sdk/gateway": Object.freeze({
		endpoint: "https://ai-gateway.vercel.sh/v1",
	}),
	"venice-ai-sdk-provider": Object.freeze({
		endpoint: "https://api.venice.ai/api/v1",
	}),
	"@aihubmix/ai-sdk-provider": Object.freeze({
		endpoint: "https://api.aihubmix.com/v1",
	}),
	"@openrouter/ai-sdk-provider": Object.freeze({
		endpoint: "https://openrouter.ai/api/v1",
	}),

	// --- no single fixed public endpoint (skipped, with the reason) ------
	"@ai-sdk/azure": Object.freeze({
		endpoint: null,
		reason: "per-resource endpoints (<resource>.openai.azure.com)",
	}),
	"@ai-sdk/amazon-bedrock": Object.freeze({
		endpoint: null,
		reason: "per-region SigV4 endpoints",
	}),
	"@ai-sdk/google-vertex": Object.freeze({
		endpoint: null,
		reason: "per-project + per-location endpoints",
	}),
	"@ai-sdk/google-vertex/anthropic": Object.freeze({
		endpoint: null,
		reason: "per-project + per-location endpoints",
	}),
	"watsonx-ai-provider": Object.freeze({
		endpoint: null,
		reason: "per-instance watsonx deployments",
	}),
	"@qvac/ai-sdk-provider": Object.freeze({
		endpoint: null,
		reason: "no documented public API endpoint",
	}),
	"@saladtechnologies-oss/ai-sdk-provider": Object.freeze({
		endpoint: null,
		reason: "no canonical public endpoint verified",
	}),
	"ai-gateway-provider": Object.freeze({
		endpoint: null,
		reason: "per-account Cloudflare gateway URL",
	}),
	"merge-gateway-ai-sdk-provider": Object.freeze({
		endpoint: null,
		reason: "per-deployment gateway URL",
	}),
	"@jerome-benoit/sap-ai-provider-v2": Object.freeze({
		endpoint: null,
		reason: "per-subaccount SAP AI Core deployments",
	}),
	"gitlab-ai-provider": Object.freeze({
		endpoint: null,
		reason: "per-instance GitLab Duo deployments",
	}),
});

/**
 * A candidate route before the priority merge.
 * @typedef {object} RouteCandidate
 * @property {string} id route name (the provider's name in ITS source)
 * @property {string} url the FULL real base URL
 * @property {string} source which of the three catalogs supplied it
 */

/**
 * A skipped source row — why it is NOT in the routing table.
 * @typedef {object} SkippedRow
 * @property {string} source
 * @property {string} id
 * @property {string} reason
 */

/** @type {RouteCandidate[]} */
const candidates = [];
/** @type {SkippedRow[]} */
const skipped = [];

/**
 * A single fixed public URL is routable; env-placeholder and account-scoped
 * templates (`$VAR`, `{PLACEHOLDER}`) are not — the proxy forwards to one
 * configured base, so a URL that varies per account cannot be expressed.
 * @param {string} url
 * @returns {boolean}
 */
function routableUrl(url) {
	return Boolean(url) && !url.startsWith("$") && !url.includes("{");
}

// --- source 1: pi-ai (top priority) -----------------------------------------
for (const p of Object.values(PI_AI_PROVIDERS)) {
	candidates.push({ id: p.id, url: p.baseUrl, source: "pi-ai" });
}
// The non-routable pi-ai rows are documentation-as-data (header): consume
// them here so the skip report below carries their reasons, instead of
// leaving the table as unused weight that lint flags (and could drift).
for (const p of Object.values(PI_AI_NON_ROUTABLE)) {
	skipped.push({ source: "pi-ai", id: p.id, reason: p.reason });
}

// --- source 2: models.dev (ai-sdk / opencode's catalog) ---------------------
/** @type {Record<string, { api?: string, npm?: string, name?: string }>} */
let modelsDev = {};
try {
	modelsDev = /** @type {typeof modelsDev} */ (
		JSON.parse(readFileSync(MODELS_DEV_JSON, "utf-8"))
	);
} catch (err) {
	logWarn("models.dev catalog unreadable — its layer is skipped", {
		path: MODELS_DEV_JSON,
		error: /** @type {any} */ (err)?.message ?? String(err),
	});
}
for (const [id, p] of Object.entries(modelsDev)) {
	if (routableUrl(p.api ?? "")) {
		candidates.push({
			id,
			url: /** @type {string} */ (p.api),
			source: "models.dev",
		});
		continue;
	}
	// No usable `api` URL: defer to the record's ai-sdk package. Only
	// packages with a canonical public endpoint resolve; the rest are
	// documented skips (AI_SDK_PACKAGE_ENDPOINTS below).
	const pkg = AI_SDK_PACKAGE_ENDPOINTS[p.npm ?? ""];
	if (pkg?.endpoint) {
		candidates.push({ id, url: pkg.endpoint, source: "models.dev(npm)" });
	} else if (pkg?.reason) {
		skipped.push({ source: "models.dev", id, reason: pkg.reason });
	} else {
		skipped.push({
			source: "models.dev",
			id,
			reason: "no `api` URL and its npm package is unmapped",
		});
	}
}

// --- source 3: catwalk (crush's catalog) ------------------------------------
/** @type {{ providers?: Array<{ id?: string, api_endpoint?: string }> }} */
let catwalk = {};
try {
	catwalk = /** @type {typeof catwalk} */ (
		JSON.parse(readFileSync(CATWALK_FACTS_JSON, "utf-8"))
	);
} catch (err) {
	logWarn("catwalk facts cache unreadable — its layer is skipped", {
		path: CATWALK_FACTS_JSON,
		error: /** @type {any} */ (err)?.message ?? String(err),
	});
}
for (const p of catwalk.providers ?? []) {
	if (!p.id) continue;
	if (!routableUrl(p.api_endpoint ?? "")) {
		skipped.push({
			source: "catwalk",
			id: p.id,
			reason: "endpoint is an env/account placeholder or absent",
		});
		continue;
	}
	candidates.push({
		id: p.id,
		url: /** @type {string} */ (p.api_endpoint),
		source: "catwalk",
	});
}

// --- priority merge ----------------------------------------------------------
// First source to claim a NAME owns the route (pi-ai > models.dev > catwalk,
// docs/d038). Later claims on the same name are logged with what they lost;
// equal URLs are a quiet cross-catalog agreement, not a conflict.
/** @type {Map<string, { url: string, source: string }>} */
const routes = new Map();
/** @type {Record<string, number>} */
const perSource = {};
let overruled = 0;
for (const c of candidates) {
	perSource[c.source] = (perSource[c.source] ?? 0) + 1;
	const held = routes.get(c.id);
	if (held) {
		if (held.url === c.url) continue;
		logWarn(
			"route kept from the higher-priority source — lower source's endpoint ignored",
			{
				route: c.id,
				winner: `${held.source}: ${held.url}`,
				ignored: `${c.source}: ${c.url}`,
			},
		);
		overruled++;
		continue;
	}
	routes.set(c.id, { url: c.url, source: c.source });
}

if (skipped.length) {
	for (const s of skipped) {
		logInfo("source row not routable — no proxy route", {
			source: s.source,
			provider: s.id,
			reason: s.reason,
		});
	}
}

/** @type {{ listen: string, providers: Record<string, string> }} */
const cfg = {
	listen: "0.0.0.0:8080",
	// id → FULL real base URL (docs/d027), catalog routes first (insertion
	// order is kept for a stable, reviewable diff), then the LOCAL llama-swap
	// peer and the metadata passthroughs (see header).
	providers: Object.fromEntries([
		...[...routes.entries()].map(([id, r]) => [id, r.url]),
		["llama-swap", process.env.LLAMA_SWAP_BASE_URL ?? "http://127.0.0.1:8101"],
		// Static metadata passthroughs — public endpoints, no keys, never
		// fact-table rows (see header).
		["models.dev", "https://models.dev"],
		["catwalk", "https://catwalk.charm.land"],
	]),
};
const written = writeArtifact(out, `${JSON.stringify(cfg, null, 2)}\n`);
logInfo("wrote llm-reverse-proxy config", {
	path: written,
	routes: Object.keys(cfg.providers).length,
	perSource,
	overruled,
	skipped: skipped.length,
});

/** @type {{ providers?: Record<string, string> }} */
const deployedState = existsSync(out)
	? JSON.parse(readFileSync(out, "utf-8"))
	: {};
const deployed = deployedState.providers ?? {};
const missing = Object.keys(CLOUD_PROVIDERS).filter((id) => !deployed[id]);
if (missing.length) {
	logWarn(
		"providers in the fact table but NOT deployed — their peer path-routes are dead",
		{
			missing,
		},
	);
}
for (const [id, url] of Object.entries(deployed)) {
	const expected = CLOUD_PROVIDERS[id]?.baseUrl;
	if (expected && expected !== url) {
		logWarn("deployed upstream differs from the fact table — drift", {
			provider: id,
			deployed: url,
			factTable: expected,
		});
	}
}

// Orchestration (folded from the former generate.sh, docs/d041): the routing
// table must exist after generation — a silent no-op here would leave run.sh
// to die later with a config-missing error pointing back at this script. The
// check follows the ACTUAL output (`out`, the optional argv path) and, under
// DRY_RUN, the preview writeArtifact produced instead of the live artifact.
const generatedPath = isDryRun() ? `${out}.dry-run` : out;
if (!existsSync(generatedPath)) {
	logError("routing table not generated", { path: generatedPath });
	process.exit(1);
}
logInfo("routing table ready", { path: generatedPath });
