#!/usr/bin/env node
// See README.md for usage, env vars reference, and design decisions.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Directory this script lives in — used for relative data-file and dump paths.
const scriptDir = dirname(fileURLToPath(import.meta.url));

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
function dumpRawJson(name, data) {
  const out = join(scriptDir, name);
  try {
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
  } catch {
    return;
  }
}

// A bare `fetch failed` TypeError carries no useful info on its own;
// the real reason (DNS, TLS, timeout, connection refused) lives in the
// `cause` property.  Surface it so the user isn't left guessing.
function describeError(err) {
  if (!err) return "(unknown error)";
  const e = err instanceof Error ? err : new Error(String(err));
  let msg = e.message || String(e);
  const cause = e.cause;
  if (cause) {
    const c = cause instanceof Error ? cause : { message: String(cause) };
    if (c.code) {
      msg += ` (cause: ${c.code}`;
      if (c.hostname) msg += ` ${c.hostname}`;
      if (c.port) msg += `:${c.port}`;
      if (c.message && c.message !== c.code) msg += ` — ${c.message}`;
      msg += ")";
    } else if (c.message) {
      msg += ` (cause: ${c.message})`;
    } else {
      msg += ` (cause: ${String(cause)})`;
    }
  }
  const isAbort = e.name === "AbortError" || /aborted\b/i.test(msg);
  if (isAbort || e.stack && e.stack.includes("timed out")) {
    msg += " (the request timed out)";
  }
  return msg;
}

// =====================================================================
// 1.  Env access (read from process.env, not from a .env file)
// =====================================================================

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
    // Require an API key to fetch models.  Without a key the OpenCode API
    // returns ALL models (including paid ones like gpt-5.5, claude-*, etc.)
    // and relies solely on the client-side suffix filter — too fragile.
    // With a key the server already restricts to free-tier models.
    requireApiKey: true,
  },
  {
    id: "opencode-go-sub",
    api: "openai-completions",
    baseUrlEnv: "OPENCODE_GO_BASE_URL",
    // Requires a dedicated __OPENCODE_GO_API_KEY; does not fall back to
    // OPENCODE_API_KEY.  The Go-subscription endpoint exposes paid models
    // that should only be accessible with a valid Go-tier credential.
    apiKeyEnv: "__OPENCODE_GO_API_KEY",
    // Gating is handled by the MODEL_FILTERS entry below: it keeps models
    // only while __OPENCODE_GO_API_KEY is available, so no tier/paid models
    // are exposed without a Go-tier credential.  No explicitOnly /
    // requireApiKey flags are needed (see DEFAULT_BASE_URLS for the
    // fallback endpoint).
  },
  {
    id: "google-free",
    api: "google-generative-ai",
    baseUrlEnv: "GOOGLE_BASE_URL",
    apiKeyEnv: "__GEMINI_API_KEY",
    // Google's Gemini API uses X-Goog-Api-Key, not Authorization: Bearer
    fetchAuth: "x-goog-api-key",
    // Google returns IDs with "models/" prefix ("models/gemini-2.0-flash")
    // but PI_MODEL_METADATA keys are bare ("gemini-2.0-flash").
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
    // Subscription-backed provider.  The pricing snapshot is always loaded
    // into the cross-provider pricing DB as a reference.  The actual provider
    // entry (model fetch) is gated behind __CLINE_API_KEY so that the provider
    // only appears when the user has a valid credential.
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
  "opencode-go-sub":  (_m) => process.env["__OPENCODE_GO_API_KEY"] !== undefined,
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
// llamacpp-model-data.json at project root.  That file is the single source
// of truth for model capabilities (input/output modalities, context windows)
// shared with openai-completions/config.yaml.
// Models with no matching entry in the canonical data fall back to slug-based
// ctxNNN parsing (e.g. `ctx200` → 200000) or a default of 65536.
const LLAMACPP_CTX_WINDOWS_DEFAULT = 65536;

/**
 * Load the canonical llama.cpp model data from llamacpp-model-data.json.
 * @returns {{ ctxWindows: Record<string, number>, modelCapabilities: Record<string, {capabilities: {in: string[], out: string[]}, contextWindow: number}> }}
 */
function loadLlamaCppModelData() {
  const dataPath = join(dirname(fileURLToPath(import.meta.url)), "..", "llamacpp-model-data.json");
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
const LLAMACPP_CTX_WINDOWS = LLAMACPP_MODEL_DATA.ctxWindows || {};
// Build a lookup map from the models array (keyed by id) for fast random access.
const LLAMACPP_MODEL_CAPABILITIES = Object.fromEntries(
  (LLAMACPP_MODEL_DATA.models || []).map(m => [m.id, m])
);

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
  const m = modelId.match(/-ctx(\d+)(?=[-/])/);
  if (!m) return LLAMACPP_CTX_WINDOWS_DEFAULT;
  return LLAMACPP_CTX_WINDOWS["CTX" + m[1]] ?? LLAMACPP_CTX_WINDOWS_DEFAULT;
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
    const path = join(scriptDir, name);
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
function initPricingDB() {
  const sources = [
    { name: "OpenCode Go", data: OPENCODE_GO_PRICING },
    { name: "OpenCode Zen", data: OPENCODE_ZEN_PRICING },
  ];
  for (const { name, data } of sources) {
    for (const [bareId, cost] of Object.entries(data)) {
      // Only add entries with meaningful (non-zero) costs
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
}

// Initialize the pricing DB from the static snapshots at module load.
initPricingDB();

/**
 * Fetch the OpenCode Zen /models endpoint without authentication to obtain
 * real-time per-token pricing for all models (including paid ones).
 * Stores the result in ZEN_LIVE_PRICING (modelId → cost map, or null).
 */
async function fetchZenPricing(baseUrl) {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch {
    ZEN_LIVE_PRICING = null;
    return;
  }
  if (!res.ok) { ZEN_LIVE_PRICING = null; return; }
  let body;
  try { body = await res.json(); } catch { ZEN_LIVE_PRICING = null; return; }
  const data = body.data || body.models || body;
  if (!Array.isArray(data)) { ZEN_LIVE_PRICING = null; return; }
  const map = {};
  for (const m of data) {
    const cost = m.cost;
    if (cost && (Number(cost.output) > 0 || Number(cost.input) > 0)) {
      map[m.id] = {
        input: Number(cost.input) || 0,
        output: Number(cost.output) || 0,
        cacheRead: Number(cost.cache_read) || 0,
        cacheWrite: Number(cost.cache_write) || 0,
      };
    }
    const pr = m.pricing;
    if (pr && (Number(pr.completion ?? pr.output) > 0)) {
      map[m.id] = {
        input: (Number(pr.prompt ?? pr.input) || 0) * 1e6,
        output: (Number(pr.completion ?? pr.output) || 0) * 1e6,
        cacheRead: (Number(pr.cache_read ?? pr.input_cache_read) || 0) * 1e6,
        cacheWrite: (Number(pr.cache_write ?? pr.input_cache_write) || 0) * 1e6,
      };
    }
  }
  ZEN_LIVE_PRICING = Object.keys(map).length > 0 ? map : null;
}

function loadPiModelMetadata() {
  try {
    const path = join(scriptDir, "pi-model-metadata.json");
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

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// Split "tencent/hy3:free" into base (tencent/hy3) and variant (free).
// Key the capability estimate on the base so free/paid siblings get equal cost.
function parseModelVariant(modelId) {
  const [base, ...rest] = modelId.split(":");
  const variant = rest.join(":").toLowerCase();
  return {
    base,
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
    input: round4(input),
    output: round4(output),
    cacheRead: round4(input * VIRTUAL_COST.cacheReadRatio),
    cacheWrite: round4(input * VIRTUAL_COST.cacheWriteRatio),
  };
}

// Providers express token costs differently:
//   OpenRouter:               per-token USD  (×1e6 → pi's per-million convention)
//   Together/DeepInfra/CrofAI: per-million USD (already in pi's units, ×1)
// Default multiplier is 1e6 (OpenRouter convention).
const PROVIDER_PRICING_MULTIPLIER = {
  // Per-token (OpenRouter style) — multiply by 1e6
  "openrouter-free":   1e6,
  //"fastrouter":        1e6,
  // Unknown / no pricing — default to 1 (no-op)
};

function getPricingMultiplier(providerId) {
  if (providerId in PROVIDER_PRICING_MULTIPLIER) {
    return PROVIDER_PRICING_MULTIPLIER[providerId];
  }
  // Default to 1e6 (per-token) — safer over-estimate than under-estimate.
  return 1e6;
}

/**
 * Extract real (non-virtual, non-zero) cost from a raw model object.
 * Returns null if no real pricing is available (zero, sentinel, or absent).
 *
 * Handles the same shapes as resolveCost:
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
      input: round4(Number(cost.input) || 0),
      output: round4(Number(cost.output) || 0),
      cacheRead: round4(Number(cost.cache_read) || 0),
      cacheWrite: round4(Number(cost.cache_write) || 0),
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
        input: round4(inTok * multiplier),
        output: round4(outTok * multiplier),
        cacheRead: round4(cr * multiplier),
        cacheWrite: round4(cw * multiplier),
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

// Extract variant suffix (:free/:nitro/...), or 'standard' if absent.
function parseVariant(modelId) {
  const m = modelId.match(/:([a-z]+)$/i);
  if (!m) return "standard";
  const variant = m[1].toLowerCase();
  if (["free", "nitro", "throughput", "online", "thinking"].includes(variant)) {
    return variant;
  }
  return "standard";
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

// Simpler cost resolver for use outside fetchProviderModels (no PRICING_DB lookup).
/**
 * @param {string}  modelId
 * @param {object}  [raw={}]
 * @param {number}  [multiplier=1e6]
 */
function resolveCost(modelId, raw = {}, multiplier = 1e6) {
  const real = extractRealCost(modelId, raw, multiplier);
  if (real) return real;
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

  return data.map((m) => {
    const canonical = LLAMACPP_MODEL_CAPABILITIES[m.id];
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

  let headers;
  if (apiKey) {
    switch (fetchAuth) {
      case "x-goog-api-key":
        headers = { "X-Goog-Api-Key": apiKey };
        break;
      case "none":
        headers = undefined;
        break;
      default:
        headers = { Authorization: `Bearer ${apiKey}` };
    }
  }

  // Try {baseUrl}/models; if 404 and no /v1 prefix, retry with /v1/models.
  let url = baseUrl.replace(/\/+$/, "") + "/models";

  let res = await fetchWithTimeout(url, { headers });

  if (res.status === 404 && !url.endsWith("/v1/models")) {
    url = baseUrl.replace(/\/+$/, "") + "/v1/models";
    res = await fetchWithTimeout(url, { headers });
  }

  if (!res.ok) {
    // The response body often contains the real reason (quota, invalid key)
    // that the status line alone doesn't convey.
    let detail = "";
    try {
      const errBody = await res.text();
      if (errBody && errBody.length > 0 && errBody.length < 500) {
        try {
          const parsed = JSON.parse(errBody);
          const msg = parsed?.error?.message || parsed?.message || errBody;
          if (msg && typeof msg === "string" && msg.length < 200) {
            detail = `: ${msg}`;
          }
        } catch {
          if (errBody.length < 200) detail = `: ${errBody}`;
        }
      }
    } catch {
    }
    throw new Error(
      `GET ${url} returned ${res.status} ${res.statusText}${detail}` +
      (apiKey ? "" : " (no API key provided)") +
      (fetchAuth !== "bearer" ? ` (auth: ${fetchAuth})` : "")
    );
  }

  const body = await res.json();
  const data = body.data || body.models || body; // handle { data: [...] }, { models: [...] }, and bare arrays

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`GET ${url} returned no models`);
  }

  dumpRawJson(`${providerId}-raw-models.json`, data);

  // Build cross-provider pricing DB from ALL (unfiltered) models
  // so free / local models inherit cost from their paid siblings.
  const priceMult = getPricingMultiplier(providerId);
    for (const m of data) {
    const rawId = m.id;
    if (!rawId) continue;
    const cleanIdForDb = modelIdPrefix && typeof rawId === "string" && rawId.startsWith(modelIdPrefix)
      ? rawId.slice(modelIdPrefix.length)
      : rawId;
    const real = extractRealCost(cleanIdForDb, m, priceMult);
    if (real) {
      const key = normalizeModelId(cleanIdForDb);
      if (!PRICING_DB.has(key)) PRICING_DB.set(key, []);
      PRICING_DB.get(key).push({
        input: real.input,
        output: real.output,
        cacheRead: real.cacheRead,
        cacheWrite: real.cacheWrite,
        variant: parseVariant(cleanIdForDb),
        source: providerId,
      });
    }
  }

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
      maxTokens: m.max_tokens ?? 65536,
      cost: resolveCostWithDB(cleanId, m, PRICING_DB, priceMult),
    };
    // Mirror pi's per-model compat/thinkingFormat/reasoning settings
    // from pi-model-metadata.json (the /models endpoint never returns these).
    const metadataProviderId = METADATA_PROVIDER_MAP[providerId] || providerId;
    const meta = PI_MODEL_METADATA[metadataProviderId]?.[cleanId];
    if (meta) {
      if (meta.compat !== undefined && model.compat === undefined) model.compat = meta.compat;
      if (meta.thinkingFormat !== undefined && model.thinkingFormat === undefined) model.thinkingFormat = meta.thinkingFormat;
      if (meta.reasoning !== undefined && model.reasoning === undefined) model.reasoning = meta.reasoning;
      if (meta.thinkingLevelMap !== undefined && model.thinkingLevelMap === undefined) model.thinkingLevelMap = meta.thinkingLevelMap;
    }

    if (providerId === "opencode-go-sub") {
      // Cost priority: 1) fresh Zen API, 2) fresh Go API, 3) stale Go docs, 4) stale Zen docs, 5) virtual fallback
      if (ZEN_LIVE_PRICING) {
        const zc = lookupCost(ZEN_LIVE_PRICING, cleanId);
        if (zc) { model.cost = zc; return model; }
      }

      const rawCost = m.cost;
      const rawPricing = m.pricing;
      if ((rawCost && (Number(rawCost.output) > 0 || Number(rawCost.input) > 0)) ||
          (rawPricing && (Number(rawPricing.completion ?? rawPricing.output) > 0 ||
                          Number(rawPricing.prompt ?? rawPricing.input) > 0))) {
        return model;
      }

      const go = lookupCost(OPENCODE_GO_PRICING, cleanId);
      if (go) { model.cost = go; return model; }

      const zen = lookupCost(OPENCODE_ZEN_PRICING, cleanId);
      if (zen) { model.cost = zen; return model; }
    }

    if (providerId === "clinepass") {
      // Subscription-backed models report zero from the live API;
      // prefer the documented reference pricing over the virtual heuristic.
      const cp = lookupCost(CLINEPASS_PRICING, cleanId);
      if (cp) { model.cost = cp; return model; }
    }

    return model;
  });
}

// =====================================================================
// 5.  Main
// =====================================================================

async function main() {
  const providerOverrides = {};
  const fetchTasks = [];

  for (const p of BUILDIN_PROVIDERS) {
    const customBaseUrl = process.env[p.baseUrlEnv] ?? "";
    const baseUrl = customBaseUrl || DEFAULT_BASE_URLS[p.id];

    const entry = {};
    entry.baseUrl = customBaseUrl || DEFAULT_BASE_URLS[p.id];
    entry.api = p.api;

    const apiKeyEnv = process.env[p.apiKeyEnv] !== undefined ? p.apiKeyEnv : "";
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] ?? "" : "";
    if (apiKeyEnv) {
      entry.apiKey = "$" + apiKeyEnv;
    }

    // Providers without a MODEL_FILTERS entry get override-only (baseUrl + optional apiKey).
    if (!(p.id in MODEL_FILTERS)) {
      providerOverrides[p.id] = entry;
      continue;
    }

    const filterFn = MODEL_FILTERS[p.id];

    // Skip fetch when missing a required API key (avoids exposing paid models without auth).
    if (p.requireApiKey && !apiKey) {
      const candidateVars = [p.apiKeyEnv, p.apiKeyEnv.replace(/^__/, "")]
        .filter((v, i, a) => a.indexOf(v) === i);
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

    // opencode-go-sub needs Zen pricing fetched first (before its own model fetch)
    // for correct cost resolution priority.
    fetchTasks.push(
      (async () => {
        if (p.id === "opencode-go-sub") {
          const zenBaseUrl = process.env["OPENCODE_ZEN_BASE_URL"] || DEFAULT_BASE_URLS["opencode-zen-free"];
          if (zenBaseUrl) {
            await fetchZenPricing(zenBaseUrl);
          }
        }

        const models = await fetchProviderModels(baseUrl, apiKey, effectiveFilter, p.id, opts);
        return { id: p.id, models, entry };
      })(),
    );
  }

  const results = await Promise.all(fetchTasks);

  // Include a provider only when its fetch succeeded and returned at least one model.
  for (const { id, models, entry } of results) {
    if (models.length === 0) continue;
    entry.models = models;
    providerOverrides[id] = entry;
  }

  const mergedProviders = { ...providerOverrides };

  const llamacppBaseUrl = process.env[LLAMACPP.baseUrlEnv] || process.env[LLAMACPP.baseUrlFallback];

  if (llamacppBaseUrl) {
    const llamacppApiKeyEnv = process.env[LLAMACPP.apiKeyEnv] !== undefined ? LLAMACPP.apiKeyEnv : "";
    const llamacppApiKey = llamacppApiKeyEnv ? process.env[llamacppApiKeyEnv] ?? "" : "";

    try {
      const models = await fetchLlamaCppModels(llamacppBaseUrl, llamacppApiKey);
      mergedProviders[LLAMACPP.id] = {
        baseUrl: llamacppBaseUrl.replace(/\/+$/, ""),
        api: "openai-completions",
        apiKey: llamacppApiKeyEnv ? "$" + llamacppApiKeyEnv : undefined,
        models,
      };
    } catch (err) {
      console.warn(
        `  warning: could not fetch models from llama.cpp at ${llamacppBaseUrl.trim()}/models: ${describeError(err)} — llama-swap models will be unavailable until the server is running`,
      );
    }
  }

  if (Object.keys(mergedProviders).length === 0) {
    console.warn(
      "  warning: no provider entries generated (no env overrides and/or " +
      "model fetch failed) — output is an empty providers map",
    );
  }

  console.log(JSON.stringify({ providers: mergedProviders }, null, 2));
}

await main();
