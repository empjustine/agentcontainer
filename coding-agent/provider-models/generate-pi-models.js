#!/usr/bin/env node
// See README.md for usage, env vars reference, and design decisions.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";

// HF flat-model cache lookup (models-local/) — lives with the cache tooling.
import { modelArgs } from "../../huggingface/models-local.mjs";

// Directory this script lives in — used for relative data-file and dump paths.
const scriptDir = dirname(fileURLToPath(import.meta.url));

// HTTP proxy support — see README for rationale.

if (
  process.env.http_proxy || process.env.HTTP_PROXY ||
  process.env.https_proxy || process.env.HTTPS_PROXY
) {
  try {
    const require = createRequire(import.meta.url);
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch (err) {
    console.warn(
      `  warning: http_proxy/https_proxy is set but undici's EnvHttpProxyAgent ` +
      `could not be loaded: ${err.message} — fetch requests will NOT use ` +
      "the proxy",
    );
  }
}

// Well under 10s so a hung request doesn't block the whole generation step.
const REQUEST_TIMEOUT_MS = 8000;

/**
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Preserve unfiltered API responses for offline inspection.
// Silently skip on read-only script directories (e.g. container :ro mounts)
// so a failed dump doesn't abort the provider fetch.
// Unfiltered API dumps go to the legacy data directory (not this code dir).
function dumpRawJson(name, data) {
  const dumpDir = join(scriptDir, "..", "..", "provider-models");
  const out = join(dumpDir, name);
  try {
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
  } catch {
    return;
  }
}

// =====================================================================
// 2.  Provider definitions
// =====================================================================

// Add more entries here to extend to other providers.
const BUILDIN_PROVIDERS = [
  {
    id: "openrouter-free",
    api: "openai-completions",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    apiKeyEnv: "__OPENROUTER_API_KEY",
  },
  {
    id: "opencode-zen-free",
    api: "openai-completions",
    baseUrlEnv: "OPENCODE_ZEN_BASE_URL",
    apiKeyEnv: "__OPENCODE_ZEN_API_KEY",
    // Without a key the API returns ALL models (including paid ones);
    // with a key it restricts to free-tier models server-side.
    requireApiKey: true,
  },
  {
    id: "opencode-go-sub",
    api: "openai-completions",
    baseUrlEnv: "OPENCODE_GO_BASE_URL",
    // Dedicated env var — MODEL_FILTERS gates on its presence.
    apiKeyEnv: "__OPENCODE_GO_API_KEY",
  },
  {
    id: "google-free",
    api: "google-generative-ai",
    baseUrlEnv: "GOOGLE_BASE_URL",
    apiKeyEnv: "__GEMINI_API_KEY",
    fetchAuth: "x-goog-api-key",
    modelIdPrefix: "models/",
  },
  {
    id: "mistral-free",
    api: "openai-completions",
    baseUrlEnv: "MISTRAL_BASE_URL",
    apiKeyEnv: "__MISTRAL_API_KEY",
  },
  {
    id: "clinepass",
    api: "openai-completions",
    // Gated behind __CLINE_API_KEY — only appears when the user has a credential.
    baseUrlEnv: "CLINE_BASE_URL",
    apiKeyEnv: "__CLINE_API_KEY",
    requireApiKey: true,
  },
];

// Fallback when *_BASE_URL is unset — lets the script run with no env vars.
const DEFAULT_BASE_URLS = {
  "openrouter-free":   "https://openrouter.ai/api/v1",
  "opencode-zen-free": "https://opencode.ai/zen/v1",
  "opencode-go-sub":   "https://opencode.ai/zen/go/v1",
  "google-free":       "https://generativelanguage.googleapis.com/v1beta",
  "mistral-free":      "https://api.mistral.ai/v1",
  "clinepass":          "https://api.cline.bot/v1",
};

// Unlike built-in providers, llama.cpp has no hardcoded model list.
// We fetch it from the running instance.
const LLAMACPP = {
  id: "llamacpp",
  baseUrlEnv: "LLAMACPP_BASE_URL",
  baseUrlFallback: "LLAMA_API_BASE_URL",
  apiKeyEnv: "__LLAMACPP_API_KEY",
};

// Client-side filters applied against live /models responses.
// Providers without a filter entry get override-only (baseUrl + apiKey, no models).
const MODEL_FILTERS = {
  "openrouter-free":   (m) => m.id.endsWith(":free"),
  "opencode-zen-free": (m) => m.id.endsWith("-free"),
  // Keep all models, but only while __OPENCODE_GO_API_KEY is available.
  // With the key absent the filter drops every model, so this provider is
  // effectively disabled and no tier/paid models are exposed.
  "opencode-go-sub":  (m) => {
    if (process.env["__OPENCODE_GO_API_KEY"] === undefined) return false;
    return !m.id.toLowerCase().includes("grok");
  },
  "mistral-free":      (m) => {
    const id = m.id.toLowerCase();
    return id.includes("devstral") || id.includes("devstral-small");
  },
  "clinepass":         (_m) => process.env["__CLINE_API_KEY"] !== undefined,
  "google-free":       (m) => {
    const id = (m.id || "").replace(/^models\//, "").toLowerCase();
    // Gemma 4 (always free)
    if (id.includes("gemma-4")) return true;
    // Gemini Flash models (free tier) — exclude pro/enterprise and previews
    if (id.includes("flash") && !id.includes("pro") && !id.includes("preview")) return true;
    return false;
  },
};

// Context windows and model capabilities are loaded from the canonical
// openai-completions/llamacpp-model-data.json.  That file is the single source
// of truth for model capabilities (input/output modalities, context windows)
// shared with the generated config.yaml.
// Models with no matching entry in the canonical data fall back to slug-based
// ctxNNN parsing (e.g. `ctx200` → 200000) or a default of 65536.
/**
 * Load the canonical llama.cpp model data from llamacpp-model-data.json.
 * @returns {{ ctxWindows: Record<string, number>, modelCapabilities: Record<string, {capabilities: {in: string[], out: string[]}, contextWindow: number}> }}
 */
function loadLlamaCppModelData() {
  const dataPath = join(scriptDir, "..", "..", "openai-completions", "llamacpp-model-data.json");
  try {
    return JSON.parse(readFileSync(dataPath, "utf-8"));
  } catch {
    console.warn(
      "  note: llamacpp-model-data.json not found or invalid — " +
      "llama.cpp models will use slug-based ctx resolution and default capabilities",
    );
    return { ctxWindows: {}, models: [] };
  }
}

// Loaded once at module startup.
const LLAMACPP_MODEL_DATA = loadLlamaCppModelData();

/**
 * Resolve a llama-swap model's context window from its ID slug.
 *
 * The slug embeds the `ctxNNN` macro used in the llama-swap config (e.g.
 * `a03b-q4-k80v80-ctx200-byteshape/Qwen3.6-35B-A3B` → ctx200 → 200000).
 * We extract that component and map it to the matching context window
 * value from the canonical JSON's ctxWindows.  Models with no `ctxNNN`
 * component fall back to LLAMACPP_CTX_WINDOWS_DEFAULT.
 *
 * @param {string} modelId  Model ID as returned by llama-swap's /models.
 * @returns {number}        Context window in tokens.
 */
function resolveLlamaCppContextWindow(modelId) {
  const DEFAULT = 65536;
  const m = modelId.match(/-ctx(\d+)(?=[-/])/);
  if (!m) return DEFAULT;
  return (LLAMACPP_MODEL_DATA.ctxWindows ?? {})["CTX" + m[1]] ?? DEFAULT;
}

/**
 * Map from custom provider IDs (which avoid collision with pi's built-in
 * provider names) to the standard pi provider IDs used as keys in
 * PI_MODEL_METADATA.  This allows the metadata mirror to correctly match
 * per-model compat/thinkingFormat/reasoning settings even though the
 * generated provider has a different name.
 */
const METADATA_PROVIDER_MAP = {
  "openrouter-free":   "openrouter",
  "opencode-zen-free": "opencode",
  "opencode-go-sub":  "opencode-go",
  "google-free":       "google",
  "mistral-free":      "mistral",
  "clinepass":          "cline",
};

// =====================================================================
// 3. pi model metadata mirror
// =====================================================================

// Pi ships a curated catalog with per-model OpenAI-compatibility and
// reasoning settings (compat, thinkingFormat, reasoning, thinkingLevelMap)
// that provider /models endpoints do NOT return.  PI_MODEL_METADATA mirrors
// those fields from pi's built-in definitions (see pi-model-metadata.json),
// so generated models behave identically to pi's own list.  Everything else
// (id, name, contextWindow, maxTokens, cost, input) still comes from the
// live /models API at generation time.
//
// Regenerate pi-model-metadata.json against the installed pi build (it is a
// snapshot of @earendil-works/pi-ai's model definitions).  If the file is
// missing, the script still works — it just omits those pi-only fields.
const PI_MODEL_METADATA = loadPiModelMetadata();

// --- OpenCode pricing snapshots (stale docs) --------------------------
//
// OpenCode Go effective per-1M-token rates, transcribed from the canonical
// pricing table at opencode.ai/docs/go (packages/web/src/content/docs/go.mdx).
// These are the "look-alike" rates OpenCode passes through for its $10/mo Go
// subscription; they match pi's own hardcoded Kimi costs and are already in
// pi's cost units (USD per 1M tokens).
// Edit opencode-go-pricing.json if the doc changes.
const OPENCODE_GO_PRICING = loadPricingJson("opencode-go-pricing.json",
  "opencode-go-pricing.json not found — opencode-go models will use the virtual cost estimate");

// OpenCode Zen per-1M-token rates, transcribed from the canonical pricing
// table at opencode.ai/docs/zen (packages/web/src/content/docs/zen.mdx).
// Used as a fallback for opencode-go models that also appear on the Zen
// paid tier (where Go's subscription rates aren't documented).
// Edit opencode-zen-pricing.json if the doc changes.
const OPENCODE_ZEN_PRICING = loadPricingJson("opencode-zen-pricing.json",
  "opencode-zen-pricing.json not found — opencode-go models without Go-doc pricing will fall through to virtual cost");

const CLINEPASS_PRICING = loadPricingJson("clinepass-pricing.json",
  "clinepass-pricing.json not found — clinepass models will fall through to virtual cost");

function loadPricingJson(name, warnMsg) {
  try {
    const path = join(scriptDir, "..", "..", "provider-models", name);
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    console.warn(`  note: ${warnMsg}`);
    return {};
  }
}

/**
 * Look up a model's cost from a pricing map, matching on the bare id.
 * The /models endpoint may namespace ids with a colon prefix
 * (e.g. "opencode-go:grok-4.5") or a path prefix
 * (e.g. "cline-pass/glm-5.2"); we strip both and match the tail.
 * @param {object} pricingMap  map of bare-id → cost object
 * @param {string} modelId     raw model id, possibly prefixed
 * @returns {{input,output,cacheRead,cacheWrite}|null}
 */
function lookupCost(pricingMap, modelId) {
  // Strip pi-internal provider prefix (e.g. "opencode-go:grok-4.5" → "grok-4.5")
  let key = modelId.includes(":") ? modelId.split(":").pop() : modelId;
  // Strip API path prefix (e.g. "cline-pass/glm-5.2" → "glm-5.2")
  key = key.includes("/") ? key.split("/").pop() : key;
  return pricingMap[key.toLowerCase()] || null;
}

// --- Fresh (live) Zen API pricing cache --------------------------------
//
// Populated at generation time by fetchZenPricing() — an unfiltered fetch
// to the Zen /models endpoint (no auth) that returns ALL models with their
// real per-token costs.  Used as the first check before stale snapshots.
let ZEN_LIVE_PRICING = null;

// =====================================================================
// 3c. Cross-provider equivalent pricing database
// =====================================================================

/**
 * Global pricing database: maps a normalized (canonical) model ID to an
 * array of real (non-virtual) cost entries sourced from every provider's
 * /models response.
 *
 * Populated at generation time by fetchProviderModels() (from ALL unfiltered
 * models in each response, not just the filtered subset) and pre-loaded from
 * the static opencode-*-pricing.json files.  Used by resolveCostWithDB() as a
 * fallback: when a model has no real pricing of its own (e.g. a local llama.cpp
 * model or a :free variant), the script looks up the same base model across
 * providers and picks the most expensive non-nitro, non-throughput variant's
 * cost.
 */
const PRICING_DB = new Map();

/**
 * Pre-populate PRICING_DB from the static pricing snapshot files.
 * These contain accurate documented costs for OpenCode Go / Zen models
 * and serve as cross-provider references for locally-run equivalents.
 */
// Pre-populate PRICING_DB from static pricing snapshot files.
for (const { name, data } of [
  { name: "OpenCode Go", data: OPENCODE_GO_PRICING },
  { name: "OpenCode Zen", data: OPENCODE_ZEN_PRICING },
]) {
  for (const [bareId, cost] of Object.entries(data)) {
    if (Number(cost.output) > 0 || Number(cost.input) > 0) {
      const key = normalizeModelId(bareId);
      if (!PRICING_DB.has(key)) PRICING_DB.set(key, []);
      PRICING_DB.get(key).push({
        input: Number(cost.input) || 0,
        output: Number(cost.output) || 0,
        cacheRead: Number(cost.cacheRead) || 0,
        cacheWrite: Number(cost.cacheWrite) || 0,
        variant: "standard",
        source: name,
      });
    }
  }
}

/**
 * Fetch the OpenCode Zen /models endpoint without authentication to obtain
 * real-time per-token pricing for all models (including paid ones).
 * Returns a map of modelId → cost, or null.
 */
async function fetchZenPricing(baseUrl) {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const body = await res.json();
    const data = body.data || body.models || body;
    if (!Array.isArray(data)) return null;
    const map = {};
    for (const m of data) {
      const cost = extractRealCost(m.id, m, 1e6);
      if (cost) map[m.id] = cost;
    }
    return Object.keys(map).length > 0 ? map : null;
  } catch {
    return null;
  }
}

function loadPiModelMetadata() {
  try {
    const path = join(scriptDir, "..", "..", "provider-models", "pi-model-metadata.json");
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    console.warn(
      "  note: pi-model-metadata.json not found — generated models will omit " +
      "pi's compat/thinkingFormat/reasoning settings"
    );
    return {};
  }
}

// =====================================================================
// 3b. Virtual cost estimation
// =====================================================================

// When no real pricing is available, estimate cost from parameter count.
// Free variants and their paid siblings share the same intrinsic cost
// (freeness is a billing artifact, not a capability difference).
// Premium variants (:nitro) cost more, throughput-optimized variants cost less.
// Tunable constants live here for easy adjustment.
const VIRTUAL_COST = {
  // USD per 1M output tokens ≈ this × parameter-count-in-billions.
  perBillionOutput: 0.012,
  minOutput: 0.02,
  // input is a fraction of output (prompts are cheaper to serve).
  inputRatio: 0.25,
  // cache economics roughly mirror OpenRouter's: read ≪ write.
  cacheReadRatio: 0.1,
  cacheWriteRatio: 1.25,
  // Variant multipliers, applied to every cost component.
  variantMultipliers: {
    nitro: 2.5,      // premium / high-throughput tier
    throughput: 0.5,  // throughput-optimized, cheaper to serve
    online: 1.2,     // web-search surcharge
    default: 1.0,    // :free and the "normal" paid variant both use this
  },
  // Fallback size (billions) when no size is parseable from the id, so two
  // un-sized siblings (e.g. tencent/hy3:free vs tencent/hy3) still align.
  fallbackBillions: 30,
};

// Split "tencent/hy3:free" into base (tencent/hy3) and variant suffix.
// Key the capability estimate on the base so free/paid siblings get equal cost.
function parseModelVariant(modelId) {
  const [base, ...rest] = modelId.split(":");
  const variant = rest.join(":").toLowerCase();
  const known = ["free", "nitro", "throughput", "online", "thinking"];
  return {
    base,
    variant: known.includes(variant) ? variant : "standard",
    nitro: variant.includes("nitro"),
    throughput: variant.includes("throughput"),
    online: variant.includes("online"),
  };
}

// Parse parameter count (billions) from model IDs like "Qwen3.6-35B-A3B" → 35.
// MoE IDs with two sizes use the total (first) size.
function estimateParamBillions(modelId) {
  const m = modelId.match(/(\d+(?:\.\d+)?)\s*([bm])/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2].toLowerCase() === "m") n /= 1000; // millions → billions
  return n;
}

/**
 * @param {string} modelId
 * @returns {{input:number,output:number,cacheRead:number,cacheWrite:number}}
 */
function virtualCost(modelId) {
  const { base, nitro, throughput, online } = parseModelVariant(modelId);
  const sizeB =
    estimateParamBillions(base) || estimateParamBillions(modelId) || VIRTUAL_COST.fallbackBillions;

  let mult = VIRTUAL_COST.variantMultipliers.default;
  if (nitro) mult = VIRTUAL_COST.variantMultipliers.nitro;
  else if (throughput) mult = VIRTUAL_COST.variantMultipliers.throughput;
  else if (online) mult = VIRTUAL_COST.variantMultipliers.online;

  const output = Math.max(VIRTUAL_COST.minOutput, VIRTUAL_COST.perBillionOutput * sizeB) * mult;
  const input = output * VIRTUAL_COST.inputRatio;
  return {
    input,
    output,
    cacheRead: input * VIRTUAL_COST.cacheReadRatio,
    cacheWrite: input * VIRTUAL_COST.cacheWriteRatio,
  };
}

/**
 * Extract real (non-virtual, non-zero) cost from a raw model object.
 * Returns null if no real pricing is available (zero, sentinel, or absent).
 *
 * Handles the same shapes as resolveCostWithDB:
 *   • `cost`    — OpenCode / models.dev shape (already in pi's units)
 *   • `pricing` — OpenRouter / AI-Gateway shape (USD per token, ×1e6)
 *                or per-million (Together / DeepInfra style), depending
 *                on the provider's PRICING_MULTIPLIER.
 *
 * @param {string}  modelId     Model ID (for logging).
 * @param {object}  [raw={}]    Raw model object from /models endpoint.
 * @param {number}  [multiplier=1e6]
 *   Multiplier for `pricing.*` values.  Default 1e6 (per-token → per-million).
 *   Per-million providers pass 1 so values are used as-is.
 */
function extractRealCost(modelId, raw = {}, multiplier = 1e6) {
  const cost = raw.cost;
  if (cost && (Number(cost.output) > 0 || Number(cost.input) > 0)) {
    return {
      input: Number(cost.input) || 0,
      output: Number(cost.output) || 0,
      cacheRead: Number(cost.cache_read) || 0,
      cacheWrite: Number(cost.cache_write) || 0,
    };
  }

  const pricing = raw.pricing;
  if (pricing) {
    const inTok = Number(pricing.prompt ?? pricing.input) || 0;
    const outTok = Number(pricing.completion ?? pricing.output) || 0;
    // Skip sentinel / negative values (e.g. OpenRouter uses -1 for unavailable)
    if ((outTok > 0 || inTok > 0) && inTok >= 0 && outTok >= 0) {
      const cr = Number(pricing.cache_read ?? pricing.input_cache_read) || 0;
      const cw = Number(pricing.cache_write ?? pricing.input_cache_write) || 0;
      return {
        input: inTok * multiplier,
        output: outTok * multiplier,
        cacheRead: cr * multiplier,
        cacheWrite: cw * multiplier,
      };
    }
  }

  return null;
}

// Strip path prefix (last "/"), variant suffix (:free/:nitro/...), and lowercase
// so IDs like "qwen/qwen3.6-35b-a3b:free" and "a03b-.../Qwen3.6-35B-A3B"
// both normalize to "qwen3.6-35b-a3b" for cross-provider matching.
function normalizeModelId(modelId) {
  let id = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  id = id.replace(/:(free|nitro|throughput|online|thinking)$/i, "");
  return id.toLowerCase();
}

// Look up equivalent pricing from the cross-provider PRICING_DB.
// Prefers non-nitro, non-throughput variants; picks the most expensive match.
// Falls back to nitro/throughput-only entries rather than returning nothing.
/**
 * @param {string} modelId
 * @param {Map}    pricingDB
 * @returns {{input,output,cacheRead,cacheWrite}|null}
 */
function lookupEquivalentPricing(modelId, pricingDB) {
  const key = normalizeModelId(modelId);
  const entries = pricingDB.get(key);
  if (!entries || entries.length === 0) return null;

  // Prefer non-nitro, non-throughput variants
  const preferred = entries.filter(e => e.variant !== "nitro" && e.variant !== "throughput");
  const candidates = preferred.length > 0 ? preferred : entries;

  // Pick the most expensive (highest output cost)
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].output > best.output) best = candidates[i];
  }

  return {
    input: best.input,
    output: best.output,
    cacheRead: best.cacheRead,
    cacheWrite: best.cacheWrite,
  };
}

// Cost resolution: 1) real provider pricing, 2) cross-provider equivalent via PRICING_DB, 3) virtual heuristic.
/**
 * @param {string}  modelId
 * @param {object}  raw
 * @param {Map}     pricingDB
 * @param {number}  [multiplier=1e6]
 */
function resolveCostWithDB(modelId, raw, pricingDB, multiplier = 1e6) {
  // 1. Real provider pricing
  const real = extractRealCost(modelId, raw, multiplier);
  if (real) return real;

  // 2. Cross-provider equivalent
  const equiv = lookupEquivalentPricing(modelId, pricingDB);
  if (equiv) return equiv;

  // 3. Virtual cost fallback
  return virtualCost(modelId);
}

// =====================================================================
// 4.  Model fetchers
// =====================================================================

async function fetchLlamaCppModels(baseUrl, apiKey) {
  const url = baseUrl.replace(/\/+$/, "") + "/models";

  const res = await fetchWithTimeout(url, {
    headers: apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : undefined,
  });

  if (!res.ok) {
    throw new Error(
      `GET ${url} returned ${res.status} ${res.statusText}` +
      (apiKey ? "" : " (no API key provided)")
    );
  }

  const body = await res.json(); // { object: "list", data: [{ id, ... }, ...] }
  const data = body.data || body.models || body; // handle { data: [...] }, { models: [...] }, and bare arrays

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`GET ${url} returned no models`);
  }

  dumpRawJson("llamacpp-raw-models.json", data);

  const capabilities = Object.fromEntries(
    (LLAMACPP_MODEL_DATA.models || []).map(mdl => [mdl.id, mdl])
  );

  return data.map((m) => {
    const canonical = capabilities[m.id];
    const ctx = canonical?.contextWindow ?? m.context_length ?? resolveLlamaCppContextWindow(m.id);
    return {
      id: m.id,
      name: "llamacpp " + m.id,
      api: "openai-completions",
      provider: "llamacpp",
      baseUrl: baseUrl.replace(/\/+$/, ""),
      reasoning: true,
      input: canonical?.capabilities?.in ?? m.architecture?.input_modalities ?? ["text"],
      contextWindow: ctx,
      maxTokens: ctx,
      cost: resolveCostWithDB(m.id, m, PRICING_DB, 1e6),
      compat: { supportsDeveloperRole: false },
    };
  });
}

/**
 * Build the auth header object for a provider fetch.
 * @param {string} apiKey
 * @param {string} [fetchAuth="bearer"]
 * @returns {Record<string,string>|undefined}
 */
function buildAuthHeaders(apiKey, fetchAuth = "bearer") {
  if (!apiKey) return undefined;
  switch (fetchAuth) {
    case "x-goog-api-key": return { "X-Goog-Api-Key": apiKey };
    case "none":           return undefined;
    default:               return { Authorization: `Bearer ${apiKey}` };
  }
}

/**
 * Fetch /models (or /v1/models with 404 fallback) and return the parsed models array.
 * @param {string} baseUrl
 * @param {Record<string,string>|undefined} headers
 * @returns {Promise<{data: object[], url: string}>}
 */
async function fetchModelsJson(baseUrl, headers, apiKey, fetchAuth) {
  let url = baseUrl.replace(/\/+$/, "") + "/models";
  let res = await fetchWithTimeout(url, { headers });

  if (res.status === 404 && !url.endsWith("/v1/models")) {
    url = baseUrl.replace(/\/+$/, "") + "/v1/models";
    res = await fetchWithTimeout(url, { headers });
  }

  if (!res.ok) {
    let body;
    try { body = await res.text(); } catch {}
    const detail = body ? `: ${body.slice(0, 500)}` : "";
    throw new Error(`GET ${url} returned ${res.status} ${res.statusText}${detail}`);
  }

  const body = await res.json();
  const data = body.data || body.models || body;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`GET ${url} returned no models`);
  }
  return { data, url };
}

/**
 * Apply opencode-go-sub cost overrides.
 * Priority: 1) fresh Zen API, 2) fresh Go API, 3) stale Go docs, 4) stale Zen docs.
 */
function applyOpenCodeGoCost(model, cleanId, raw) {
  if (ZEN_LIVE_PRICING) {
    const zc = lookupCost(ZEN_LIVE_PRICING, cleanId);
    if (zc) { model.cost = zc; return model; }
  }
  const rawCost = raw.cost;
  const rawPricing = raw.pricing;
  if ((rawCost && (Number(rawCost.output) > 0 || Number(rawCost.input) > 0)) ||
      (rawPricing && (Number(rawPricing.completion ?? rawPricing.output) > 0 ||
                      Number(rawPricing.prompt ?? rawPricing.input) > 0))) {
    return model;
  }
  const go = lookupCost(OPENCODE_GO_PRICING, cleanId);
  if (go) { model.cost = go; return model; }
  const zen = lookupCost(OPENCODE_ZEN_PRICING, cleanId);
  if (zen) { model.cost = zen; return model; }
  return model;
}

/**
 * Apply clinepass cost override — prefer documented pricing over virtual heuristic.
 */
function applyClinePassCost(model, cleanId) {
  const cp = lookupCost(CLINEPASS_PRICING, cleanId);
  if (cp) { model.cost = cp;}
  return model;
}

/**
 * Populate the cross-provider pricing DB from a raw /models response.
 */
function populatePricingDB(data, modelIdPrefix, priceMult, providerId) {
  for (const m of data) {
    const rawId = m.id;
    if (!rawId) continue;
    const cleanId = modelIdPrefix && typeof rawId === "string" && rawId.startsWith(modelIdPrefix)
      ? rawId.slice(modelIdPrefix.length)
      : rawId;
    const real = extractRealCost(cleanId, m, priceMult);
    if (real) {
      const key = normalizeModelId(cleanId);
      if (!PRICING_DB.has(key)) PRICING_DB.set(key, []);
      PRICING_DB.get(key).push({
        input: real.input,
        output: real.output,
        cacheRead: real.cacheRead,
        cacheWrite: real.cacheWrite,
        variant: parseModelVariant(cleanId).variant,
        source: providerId,
      });
    }
  }
}

/**
 * @param {string}  baseUrl
 * @param {string}  apiKey
 * @param {function} filterFn
 * @param {string}  providerId
 * @param {object}  opts
 * @param {string}  [opts.fetchAuth="bearer"]
 * @param {string}  [opts.modelIdPrefix=""]
 */
async function fetchProviderModels(baseUrl, apiKey, filterFn, providerId, opts = {}) {
  const {
    fetchAuth = "bearer",
    modelIdPrefix = "",
  } = opts;

  const headers = buildAuthHeaders(apiKey, fetchAuth);
  const { data, url } = await fetchModelsJson(baseUrl, headers, apiKey, fetchAuth);

  dumpRawJson(`${providerId}-raw-models.json`, data);

  // Build cross-provider pricing DB from ALL (unfiltered) models
  // so free / local models inherit cost from their paid siblings.
  const priceMult = 1e6;
  populatePricingDB(data, modelIdPrefix, priceMult, providerId);

  return data.filter(filterFn).map((m) => {
    const rawId = m.id ?? "unknown";
    // Strip provider-specific prefix (e.g. Google's "models/") so metadata keys match.
    const cleanId = modelIdPrefix && typeof rawId === "string" && rawId.startsWith(modelIdPrefix)
      ? rawId.slice(modelIdPrefix.length)
      : rawId;

    const model = {
      id: cleanId,
      name: cleanId,
      input: ["text"],
      contextWindow: m.context_length ?? 128000,
      maxTokens: m.max_tokens ?? m.context_length ?? 65536,
      cost: resolveCostWithDB(cleanId, m, PRICING_DB, priceMult),
    };
    // Mirror pi's per-model settings from pi-model-metadata.json
    const meta = PI_MODEL_METADATA[METADATA_PROVIDER_MAP[providerId] ?? providerId]?.[cleanId];
    if (meta) {
      for (const k of ["compat", "thinkingFormat", "reasoning", "thinkingLevelMap"]) {
        if (meta[k] !== undefined && model[k] === undefined) model[k] = meta[k];
      }
    }

    if (providerId === "opencode-go-sub") return applyOpenCodeGoCost(model, cleanId, m);
    if (providerId === "clinepass") return applyClinePassCost(model, cleanId);

    return model;
  });
}

// =====================================================================
// 5.  Main
// =====================================================================

async function fetchForProvider(p, baseUrl, apiKey, effectiveFilter, opts, entry) {
  if (p.id === "opencode-go-sub") {
    const zenBaseUrl = process.env["OPENCODE_ZEN_BASE_URL"] || DEFAULT_BASE_URLS["opencode-zen-free"];
    if (zenBaseUrl) ZEN_LIVE_PRICING = await fetchZenPricing(zenBaseUrl);
  }
  const models = await fetchProviderModels(baseUrl, apiKey, effectiveFilter, p.id, opts);
  return { id: p.id, models, entry };
}

/**
 * Generate a llama-swap config.yaml from canonical model data + core settings
 * + fetched cloud provider data.  Writes JSON (valid YAML) to outputPath.
 */
function generateLlamaSwapConfig(providerOverrides, outputPath) {
  const core = JSON.parse(readFileSync(
    join(scriptDir, "..", "..", "openai-completions", "llama-swap-core.json"), "utf-8"
  ));
  const modelData = JSON.parse(readFileSync(
    join(scriptDir, "..", "..", "openai-completions", "llamacpp-model-data.json"), "utf-8"
  ));

  // Build models section from canonical model data
  const models = {};
  for (const m of modelData.models) {
    const family = modelData.modelFamilies[m.family];
    const cacheType = modelData.cacheTypes[m.cacheType];

    let cmd = modelData.baseServerArgs;
    if (family?.samplingArgs) cmd += " " + family.samplingArgs;
    if (family?.reasoningBudget) cmd += " " + family.reasoningBudget;
    if (cacheType) cmd += " " + cacheType;
    cmd += ` --fit-ctx ${m.contextWindow}`;

    // Cache-aware model args: --model when the flat file is already in
    // models-local/, else --hf-repo/--hf-file (see huggingface/models-local.mjs
    // and huggingface/docs/d017-fallback-aware-config-generation.md).
    const home = process.env.HOME || process.env.HOMEPATH || "/root";
    cmd += modelArgs({ repo: m.hf.repo, file: m.hf.file, mmproj: m.hf.mmproj, home });

    const entry = { cmd };
    if (m.capabilities) entry.capabilities = m.capabilities;
    models[m.id] = entry;
  }

  // Build peers section from fetched cloud provider data
  const peers = {};
  for (const [id, entry] of Object.entries(providerOverrides)) {
    if (id === "llamacpp") continue;
    if (!entry.models?.length) continue;
    if (entry.customAuth && entry.customAuth !== "bearer") continue;

    const proxy = entry.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    const peerEntry = { proxy, models: entry.models.map((m) => m.id) };
    if (entry.apiKey?.startsWith("$")) {
      peerEntry.apiKey = "\${env." + entry.apiKey.slice(1) + "}";
    }
    peers[id] = peerEntry;
  }

  const config = { ...core, models };
  if (Object.keys(peers).length) config.peers = peers;

  try { mkdirSync(dirname(outputPath), { recursive: true }); } catch {}
  writeFileSync(outputPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.warn(`  wrote llama-swap config to ${outputPath}`);
}

async function main() {
  const providerOverrides = {};
  const fetchTasks = [];

  for (const p of BUILDIN_PROVIDERS) {
    const baseUrl = process.env[p.baseUrlEnv] || DEFAULT_BASE_URLS[p.id];

    const entry = {
      baseUrl,
      api: p.api,
    };
    if (p.fetchAuth) entry.customAuth = p.fetchAuth;

    const apiKeyEnv = process.env[p.apiKeyEnv] !== undefined ? p.apiKeyEnv : "";
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] ?? "" : "";
    if (apiKeyEnv) entry.apiKey = "$" + apiKeyEnv;

    // Providers without a MODEL_FILTERS entry get override-only (baseUrl + optional apiKey).
    if (!(p.id in MODEL_FILTERS)) {
      providerOverrides[p.id] = entry;
      continue;
    }

    const filterFn = MODEL_FILTERS[p.id];

    // Skip fetch when missing a required API key (avoids exposing paid models without auth).
    if (p.requireApiKey && !apiKey) {
      const candidateVars = [...new Set([p.apiKeyEnv, p.apiKeyEnv.replace(/^__/, "")])];
      console.warn(
        `  warning: skipping provider "${p.id}" — requires an API key but none was found in the environment; set ${candidateVars.join(" or ")} to enable this provider`,
      );
      continue;
    }

    const opts = {};
    if (p.fetchAuth) opts.fetchAuth = p.fetchAuth;
    if (p.modelIdPrefix) opts.modelIdPrefix = p.modelIdPrefix;
    // When filterFn is undefined (pass-through), use a function that
    // keeps every model.  This lets the pricing DB still be populated.
    const effectiveFilter = filterFn ?? (() => true);

    // Wrap each provider fetch so a single network error doesn't crash
    // the entire generator.  Failed providers are silently skipped and
    // logged to stderr; successful providers still populate the config.
    fetchTasks.push(
      fetchForProvider(p, baseUrl, apiKey, effectiveFilter, opts, entry)
        .then(result => result)
        .catch(err => {
          console.warn(
            `  warning: fetch for provider "${p.id}" failed: ${err?.cause?.code || err?.message || err} — skipping`,
          );
          return null; // signal «no result»
        }),
    );
  }

  const results = (await Promise.all(fetchTasks)).filter(Boolean);

  // Include a provider only when its fetch succeeded and returned at least one model.
  for (const { id, models, entry } of results) {
    if (models.length === 0) continue;
    entry.models = models;
    providerOverrides[id] = entry;
  }

  const llamacppBaseUrl = process.env[LLAMACPP.baseUrlEnv] || process.env[LLAMACPP.baseUrlFallback];

  if (llamacppBaseUrl) {
    const llamacppApiKeyEnv = process.env[LLAMACPP.apiKeyEnv] !== undefined ? LLAMACPP.apiKeyEnv : "";
    const llamacppApiKey = llamacppApiKeyEnv ? process.env[llamacppApiKeyEnv] ?? "" : "";

    try {
      const models = await fetchLlamaCppModels(llamacppBaseUrl, llamacppApiKey);
      providerOverrides[LLAMACPP.id] = {
        baseUrl: llamacppBaseUrl.replace(/\/+$/, ""),
        api: "openai-completions",
        apiKey: llamacppApiKeyEnv ? "$" + llamacppApiKeyEnv : undefined,
        models,
      };
    } catch (err) {
      console.warn(
        `  warning: could not fetch models from llama.cpp at ${llamacppBaseUrl.trim()}/models: ${err?.cause?.code || err?.message || err} — llama-swap models will be unavailable until the server is running`,
      );
    }
  }

  if (Object.keys(providerOverrides).length === 0) {
    console.warn(
      "  warning: no provider entries generated (no env overrides and/or " +
      "model fetch failed) — output is an empty providers map",
    );
  }

  console.log(JSON.stringify({ providers: providerOverrides }, null, 2));

  // --llama-swap-config <path>: also emit a complete llama-swap config.yaml
  const lsFlag = "--llama-swap-config";
  const lsIdx = process.argv.indexOf(lsFlag);
  if (lsIdx !== -1 && lsIdx + 1 < process.argv.length) {
    generateLlamaSwapConfig(providerOverrides, process.argv[lsIdx + 1]);
  }
}

await main();
