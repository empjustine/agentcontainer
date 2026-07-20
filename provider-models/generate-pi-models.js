#!/usr/bin/env node
/**
 * generate-pi-models.js
 *
 * Generates a models.json document (printed to stdout) with provider
 * overrides sourced from the process environment (process.env)
 *
 * Also dumps raw (unfiltered) /models responses as intermediate JSON
 * snapshots into the same directory this script lives in
 * (provider-models/<providerId>-raw-models.json).
 *
 * ── What it does ────────────────────────────────────────────────────
 *
 *   • Reads provider overrides from the process environment (e.g. shell
 *     variables exported before running the script), NOT from a .env file.
 *     Every built-in provider falls back to its standard public endpoint when
 *     its *_BASE_URL var is absent, so no env vars are required.
 *   • For each known provider, prefers a *_BASE_URL override from the
 *     environment; otherwise writes a provider entry with no baseUrl and lets
 *     pi use its default endpoint.  A custom baseUrl is baked as a literal URL.
 *   • If a corresponding __*_API_KEY is present in the environment (falling
 *     back to the plain *_API_KEY when it's missing), writes it as an apiKey
 *     reference ("$VAR") that pi resolves at runtime.
 *   • For providers with a registered MODEL_FILTERS entry, fetches
 *     the /models endpoint and applies a client-side filter so only
 *     the desired models appear (e.g. :free for OpenRouter,
 *     Devstral-only for Mistral).
 *   • If LLAMACPP_BASE_URL + __LLAMACPP_API_KEY are present, fetches
 *     the /models endpoint and generates a full llamacpp provider
 *     with real context windows derived from the `ctxNNN` slug macro
 *     baked into each model ID (see LLAMACPP_CTX_WINDOWS + the
 *     resolveLlamaCppContextWindow helper).
 *   • Prints the generated document (a models.json object) to stdout.
 *     Redirect stdout to a file to persist it; warnings and errors go to
 *     stderr so they never pollute the JSON output.
 *
 * ── Usage ───────────────────────────────────────────────────────────
 *
 *   node generate-pi-models.js                 # print models.json to stdout
 *   node generate-pi-models.js > models.json   # redirect to a file
 *
 * The script prints the generated models.json to stdout.  Redirect stdout
 * to a file (e.g. ~/.pi/agent/models.json) if you want it written.  Warnings
 * and errors are printed to stderr and never pollute the JSON output.
 *
 * Provider overrides come from the environment, e.g.:
 *   export OPENROUTER_BASE_URL=https://my-proxy.example.com/v1
 *   export __OPENROUTER_API_KEY=sk-or-v2-...
 *   export LLAMACPP_BASE_URL=http://127.0.0.1:8080/v1
 *   export __LLAMACPP_API_KEY=sk-...
 *
 * ── Environment variables ──────────────────────────────────────────
 *
 *   # ---- proxy URL overrides for built-in providers ----
 *   OPENROUTER_BASE_URL=https://my-proxy.example.com/v1
 *   __OPENROUTER_API_KEY=sk-or-v2-...           # optional, pi resolves at runtime
 *
 *   OPENCODE_ZEN_BASE_URL=https://opencode.ai/zen
 *   __OPENCODE_ZEN_API_KEY=sk-opencode-...       # optional
 *
 *   OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go
 *   __OPENCODE_GO_API_KEY=sk-opencode-...    # required to enable opencode-go-sub
 *
 *   # ---- llama.cpp / llama-swap ----
 *   LLAMACPP_BASE_URL=http://127.0.0.1:8080/v1     # or LLAMA_API_BASE_URL
 *   __LLAMACPP_API_KEY=sk-...                       # or LLAMACPP_API_KEY
 *
 *   # ---- google / gemini ----
 *   GOOGLE_BASE_URL=https://generativelanguage.googleapis.com/v1beta
 *   __GEMINI_API_KEY=AIza...            # falls back to GEMINI_API_KEY
 *
 *   # ---- mistral ----
 *   MISTRAL_BASE_URL=https://api.mistral.ai/v1
 *   __MISTRAL_API_KEY=sk-...
 *
 *   Set these in your shell (export ...) before running this script.
 *
 * ── Notes ───────────────────────────────────────────────────────────
 *
 *   • __-prefixed API key vars avoid collision with pi's standard
 *     auto-detection (pi looks for OPENROUTER_API_KEY, not
 *     __OPENROUTER_API_KEY).
 *     opencode-go-sub uses a dedicated __OPENCODE_GO_API_KEY (no fallback
 *     to OPENCODE_API_KEY).  The subscription-tier endpoint is only enabled
 *     when that key is present — its model filter drops every model
 *     otherwise, so no tier/paid models are exposed without a credential.
 *   • baseUrl is baked as a literal (models.json doesn't support $VAR
 *     interpolation for baseUrl, only for apiKey/headers).
 *   • llama.cpp models are fetched live from the /models endpoint at
 *     generation time. Re-run when the model lineup changes.
 *   • pi-model-metadata.json mirrors pi's per-model compat / thinkingFormat /
 *     reasoning / thinkingLevelMap (the /models API doesn't return these);
 *     generated models inherit them so they match pi's built-in catalog.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Directory this script lives in — used for relative data-file and dump paths.
const scriptDir = dirname(fileURLToPath(import.meta.url));

/**
 * Dump raw data as a pretty-printed JSON snapshot to the script directory.
 * Used to preserve unfiltered API responses for offline inspection.
 */
function dumpRawJson(name, data) {
  const out = join(scriptDir, name);
  try {
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
  } catch {
    // Dumps are for offline inspection only — a read-only script directory
    // (e.g. when mounted via podman/docker with :ro) should not abort the
    // provider fetch.  Silently skip on EROFS / EACCES.
    return;
  }
}

/**
 * Build a detailed, human-readable description of an error, including the
 * underlying `cause` when present.
 *
 * A bare `fetch failed` TypeError carries almost no useful information on its
 * own — the real reason (DNS failure, TLS error, connection refused, timeout,
 * etc.) lives in its `cause` property.  This helper surfaces that so the user
 * isn't left guessing why a provider fetch failed.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (!err) return "(unknown error)";
  const e = err instanceof Error ? err : new Error(String(err));
  let msg = e.message || String(e);
  const cause = e.cause;
  if (cause) {
    const c = cause instanceof Error ? cause : { message: String(cause) };
    if (c.code) {
      // Node network errors expose a `code` (ENOTFOUND, ECONNREFUSED, ...)
      // plus optional `hostname`/`port` for DNS/connection failures.
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
  if (e.stack && e.stack.includes("timed out")) {
    msg += " (the request timed out)";
  }
  return msg;
}

// =====================================================================
// 1.  Env access (read from process.env, not from a .env file)
// =====================================================================

/**
 * Resolve which api-key env var name to reference for a provider.
 *
 * Prefers the __-prefixed var (e.g. __OPENROUTER_API_KEY) so it doesn't
 * collide with pi's standard auto-detection, but falls back to the plain
 * standard name (e.g. OPENROUTER_API_KEY) when the __-prefixed one is
 * absent.  Returns the chosen name (resolved by pi at runtime) or ""
 * when neither is set.
 */
function resolveApiKeyEnv(prefixed) {
  const standard = prefixed.replace(/^__/, "");
  if (process.env[prefixed] != null) return prefixed;
  if (process.env[standard] != null) return standard;
  return "";
}

// =====================================================================
// 2.  Provider definitions
// =====================================================================

/**
 * Built-in providers that get a baseUrl/apiKey override.
 *
 * For each provider:
 *   - baseUrlEnv: env-var name in the .env file whose value becomes the
 *     literal baseUrl in models.json.
 *   - apiKeyEnv:  (optional) env-var name for the API key. If present in the
 *     .env file, the script writes "apiKey": "$<apiKeyEnv>" so pi resolves
 *     it from the runtime environment at startup.
 *
 * Add more entries to extend to other providers.
 */
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
  // ---- pi-free unique providers (not built into pi) ----
  ///{
  ///  id: "kilo-sub",
  ///  api: "openai-completions",
  ///  // Kilo AI subscription gateway (OpenRouter-compatible).
  ///  // All models are subscription-backed; gated behind __KILO_API_KEY.
  ///  baseUrlEnv: "KILO_BASE_URL",
  ///  apiKeyEnv: "__KILO_API_KEY",
  ///  requireApiKey: true,
  ///},
  ///{
  ///  id: "zenmux",
  ///  api: "openai-completions",
  ///  baseUrlEnv: "ZENMUX_BASE_URL",
  ///  apiKeyEnv: "__ZENMUX_API_KEY",
  ///  requireApiKey: true,
  ///},
  ///{
  ///  id: "crofai",
  ///  api: "openai-completions",
  ///  baseUrlEnv: "CROFAI_BASE_URL",
  ///  apiKeyEnv: "__CROFAI_API_KEY",
  ///  requireApiKey: true,
  ///},
  ///{
  ///  id: "llm7",
  ///  api: "openai-completions",
  ///  baseUrlEnv: "LLM7_BASE_URL",
  ///  apiKeyEnv: "__LLM7_API_KEY",
  ///  requireApiKey: true,
  ///},
  ///{
  ///  id: "deepinfra",
  ///  api: "openai-completions",
  ///  // DeepInfra trial-credit provider.  $5 one-time credit; per-token pricing.
  ///  // Pricing is per-MILLION tokens; the API returns pricing in metadata.
  ///  baseUrlEnv: "DEEPINFRA_BASE_URL",
  ///  apiKeyEnv: "__DEEPINFRA_TOKEN",
  ///  requireApiKey: true,
  ///},
  ///{
  ///  id: "sambanova",
  ///  api: "openai-completions",
  ///  // SambaNova Cloud — freemium provider.  All models are free with rate limits.
  ///  // Uses OpenAI-compatible /v1/models endpoint with extended pricing fields.
  ///  baseUrlEnv: "SAMBANOVA_BASE_URL",
  ///  apiKeyEnv: "__SAMBANOVA_API_KEY",
  ///  requireApiKey: true,
  ///},
  ///{
  ///  id: "together",
  ///  api: "openai-completions",
  ///  // Together AI — $1 trial credit, then pay-per-token.
  ///  // /v1/models returns a plain array (not { data: [...] }).
  ///  // Pricing is per-MILLION tokens.
  ///  baseUrlEnv: "TOGETHER_BASE_URL",
  ///  apiKeyEnv: "__TOGETHER_AI_API_KEY",
  ///  requireApiKey: true,
  ///},
  ///{
  ///  id: "novita",
  ///  api: "openai-completions",
  ///  baseUrlEnv: "NOVITA_BASE_URL",
  ///  apiKeyEnv: "__NOVITA_API_KEY",
  ///  requireApiKey: true,
  ///},
  {
    id: "routeway",
    api: "openai-completions",
    // Routeway AI — mix of free (:free suffix) and paid models.
    // Exposes pricing in /v1/models response.
    baseUrlEnv: "ROUTEWAY_BASE_URL",
    apiKeyEnv: "__ROUTEWAY_API_KEY",
    requireApiKey: true,
  },
  ///{
  ///  id: "tokenrouter",
  ///  api: "openai-completions",
  ///  // TokenRouter — multi-model gateway.  No pricing exposed via /v1/models.
  ///  // Free models are identified by `:free` name suffix.
  ///  baseUrlEnv: "TOKENROUTER_BASE_URL",
  ///  apiKeyEnv: "__TOKENROUTER_API_KEY",
  ///  requireApiKey: true,
  ///},
  ///{
  ///  id: "anyapi",
  ///  api: "openai-completions",
  ///  // AnyAPI — gateway with free plan and explicit free model catalog.
  ///  // Exposes pricing and isFree flags in /v1/models response.
  ///  baseUrlEnv: "ANYAPI_BASE_URL",
  ///  apiKeyEnv: "__ANYAPI_API_KEY",
  ///  requireApiKey: true,
  ///},
  {
    id: "ollama-cloud",
    api: "openai-completions",
    // Ollama Cloud — freemium OpenAI-compatible endpoint.
    // Free tier with rate limits; all models are free.
    baseUrlEnv: "OLLAMA_CLOUD_BASE_URL",
    apiKeyEnv: "__OLLAMA_API_KEY",
    requireApiKey: true,
  },
  // ---- dynamic built-in providers (built into pi, fetchable via /models) ----
  {
    id: "fastrouter",
    api: "openai-completions",
    // FastRouter — free OpenRouter-compatible routing service.
    // Always discovered (no auth required for model listing).
    baseUrlEnv: "FASTROUTER_BASE_URL",
    apiKeyEnv: "__FASTROUTER_API_KEY",
  },
];

/**
 * Default public endpoint for each built-in provider.
 *
 * Used as a fallback when the corresponding *_BASE_URL override is missing
 * from the env file.  This lets the script run with no env vars at all —
 * it simply targets the provider's standard endpoint instead of a proxy.
 */
const DEFAULT_BASE_URLS = {
  "openrouter-free":   "https://openrouter.ai/api/v1",
  "opencode-zen-free": "https://opencode.ai/zen/v1",
  "opencode-go-sub":   "https://opencode.ai/zen/go/v1",
  "google-free":       "https://generativelanguage.googleapis.com/v1beta",
  "mistral-free":      "https://api.mistral.ai/v1",
  "clinepass":          "https://api.cline.bot/v1",
  // pi-free unique providers
  "kilo-sub":          "https://api.kilo.ai/api/gateway",
  "zenmux":            "https://zenmux.ai/api/v1",
  "crofai":            "https://crof.ai/v1",
  "llm7":              "https://api.llm7.io/v1",
  "deepinfra":         "https://api.deepinfra.com/v1/openai",
  "sambanova":         "https://api.sambanova.ai/v1",
  "together":          "https://api.together.xyz/v1",
  "novita":            "https://api.novita.ai/openai/v1",
  "routeway":          "https://api.routeway.ai/v1",
  "tokenrouter":       "https://api.tokenrouter.com/v1",
  "anyapi":            "https://api.anyapi.ai/v1",
  "ollama-cloud":      "https://ollama.com/v1",
  // dynamic built-in providers
  "fastrouter":        "https://api.fastrouter.ai/api/v1",
};

/**
 * llama.cpp / llama-swap provider.
 *
 * Unlike built-in providers, llama.cpp has no hardcoded model list — we
 * fetch it from the running instance.
 */
const LLAMACPP = {
  id: "llamacpp",
  baseUrlEnv: "LLAMACPP_BASE_URL",
  baseUrlFallback: "LLAMA_API_BASE_URL",
  apiKeyEnv: "__LLAMACPP_API_KEY",
};

/**
 * Model-ID filters for remote providers.
 *
 * Each filter receives the raw model object from the provider's /models
 * endpoint and returns true to keep it or false to skip it.
 *
 * If a provider has no filter registered, the script falls back to the
 * override-only approach (baseUrl + apiKey, no model list), which lets
 * pi use its built-in model list routed through the proxy.
 */
const MODEL_FILTERS = {
  "openrouter-free":   (m) => m.id.endsWith(":free"),
  "opencode-zen-free": (m) => m.id.endsWith("-free"),
  // Keep all models, but only while __OPENCODE_GO_API_KEY is available.
  // With the key absent the filter drops every model, so this provider is
  // effectively disabled and no tier/paid models are exposed.
  "opencode-go-sub":  (_m) => resolveApiKeyEnv("__OPENCODE_GO_API_KEY") !== "",
  "mistral-free":      (m) => {
    const id = m.id.toLowerCase();
    return id.includes("devstral") || id.includes("devstral-small");
  },
  "clinepass":         (_m) => resolveApiKeyEnv("__CLINE_API_KEY") !== "",
  "google-free":       (m) => {
    const id = (m.id || "").replace(/^models\//, "").toLowerCase();
    // Gemma 4 (always free)
    if (id.includes("gemma-4")) return true;
    // Gemini Flash models (free tier) — exclude pro/enterprise and previews
    if (id.includes("flash") && !id.includes("pro") && !id.includes("preview")) return true;
    return false;
  },
  // ---- pi-free unique providers ----
  // Kilo: subscription-backed, all models accessible with key
  "kilo-sub":          (_m) => resolveApiKeyEnv("__KILO_API_KEY") !== "",
  // ZenMux: keep all models (pricing in API response determines free/paid)
  "zenmux":            undefined,
  // CrofAI: keep all models (per-million pricing in API response)
  "crofai":            undefined,
  // LLM7: keep all models
  "llm7":              undefined,
  // DeepInfra: keep all models ($5 trial credit, per-token pricing)
  "deepinfra":         undefined,
  // SambaNova: freemium, all models free with rate limits
  "sambanova":         undefined,
  // Together AI: keep all models ($1 trial, per-million pricing)
  "together":          undefined,
  // Novita: keep all models
  "novita":            undefined,
  // Routeway: free models have :free suffix or zero pricing
  "routeway":          undefined,
  // TokenRouter: no pricing exposed; free by :free suffix
  "tokenrouter":       undefined,
  // AnyAPI: exposes isFree flag and pricing
  "anyapi":            undefined,
  // Ollama Cloud: freemium, all models free
  "ollama-cloud":      undefined,
  // ---- dynamic built-in providers ----
  // FastRouter: keep all models (OpenRouter-compatible with pricing)
  "fastrouter":        undefined,
};

/**
 * Context-window lookup keyed by the `ctxNNN` slug macro.
 *
 * The canonical `--fit-ctx` numbers are defined by the `ctxNNN` macros in
 * openai-completions/config.yaml (the llama-swap config that actually
 * serves these models).  Each llama-swap model ID embeds which macro was
 * used (e.g. `a03b-q4-k80v80-ctx200-byteshape/Qwen3.6-35B-A3B`), so instead
 * of maintaining a per-model-ID table we parse that `ctxNNN` component out
 * of the slug and look it up here.
 *
 * At generation time loadLlamaCppCtxWindows() reads those macros straight
 * out of the YAML so this script has a single source of truth.  The
 * LLAMACPP_CTX_WINDOWS_FALLBACK map below is only used when that file is
 * missing/unreadable — its values are kept in sync with the YAML `ctxNNN`
 * macros (verified).  Adding a model that uses any of these macros (e.g.
 * `ctx100`) gets the right context window automatically, no table edit.
 */
const LLAMACPP_CTX_WINDOWS_FALLBACK = {
  ctx064: 65536,
  ctx100: 100000,
  ctx128: 131072,
  ctx200: 200000,
  ctx256: 262144,
};

/**
 * Fallback context window for models whose slug has no `ctxNNN` macro.
 */
const LLAMACPP_CTX_WINDOWS_DEFAULT = 65536;

/**
 * Load the `ctxNNN` → `--fit-ctx` map from the llama-swap config file.
 *
 * The canonical context windows are stored as JSON in
 * openai-completions/config.yaml under `macros.*`.  Macros whose key
 * matches `ctxNNN` (e.g. `"ctx256": "--fit-ctx 262144"`) are extracted
 * so the script shares one source of truth with the running llama-swap
 * server.  If the file is missing or can't be parsed, we fall back to
 * LLAMACPP_CTX_WINDOWS_FALLBACK.
 *
 * @returns {Record<string, number>}  Map of `ctxNNN` → token count.
 */
function loadLlamaCppCtxWindows() {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "openai-completions", "config.yaml");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const macros = config.macros || {};
    const map = {};
    for (const [key, value] of Object.entries(macros)) {
      const m = key.match(/^ctx(\d+)$/);
      if (m) {
        // Extract the --fit-ctx number from the macro value
        const num = value.match(/--fit-ctx\s+(\d+)/);
        if (num) map[key] = Number(num[1]);
      }
    }
    if (Object.keys(map).length > 0) return map;
    console.warn(
      "  note: no ctxNNN macros found in openai-completions/config.yaml — " +
      "using built-in fallback ctx windows",
    );
  } catch {
    console.warn(
      "  note: openai-completions/config.yaml not found or invalid — using built-in " +
      "fallback ctx windows",
    );
  }
  return { ...LLAMACPP_CTX_WINDOWS_FALLBACK };
}

// Parsed once at module load; mirrors the llama-swap config macros.
const LLAMACPP_CTX_WINDOWS = loadLlamaCppCtxWindows();

/**
 * Resolve a llama-swap model's context window from its ID slug.
 *
 * The slug embeds the `ctxNNN` macro used in the llama-swap config (e.g.
 * `a03b-q4-k80v80-ctx200-byteshape/Qwen3.6-35B-A3B` → ctx200 → 200000).
 * We extract that component and map it to the matching `--fit-ctx` value
 * from LLAMACPP_CTX_WINDOWS.  Models with no `ctxNNN` component fall back
 * to LLAMACPP_CTX_WINDOWS_DEFAULT.
 *
 * @param {string} modelId  Model ID as returned by llama-swap's /models.
 * @returns {number}        Context window in tokens.
 */
function resolveLlamaCppContextWindow(modelId) {
  const m = modelId.match(/-ctx(\d+)(?=[-/])/);
  if (!m) return LLAMACPP_CTX_WINDOWS_DEFAULT;
  return LLAMACPP_CTX_WINDOWS["ctx" + m[1]] ?? LLAMACPP_CTX_WINDOWS_DEFAULT;
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
  // pi-free unique providers map to metadata-less keys; metadata lookup
  // just returns undefined which is fine (no compat/reasoning overrides).
  "kilo-sub":          "kilo",
  "zenmux":            "zenmux",
  "crofai":            "crofai",
  "llm7":              "llm7",
  "deepinfra":         "deepinfra",
  "sambanova":         "sambanova",
  "together":          "together",
  "novita":            "novita",
  "routeway":          "routeway",
  "tokenrouter":       "tokenrouter",
  "anyapi":            "anyapi",
  "ollama-cloud":      "ollama",
  "fastrouter":        "fastrouter",
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
    res = await fetch(url);
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

/**
 * Resolve a model's cost for pi's `cost.*` schema (USD per 1M tokens).
 *
 * Strategy:
 *   • If the provider exposes real per-token pricing (OpenRouter's
 *     `pricing` field) and it is non-zero, use it verbatim.  This is the
 *     most accurate signal for paid models.
 *   • Otherwise (the common case for `*:free` models, whose `pricing` is 0,
 *     or providers that return no pricing) estimate a *virtual* cost from
 *     the model's identity.  The estimate is designed so that:
 *       - a free variant and its paid sibling share the same intrinsic
 *         cost (freeness is a billing artifact, not a capability difference),
 *       - premium variants (:nitro) cost more,
 *       - throughput-optimized variants cost less, and
 *       - models are NOT all collapsed onto the price floor (0).
 *
 * All tunable constants live in VIRTUAL_COST so the heuristic is easy to
 * adjust.  Values are in the same units pi uses (USD per 1M tokens).
 */

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

/**
 * Split an OpenRouter-style model id into its base name and variant flags.
 *
 * IDs look like "tencent/hy3:free", "anthropic/claude-3.5-sonnet:nitro",
 * "openai/gpt-4o:throughput".  Everything before the first ":" is the base
 * model; the suffix is the variant.  We key the capability estimate on the
 * base so free and paid siblings get equal intrinsic cost.
 */
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

/**
 * Estimate a model's parameter count (billions) from its id, or 0 if none
 * is parseable.  Matches e.g. "Qwen3.6-35B-A3B" (35), "llama-3.1-8b" (8),
 * "gpt-oss-120m" (0.12).  MoE ids with two sizes use the total (first) size.
 */
function estimateParamBillions(modelId) {
  const m = modelId.match(/(\d+(?:\.\d+)?)\s*([bm])/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2].toLowerCase() === "m") n /= 1000; // millions → billions
  return n;
}

/**
 * Estimate a virtual cost (USD per 1M tokens) from the model id.
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

/**
 * Per-provider pricing scale for the `pricing` field in /models responses.
 *
 * Providers differ in how they express token costs:
 *   • OpenRouter style:  per-token USD (e.g. 0.00000015) — multiply by 1e6
 *     to get pi's per-million-unit convention.
 *   • Together / DeepInfra / CrofAI style:  per-million USD (e.g. 0.30)
 *     — already in pi's units, no multiplication needed.
 *
 * Default (provider not listed): multiply by 1e6 (OpenRouter convention).
 * For per-million providers, set to 1.
 */
const PROVIDER_PRICING_MULTIPLIER = {
  // Per-token (OpenRouter style) — multiply by 1e6
  "openrouter-free":   1e6,
  "fastrouter":        1e6,
  "kilo-sub":          1e6,
  "anyapi":            1e6,
  "routeway":          1e6,
  // Per-million (already in pi's units) — multiply by 1
  "together":          1,
  "deepinfra":         1,
  "crofai":            1,
  "novita":            1,
  "sambanova":         1,
  // Unknown / no pricing — default to 1 (no-op)
};

/**
 * Look up the pricing multiplier for a given provider.
 * Defaults to 1e6 (OpenRouter convention) if not explicitly listed.
 */
function getPricingMultiplier(providerId) {
  if (providerId in PROVIDER_PRICING_MULTIPLIER) {
    return PROVIDER_PRICING_MULTIPLIER[providerId];
  }
  // For built-in providers with no explicit entry, assume per-token
  // pricing (the safer over-estimate rather than under-estimate).
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

/**
 * Normalize a model ID to a canonical form for cross-provider matching.
 *
 * Strips:
 *   1. Quantization/config path prefix — everything before the last "/"
 *      (used by llama.cpp / llama-swap slug IDs).
 *   2. Variant suffix — trailing ":free", ":nitro", ":throughput", ":online",
 *      ":thinking".
 *   3. All casing → lowercase.
 *
 * Examples:
 *   "qwen/qwen3.6-35b-a3b"                     → "qwen3.6-35b-a3b"
 *   "qwen/qwen3.6-35b-a3b:free"                → "qwen3.6-35b-a3b"
 *   "a03b-q4-k80v80-ctx200-byteshape/Qwen3.6-35B-A3B" → "qwen3.6-35b-a3b"
 *   "minimax-m3"                               → "minimax-m3"
 */
function normalizeModelId(modelId) {
  // 1. Strip path prefix (everything up to and including the last "/")
  let id = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  // 2. Strip variant suffixes like :free, :nitro, :throughput, :online, :thinking
  id = id.replace(/:(free|nitro|throughput|online|thinking)$/i, "");
  // 3. Lowercase
  return id.toLowerCase();
}

/**
 * Extract the variant suffix from a model ID.
 * Returns 'standard' if no recognized variant is found.
 */
function parseVariant(modelId) {
  const m = modelId.match(/:([a-z]+)$/i);
  if (!m) return "standard";
  const variant = m[1].toLowerCase();
  if (["free", "nitro", "throughput", "online", "thinking"].includes(variant)) {
    return variant;
  }
  return "standard";
}

/**
 * Look up equivalent pricing for a model from the cross-provider PRICING_DB.
 *
 * Normalizes the model ID, finds all matching entries across providers,
 * filters out nitro and throughput variants (the "most expensive not-nitro
 * not-fast" rule), and returns the cost of the highest-output match.
 *
 * If only nitro/throughput entries were found, falls back to the most
 * expensive among those rather than returning nothing.
 *
 * @param {string} modelId  Model ID to look up.
 * @param {Map}    pricingDB  The global PRICING_DB map.
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

/**
 * Resolve a model's cost, consulting three sources in priority order:
 *
 *   1. **Real provider pricing** — from the raw model object's `cost` or
 *      `pricing` field (live API data).
 *   2. **Cross-provider equivalent** — look up the same base model in the
 *      PRICING_DB (sourced from other providers' unfiltered responses and
 *      static pricing files) and use the most expensive non-nitro variant.
 *   3. **Virtual cost heuristic** — size-based fallback (d006).
 *
 * Returns pi's `cost` shape (USD per 1M tokens).
 *
 * @param {string}  modelId         Model ID.
 * @param {object}  raw             Raw model object.
 * @param {Map}     pricingDB       Cross-provider pricing database.
 * @param {number}  [multiplier=1e6]
 *   Pricing multiplier for `pricing.*` fields (per-provider).
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

/**
 * Resolve a model's cost: real provider cost/pricing when available, else a
 * virtual estimate.  Accepts the raw provider model object.
 *
 * This is the simpler version used when no cross-provider pricing DB is
 * available (e.g. outside the fetchProviderModels flow).  It checks:
 *   • `cost`    — OpenCode / models.dev shape (already in pi's units)
 *   • `pricing` — OpenRouter / AI-Gateway shape (USD per token, ×1e6)
 *   • `virtualCost` — size-based heuristic fallback
 *
 * Returns pi's `cost` shape (USD per 1M tokens).
 *
 * @param {string}  modelId     Model ID.
 * @param {object}  [raw={}]    Raw model object.
 * @param {number}  [multiplier=1e6]
 *   Pricing multiplier for `pricing.*` fields.
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

  const res = await fetch(url, {
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

  // Dump raw (unfiltered) response for offline inspection.
  dumpRawJson("llamacpp-raw-models.json", data);

  return data.map((m) => ({
    id: m.id,
    name: "llamacpp " + m.id,
    api: "openai-completions",
    provider: "llamacpp",
    baseUrl: baseUrl.replace(/\/+$/, ""),
    reasoning: true,
    input: ["text"],
    contextWindow: resolveLlamaCppContextWindow(m.id),
    maxTokens: resolveLlamaCppContextWindow(m.id),
    // llama.cpp has no provider context; use default multiplier (1e6).
    // The pricing DB entries it contributes to will be in per-million units.
    cost: resolveCostWithDB(m.id, m, PRICING_DB, 1e6),
    // Most llama.cpp servers don't support developer role
    compat: { supportsDeveloperRole: false },
  }));
}

/**
 * Fetch and filter models from a remote OpenAI-compatible /models endpoint.
 *
 * The filterFn is applied client-side after fetching.  If the endpoint
 * is unreachable, the caller should catch the error and fall back.
 *
 * @param {string}  baseUrl        Base URL of the provider API.
 * @param {string}  apiKey         API key for auth (empty string = none).
 * @param {function} filterFn      Model filter predicate.
 * @param {string}  providerId     Provider ID (e.g. "openrouter-free").
 * @param {object}  opts           Optional behaviour overrides.
 * @param {string}  [opts.fetchAuth="bearer"]
 *   Auth mechanism for fetching: "bearer" (Authorization: Bearer),
 *   "x-goog-api-key" (X-Goog-Api-Key header), or "none".
 * @param {string}  [opts.modelIdPrefix=""]
 *   Prefix to strip from model IDs (e.g. Google returns
 *   "models/gemini-2.0-flash" — set to "models/" so metadata matches).
 */
async function fetchProviderModels(baseUrl, apiKey, filterFn, providerId, opts = {}) {
  const {
    fetchAuth = "bearer",
    modelIdPrefix = "",
  } = opts;

  // Build fetch headers based on the auth scheme.
  let headers;
  if (apiKey) {
    switch (fetchAuth) {
      case "x-goog-api-key":
        headers = { "X-Goog-Api-Key": apiKey };
        break;
      case "none":
        headers = undefined;
        break;
      default: // "bearer"
        headers = { Authorization: `Bearer ${apiKey}` };
    }
  }

  // Try the standard path first: {baseUrl}/models.
  // If the baseUrl already ends with /v1 (OpenAI convention), this yields
  // {baseUrl}/models = .../v1/models.  If not (e.g. the user set a shorter
  // proxy URL), append /v1/models as a fallback.
  let url = baseUrl.replace(/\/+$/, "") + "/models";

  let res = await fetch(url, { headers });

  // 404 often means the baseUrl needs a /v1 prefix — try once more
  if (res.status === 404 && !url.endsWith("/v1/models")) {
    url = baseUrl.replace(/\/+$/, "") + "/v1/models";
    res = await fetch(url, { headers });
  }

  if (!res.ok) {
    // Try to read the response body for a more informative error message.
    // The body often contains the real reason (e.g. quota exhausted,
    // invalid key format) that the status line alone doesn't convey.
    let detail = "";
    try {
      const errBody = await res.text();
      if (errBody && errBody.length > 0 && errBody.length < 500) {
        // Parse JSON if possible to extract a concise message
        try {
          const parsed = JSON.parse(errBody);
          const msg = parsed?.error?.message || parsed?.message || errBody;
          if (msg && typeof msg === "string" && msg.length < 200) {
            detail = `: ${msg}`;
          }
        } catch {
          // Not JSON; use raw text if short enough
          if (errBody.length < 200) detail = `: ${errBody}`;
        }
      }
    } catch {
      // Ignore read failures — the status line is still informative.
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

  // Dump raw (unfiltered) response for offline inspection.
  dumpRawJson(`${providerId}-raw-models.json`, data);

  // ---- Build cross-provider pricing DB from ALL models (unfiltered) ----
  // Every model in the response — including paid variants that the filter
  // below will discard — contributes its real pricing to PRICING_DB so that
  // models on other providers (e.g. local llama.cpp, :free variants) can
  // look up an equivalent cost.
  //
  // Use the per-provider pricing multiplier so per-million providers
  // (Together, DeepInfra, CrofAI) contribute correct costs.
  const priceMult = getPricingMultiplier(providerId);
  for (const m of data) {
    const rawId = m.id;
    if (!rawId) continue; // skip malformed entries without an id
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
    // Strip provider-specific prefix from the model ID so it matches
    // PI_MODEL_METADATA keys (e.g. Google: "models/gemini-2.0-flash" →
    // "gemini-2.0-flash").
    const rawId = m.id ?? "unknown";
    const cleanId = modelIdPrefix && typeof rawId === "string" && rawId.startsWith(modelIdPrefix)
      ? rawId.slice(modelIdPrefix.length)
      : rawId;

    // Everything below comes from the live /models API...
    const model = {
      id: cleanId,
      name: cleanId,
      input: ["text"],
      // Use context_length from the API if available (OpenRouter provides it);
      // fall back to a reasonable default for providers that don't.
      contextWindow: m.context_length ?? 128000,
      maxTokens: m.max_tokens ?? 65536,
      cost: resolveCostWithDB(cleanId, m, PRICING_DB, priceMult),
    };
    // ...except these OpenAI-compatibility / reasoning fields, which pi
    // defines per-model and the /models endpoint doesn't return.  Mirror
    // them from pi's built-in catalog so behavior matches pi exactly.
    // Use the metadata provider map to look up pi's standard provider ID
    // (e.g. "openrouter-free" → "openrouter") for matching metadata keys.
    const metadataProviderId = METADATA_PROVIDER_MAP[providerId] || providerId;
    const meta = PI_MODEL_METADATA[metadataProviderId]?.[cleanId];
    if (meta) {
      // Use pi's curated metadata as fallback — only fill in fields the
      // /models endpoint didn't already provide (the endpoint never returns
      // these today, but guard defensively so a future API change is respected).
      if (meta.compat !== undefined && model.compat === undefined) model.compat = meta.compat;
      if (meta.thinkingFormat !== undefined && model.thinkingFormat === undefined) model.thinkingFormat = meta.thinkingFormat;
      if (meta.reasoning !== undefined && model.reasoning === undefined) model.reasoning = meta.reasoning;
      if (meta.thinkingLevelMap !== undefined && model.thinkingLevelMap === undefined) model.thinkingLevelMap = meta.thinkingLevelMap;
    }

    // OpenCode Go subscription models: resolve cost from the best available
    // source, preferring fresh (live) data over stale snapshots, and only
    // falling back to the virtual or cross-provider heuristic when nothing
    // else has data.
    //
    // Resolution order (first match wins):
    //   1. Fresh Zen API  — real-time per-token pricing via unfiltered
    //      GET /models (no auth).  Populated by fetchZenPricing().
    //   2. Fresh Go API   — the /models response we just fetched (m.cost).
    //      Currently $0 (subscription-backed) but could change.
    //   3. Stale Go docs  — opencode-go-pricing.json (go.mdx snapshot)
    //   4. Stale Zen docs — opencode-zen-pricing.json (zen.mdx snapshot)
    //   5. Cross-provider or virtual — resolveCostWithDB() fallback
    if (providerId === "opencode-go-sub") {
      // 1. Fresh Zen API pricing (live, unfiltered)
      if (ZEN_LIVE_PRICING) {
        const zc = lookupCost(ZEN_LIVE_PRICING, cleanId);
        if (zc) { model.cost = zc; return model; }
      }

      // 2. Fresh Go API — check the *raw* response for non-zero pricing.
      //    resolveCostWithDB() already set model.cost, but we can't trust it
      //    if it came from the virtual or cross-provider fallback — inspect
      //    m.cost / m.pricing directly to confirm real data.
      const rawCost = m.cost;
      const rawPricing = m.pricing;
      if ((rawCost && (Number(rawCost.output) > 0 || Number(rawCost.input) > 0)) ||
          (rawPricing && (Number(rawPricing.completion ?? rawPricing.output) > 0 ||
                          Number(rawPricing.prompt ?? rawPricing.input) > 0))) {
        // model.cost was already set by resolveCostWithDB with this real data
        return model;
      }

      // 3. Stale Go docs
      const go = lookupCost(OPENCODE_GO_PRICING, cleanId);
      if (go) { model.cost = go; return model; }

      // 4. Stale Zen docs
      const zen = lookupCost(OPENCODE_ZEN_PRICING, cleanId);
      if (zen) { model.cost = zen; return model; }

      // 5. Cross-provider or virtual heuristic already set by resolveCostWithDB
    }

    // ClinePass subscription models: resolve cost from the documented
    // reference pricing table (clinepass-pricing.json).  Subscription-backed
    // models report zero from the live API, so prefer the snapshot over the
    // virtual heuristic.
    //
    // Resolution order:
    //   1. Documented reference pricing (clinepass-pricing.json)
    //   2. Cross-provider or virtual heuristic (already set by resolveCostWithDB)
    if (providerId === "clinepass") {
      // 1. Documented reference pricing
      const cp = lookupCost(CLINEPASS_PRICING, cleanId);
      if (cp) { model.cost = cp; return model; }

      // 2. Cross-provider or virtual heuristic already set by resolveCostWithDB
    }

    return model;
  });
}

// =====================================================================
// 5.  Main
// =====================================================================

async function main() {
  // -- collect built-in provider overrides ---------------------------
  const providerOverrides = {};

  for (const p of BUILDIN_PROVIDERS) {
    // A provider is generated regardless of env vars.  Prefer a *_BASE_URL
    // override from the env file; if it's absent, fall back to the provider's
    // standard public endpoint so the script works with no env vars at all.
    const customBaseUrl = process.env[p.baseUrlEnv] ?? "";
    const baseUrl = customBaseUrl || DEFAULT_BASE_URLS[p.id];

    const entry = {};

    // Always include a baseUrl and api so the provider entry satisfies pi's
    // validation (which requires at least one of baseUrl, headers, compat,
    // modelOverrides, or models, and an api when models are listed).
    // Prefer a custom proxy override; fall back to the provider's standard
    // public endpoint.
    entry.baseUrl = customBaseUrl || DEFAULT_BASE_URLS[p.id];
    entry.api = p.api;

    const apiKeyEnv = resolveApiKeyEnv(p.apiKeyEnv);
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] ?? "" : "";
    if (apiKeyEnv) {
      // Use $VAR reference so pi resolves it from the runtime environment.
      // Prefer the __-prefixed var to avoid collision with pi's standard auth
      // detection; fall back to the plain XYZ_API_KEY when it's absent.
      entry.apiKey = "$" + apiKeyEnv;
    }

    // Try to fetch and filter models from this provider's /models endpoint.
    // On success, emit the full provider entry with a model list (pi will
    // use these instead of its built-in list).
    //
    // MODEL_FILTERS[p.id] can be:
    //   - a function → applied as a client-side filter
    //   - undefined  → all models are kept (pass-through)
    //   - absent (p.id not a key in MODEL_FILTERS) → no fetch, override-only
    //
    // To opt out of fetching entirely, simply omit the provider ID from
    // MODEL_FILTERS or set it to a sentinel (e.g. Symbol('skip')).
    if (p.id in MODEL_FILTERS) {
      const filterFn = MODEL_FILTERS[p.id];

      // Providers that expose all models (including paid ones) when no key
      // is given skip the fetch rather than relying on a naming-convention
      // filter.
      if (p.requireApiKey && !apiKey) {
        const candidateVars = [p.apiKeyEnv, p.apiKeyEnv.replace(/^__/, "")]
          .filter((v, i, a) => a.indexOf(v) === i);
        console.warn(
          `  warning: skipping provider "${p.id}" — requires an API key but none was found in the environment; set ${candidateVars.join(" or ")} to enable this provider`,
        );
        continue;
      }

      // Before fetching Go subscription models, fetch live Zen pricing
      // (unauthenticated — returns all models with real per-token costs)
      // so the cost resolution below can prefer fresh data over stale snapshots.
      if (p.id === "opencode-go-sub") {
        const zenBaseUrl = process.env["OPENCODE_ZEN_BASE_URL"] || DEFAULT_BASE_URLS["opencode-zen-free"];
        if (zenBaseUrl) {
          await fetchZenPricing(zenBaseUrl);
        }
      }

      try {
        const opts = {};
        if (p.fetchAuth) opts.fetchAuth = p.fetchAuth;
        if (p.modelIdPrefix) opts.modelIdPrefix = p.modelIdPrefix;
        // When filterFn is undefined (pass-through), use a function that
        // keeps every model.  This lets the pricing DB still be populated.
        const effectiveFilter = filterFn ?? (() => true);
        const models = await fetchProviderModels(baseUrl, apiKey, effectiveFilter, p.id, opts);
        if (models.length === 0) continue; // filter matched nothing → skip
        entry.models = models;
      } catch (err) {
        console.warn(
          `  warning: could not fetch models for "${p.id}" from ${baseUrl}/models: ${describeError(err)} — skipping provider`,
        );
        continue;
      }
    }

    providerOverrides[p.id] = entry;
  }

  // -- llama.cpp support ---------------------------------------------
  const mergedProviders = { ...providerOverrides };

  const llamacppBaseUrl = process.env[LLAMACPP.baseUrlEnv] || process.env[LLAMACPP.baseUrlFallback];

  if (llamacppBaseUrl) {
    const llamacppApiKeyEnv = resolveApiKeyEnv(LLAMACPP.apiKeyEnv);
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

  // -- output (stdout only) ------------------------------------------
  if (Object.keys(mergedProviders).length === 0) {
    console.warn(
      "  warning: no provider entries generated (no env overrides and/or " +
      "model fetch failed) — output is an empty providers map",
    );
  }

  // Print the generated models.json document to stdout.  Redirect stdout
  // to a file to persist it; warnings/errors went to stderr.
  console.log(JSON.stringify({ providers: mergedProviders }, null, 2));
}

await main();
