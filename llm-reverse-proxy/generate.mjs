/**
 * @fileoverview generate.mjs — the llm-reverse-proxy generator: emit
 * `llm-reverse-proxy.json`, the deployed HOST ALLOWLIST (v2, docs/d047 — the
 * v1 provider-slug table is gone, host routing is the only mode).
 *
 * The allowlist is the defaults of the OWNER's stack — nothing else is
 * routable (deny-by-absence, docs/d047):
 *
 *   1. pi-ai — the PI_AI_PROVIDERS table below (pi-coding-agent's built-in
 *      registry, extracted from the installed pi): one allowHosts row per
 *      DISTINCT upstream host, value scheme://host (the HOST ROOT — base
 *      paths belong to the client, which is what lets multi-base hosts like
 *      opencode vs opencode-go share one row).
 *   2. the lib/cloud-providers.mjs fact table (docs/d024) — the hand-added
 *      rows the catalogs never knew (cline-pass, hyper, inferx) plus the
 *      pi-native set.
 *   3. the llama-swap loopback (env LLAMA_SWAP_BASE_URL, default
 *      http://127.0.0.1:8101) — the ONE alias row, keyed by the stable route
 *      name `llama-swap` instead of host:port so client configs never put a
 *      loopback address in the request path. Every other row satisfies
 *      key === hostKey(value); the drift check below re-states this.
 *   4. two static metadata passthroughs, `models.dev` and `catwalk`
 *      (public, no keys, never drift-checked against the catalogs).
 *
 * pi-ai rows with NO single fixed upstream base (per-region bedrock,
 * per-project vertex, OAuth backends — PI_AI_NON_ROUTABLE below) are
 * reported as skips with their reason, so a gap in the allowlist is a
 * decision, never an oversight.
 *
 * The address contract this table serves (docs/d047): a client names the
 * upstream HOST as the first path segment and carries the provider's full
 * base path after it — `<peerBase>/<host><base-path>` (peerProviderUrl in
 * coding-agent/peer-probe.mjs, derived from the same fact-table base URLs).
 * The ONE exception is the `llama-swap` loopback row, named by its stable
 * route name instead of `127.0.0.1:8101` (header item 3). The proxy strips
 * the route key and single-joins the rest onto the root. Routes absent from
 * the table answer the plain funnel 404; keys are deliberately NOT consulted
 * — llm-reverse-proxy performs NO credential handling.
 *
 * Drift checking is keyed by host (docs/d047): a fact-table provider whose
 * upstream host is missing from the deployed allowHosts warns (dead host
 * route), and a deployed host no owner source claims warns (unreviewed
 * row). The `llama-swap` alias is claimed explicitly rather than derived.
 *
 * Overwrite semantics follow the repo-wide generator standard
 * (lib/artifact.mjs): a rerun REPLACES the deployed config by default;
 * DRY_RUN=1 writes an inspectable .dry-run preview instead.
 *
 * Usage: ./generate.sh (the standard wrapper — node_run interpreter
 * selection, same as the other environments) or node generate.mjs [out]
 *   out defaults to ./llm-reverse-proxy.json (the path run.sh serves).
 *   Env: LIB_DIR (default ../lib), DRY_RUN, LLAMA_SWAP_BASE_URL.
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
const { writeJsonArtifact, isDryRun } =
	/** @type {typeof import("../lib/artifact.mjs")} */ (
		await import(`${LIB_DIR}/artifact.mjs`)
	);
setLogTool("llm-reverse-proxy/generate");

const out = process.argv[2] ?? join(scriptDir, "llm-reverse-proxy.json");

// ---------------------------------------------------------------------------
// Source 1 fact table: pi-ai's BUILT-IN cloud providers (folded in from the
// former lib/pi-ai-providers.mjs — docs/d039; rationale docs/d038). Facts
// were extracted from the installed pi 0.85.1 provider registry and
// cross-checked against pi-mono's packages/ai/src/providers/*.ts. Like every
// vendored catalog here, the copy is a floor, not a feed: a stale row is a
// drifted route, so re-extract when the host's pi version moves.
//
// Only providers with a STABLE, account-independent HTTPS base URL are
// allowlisted — the proxy forwards to scheme://host, so per-region /
// per-project / per-account / OAuth endpoints cannot be expressed.
//
// `api` is the wire dialect pi-ai speaks against that base (informational:
// the proxy forwards byte-for-byte whatever the client sends, docs/d047).
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PiAiProviderFacts
 * @property {string} id pi provider id
 * @property {string} label human-readable name
 * @property {string} api the primary wire dialect pi-ai speaks at baseUrl
 * @property {string} baseUrl pi-ai's built-in base URL (FULL — the HOST
 *   feeds the allowlist key, the base PATH documents the client-side form
 *   peerProviderUrl composes)
 * @property {string} apiKeyEnv env var pi resolves the provider's key from
 *   (informational — the proxy performs no credential handling)
 * @property {Record<string, string>} [otherApis] dialect → base for the
 *   provider's remaining registrations (all must share the upstream host —
 *   peerProviderUrl and d048's per-model `api` overrides handle the dialect
 *   split client-side)
 */

/**
 * A pi-ai provider that cannot be routed through a host-allowlist proxy.
 * @typedef {object} PiAiNonRoutable
 * @property {string} id pi provider id
 * @property {string} reason why no single fixed upstream host exists
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
		// Four dialects against two bases (zen vs zen/v1) — all on the
		// opencode.ai HOST, so one allowlist row covers them; the client
		// carries its own base path (peerProviderUrl, docs/d047).
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
		// Same upstream as qwen-token-plan — one allowHosts row covers both;
		// the client's base path distinguishes nothing here (same base too).
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
 * pi-ai providers with NO single fixed upstream host — reported as skips so
 * the allowlist gap is a decision, never an oversight (docs/d047).
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
// The allowlist: owner-set hosts only (header). One row per DISTINCT
// upstream host; the value is the host root — base paths belong to the
// client (peerProviderUrl, docs/d047).
// ---------------------------------------------------------------------------

/** @param {string} url a full base URL
 * @returns {string} host[:port] key form
 */
function hostKey(url) {
	return new URL(url).host;
}
/** @param {string} url
 * @returns {string} scheme://host[:port] root
 */
function hostRoot(url) {
	const u = new URL(url);
	return `${u.protocol}//${u.host}`;
}

/** @type {Map<string, string>} host key → root */
const allowHosts = new Map();
/**
 * @param {string} id owner-set id, for the collapse log
 * @param {string} url its full base URL
 */
function allowHost(id, url) {
	const key = hostKey(url);
	// Same host from several owner rows collapses to one entry — the value
	// is the host root, so there is nothing to conflict on (docs/d047).
	if (!allowHosts.has(key)) {
		allowHosts.set(key, hostRoot(url));
		return;
	}
	logInfo("owner rows share one upstream host — collapsed to one allowlist row", {
		host: key,
		id,
	});
}

/**
 * The allowlist's one logical route name (docs/d047): the llama-swap loopback
 * learner is named for what it is, not for the 127.0.0.1:8101 it happens to
 * live on, so regenerating client configs never embeds a loopback host. This
 * is the ONLY row where the key is not the upstream host — the routing
 * convention's one exception, restated in the drift check below and matched
 * by peerProviderUrl on the client side.
 * @type {string}
 */
const LLAMA_SWAP_ROUTE = "llama-swap";

/**
 * Add the stable-name exception row: same shape as allowHost, but keyed by a
 * logical route name rather than the upstream host.
 * @param {string} name the route name / first path segment
 * @param {string} url its full base URL
 */
function allowHostAlias(name, url) {
	// A route name colliding with a real host key is the only way this row
	// could shadow a host route; refuse and let the log surface it rather than
	// silently re-point an unrelated provider.
	if (allowHosts.has(name)) {
		logWarn("allowlist alias collides with an existing row — not overwritten", {
			alias: name,
		});
		return;
	}
	allowHosts.set(name, hostRoot(url));
}

for (const p of Object.values(PI_AI_PROVIDERS)) {
	allowHost(p.id, p.baseUrl);
}
for (const [id, facts] of Object.entries(CLOUD_PROVIDERS)) {
	allowHost(id, facts.baseUrl);
}
allowHostAlias(
	LLAMA_SWAP_ROUTE,
	process.env.LLAMA_SWAP_BASE_URL ?? "http://127.0.0.1:8101",
);
allowHost("models.dev", "https://models.dev");
allowHost("catwalk", "https://catwalk.charm.land");

for (const p of Object.values(PI_AI_NON_ROUTABLE)) {
	logInfo("pi-ai row has no fixed upstream host — not allowlisted", {
		provider: p.id,
		reason: p.reason,
	});
}

/** @type {{ listen: string, allowHosts: Record<string, string> }} */
const cfg = {
	listen: "0.0.0.0:8080",
	allowHosts: Object.fromEntries(allowHosts),
};
const written = writeJsonArtifact(out, cfg);
logInfo("wrote llm-reverse-proxy host-allowlist config", {
	path: written,
	allowHosts: allowHosts.size,
});

// ---------------------------------------------------------------------------
// Drift checks, keyed by host (docs/d047): the deployed file is re-read so
// the report reflects what run.sh will serve, not what this run just held in
// memory — same contract the former slug-table checks had.
// ---------------------------------------------------------------------------
/** @type {{ allowHosts?: Record<string, string> }} */
const deployedState = existsSync(out)
	? JSON.parse(readFileSync(out, "utf-8"))
	: {};
const deployedAllowHosts = deployedState.allowHosts ?? {};
for (const [id, facts] of Object.entries(CLOUD_PROVIDERS)) {
	if (!(hostKey(facts.baseUrl) in deployedAllowHosts)) {
		logWarn("fact-table provider's host NOT in the deployed allowHosts", {
			provider: id,
			host: hostKey(facts.baseUrl),
		});
	}
}
for (const key of Object.keys(deployedAllowHosts)) {
	/**
	 * The owner set is pi-ai ∪ fact table ∪ the three hand-added rows
	 * (passthroughs + llama-swap loopback).
	 */
	const known =
		Object.values(PI_AI_PROVIDERS).some((p) => hostKey(p.baseUrl) === key) ||
		Object.values(CLOUD_PROVIDERS).some((f) => hostKey(f.baseUrl) === key) ||
		key === hostKey("https://models.dev") ||
		key === hostKey("https://catwalk.charm.land") ||
		key === LLAMA_SWAP_ROUTE;
	if (!known) {
		logWarn("deployed allowHosts entry no owner source claims — drift", {
			host: key,
		});
	}
}

// Orchestration (folded from the former generate.sh, docs/d041): the
// allowlist must exist after generation — a silent no-op here would leave
// run.sh to die later with a config-missing error pointing back at this
// script. The check follows the ACTUAL output (`out`, the optional argv
// path) and, under DRY_RUN, the preview writeJsonArtifact produced instead of
// the live artifact.
const generatedPath = isDryRun() ? `${out}.dry-run` : out;
if (!existsSync(generatedPath)) {
	logError("host allowlist not generated", { path: generatedPath });
	process.exit(1);
}
logInfo("host allowlist ready", { path: generatedPath });
