// gen-lib.mjs — shared helpers for the split llama-swap peer/general
// generators.  Kept self-contained so a serving dir can be copied onto a host
// in isolation; explanations live in docs/d018-split-config-d.md (merge
// contract) and docs/d001 (proxy/namespace).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";

export const scriptDir = dirname(fileURLToPath(import.meta.url));

// Route fetch() through http(s)_proxy when set (rationale: docs/d001).
if (process.env.http_proxy || process.env.HTTP_PROXY ||
    process.env.https_proxy || process.env.HTTPS_PROXY) {
  try {
    const require = createRequire(import.meta.url);
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch (err) {
    console.warn(
      `  warning: http(s)_proxy set but undici EnvHttpProxyAgent unavailable: ` +
      `${err.message} — fetch requests will NOT use the proxy`,
    );
  }
}

const REQUEST_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

// --- Providers ---------------------------------------------------------
// Keys match pi-coding-agent's built-in provider names so generated peer ids
// line up with what pi expects.  `filter` applies to the live /models
// response; `requireApiKey` gates a provider's fetch behind a credential;
// `apiKeyEnv` is the env var llama-swap reads for that peer's key at request
// time.
export const PROVIDERS = {
  openrouter: {
    id: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    filter: (m) => m.id.endsWith(":free"),
  },
  opencode: {
    id: "opencode",
    apiKeyEnv: "OPENCODE_API_KEY",
    defaultBaseUrl: "https://opencode.ai/zen/v1",
    // Without a key the API returns ALL models (incl. paid); with a key it
    // restricts to free-tier server-side (docs/d013).
    requireApiKey: true,
    filter: (m) => m.id.endsWith("-free"),
  },
  "opencode-go": {
    id: "opencode-go",
    apiKeyEnv: "OPENCODE_API_KEY",
    defaultBaseUrl: "https://opencode.ai/zen/go/v1",
    // Drops every model unless the key is present, so no tier/paid models are
    // exposed without the subscription.
    filter: (m) => {
      if (process.env["OPENCODE_API_KEY"] === undefined) return false;
      return !m.id.toLowerCase().includes("grok");
    },
  },
};

// --- Auth / fetch helpers ---------------------------------------------

export function buildAuthHeaders(apiKey, fetchAuth = "bearer") {
  if (!apiKey) return undefined;
  switch (fetchAuth) {
    case "x-goog-api-key": return { "X-Goog-Api-Key": apiKey };
    case "none":           return undefined;
    default:               return { Authorization: `Bearer ${apiKey}` };
  }
}

export async function fetchModelsJson(baseUrl, headers) {
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

export async function fetchProviderModels(baseUrl, apiKey, filterFn, providerId, opts = {}) {
  const { fetchAuth = "bearer" } = opts;
  const headers = buildAuthHeaders(apiKey, fetchAuth);
  const { data } = await fetchModelsJson(baseUrl, headers);
  return data.filter(filterFn).map((m) => (m.id ?? "unknown"));
}

// Fetch the (filtered) model list for one provider.  Returns null on skip
// (missing required key) or fetch failure so callers treat it as "no result".
// apiKey here is ONLY for the live /models fetch; the peer entry written to
// disk references the env var, never the value.
export async function fetchPeerModels(p, opts = {}) {
  const apiKey = process.env[p.apiKeyEnv] ?? "";
  if (p.requireApiKey && !apiKey) {
    console.warn(`  warning: skipping provider "${p.id}" — needs ${p.apiKeyEnv}`);
    return null;
  }
  try {
    return await fetchProviderModels(p.defaultBaseUrl, apiKey, p.filter, p.id, opts);
  } catch (err) {
    console.warn(
      `  warning: fetch for provider "${p.id}" failed: ` +
      `${err?.cause?.code || err?.message || err} — skipping`,
    );
    return null;
  }
}

// --- llama-swap config helpers ---------------------------------------

export function loadCore(path = join(scriptDir, "llama-swap-core.json")) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// Build a peer entry ({ proxy, models[, apiKey] }) from a provider + model
// list.  apiKey is emitted as a ${env.*} reference (resolved by llama-swap at
// load time) when the generator's own environment has the key; otherwise it is
// omitted.
export function peerEntry(p, models) {
  const proxy = p.defaultBaseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  const entry = { proxy, models };
  if (process.env[p.apiKeyEnv] !== undefined) {
    entry.apiKey = `\${env.${p.apiKeyEnv}}`;
  }
  return entry;
}

// Write an object as pretty JSON into config.d/ (the YAML loader accepts JSON
// content, and JSON-in-.yaml matches the repo's existing config style).
export function writeConfigD(name, obj, dir = join(scriptDir, "config.d")) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  console.warn(`  wrote ${path}`);
}
