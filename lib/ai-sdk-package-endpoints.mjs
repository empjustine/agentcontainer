/**
 * @fileoverview ai-sdk-package-endpoints.mjs — vendored map from the ai-sdk
 * npm package each models.dev provider record names (`npm` field) to the
 * package's canonical public endpoint. Consumed by
 * llm-reverse-proxy/generate-config.mjs as the fallback for models.dev
 * records that carry no `api` base URL (26 of ~213 at authoring time — the
 * records that defer endpoint resolution to the npm package, docs/d038).
 *
 * The mapping only covers packages whose endpoint is CANONICAL AND PUBLIC —
 * the same stable-endpoint rule as the pi-ai table (lib/pi-ai-providers.mjs).
 * Account-scoped or per-deployment packages map to `null` with a reason, so
 * a gap in the routing table is always a documented decision, never
 * an oversight. Endpoints were verified against the vendors' published API
 * references; a wrong row here silently reroutes every model of a provider,
 * so a row must be able to cite its source in one line.
 *
 * Import via the LIB_DIR convention (docs/d023).
 */

/**
 * @typedef {object} AiSdkPackageEndpoint
 * @property {string|null} endpoint the package's canonical public API base,
 *   or null when no single fixed public endpoint exists
 * @property {string} [reason] why endpoint is null (required when null)
 */

/** @type {Readonly<Record<string, AiSdkPackageEndpoint>>} */
export const AI_SDK_PACKAGE_ENDPOINTS = Object.freeze({
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
