/**
 * @fileoverview pi-ai-providers.mjs — the vendored fact table for pi-ai's
 * BUILT-IN cloud providers (the registry pi-coding-agent ships, docs/d038).
 * Consumed by llm-reverse-proxy/generate-config.mjs as the top-priority
 * source of the deployed routing table: same provider name in several
 * sources ⇒ pi-ai wins (docs/d038 priority pi-ai > models.dev > catwalk).
 *
 * Facts were extracted from the installed pi 0.85.1 provider registry (the
 * binary's embedded catalog data carries every built-in provider's
 * api/baseUrl pair) and cross-checked against pi-mono's
 * packages/ai/src/providers/*.ts. Like every vendored catalog here, the copy
 * is a floor, not a feed: a stale row is a drifted route, so re-extract when
 * the host's pi version moves.
 *
 * Only providers with a STABLE, account-independent HTTPS base URL are
 * routable through a path-prefix proxy. Everything else lives in
 * NON_ROUTABLE with the reason — the proxy forwards `<peerBase>/<id>` to one
 * fixed upstream base, so per-region/per-project/per-account/OAuth endpoints
 * cannot be expressed (docs/d038).
 *
 * `api` is the wire dialect pi-ai speaks against that base (informational:
 * the proxy forwards byte-for-byte whatever the client sends, docs/d027).
 * Multi-dialect providers register several (api, baseUrl) pairs — e.g.
 * opencode speaks four dialects against two bases; the row records the
 * openai-completions base (the one the fact table and models.dev agree on)
 * and lists the rest in `otherApis`, mirroring the single-baseUrl
 * limitation pi's own models.json overrides already accepted (docs/d027).
 *
 * Import via the LIB_DIR convention (docs/d023).
 */

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
export const PI_AI_PROVIDERS = Object.freeze({
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
export const PI_AI_NON_ROUTABLE = Object.freeze({
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
