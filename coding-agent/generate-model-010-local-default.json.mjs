// Emit the pi overlay `model-010-local-default.json` for the llama-swap
// provider.  Reads LLAMA_SWAP_BASE_URL / LLAMA_SWAP_API_KEY, fetches
// llama-swap /models, and writes provider-level `api` + `compat` plus the
// discovered model ids.  All models behind llama-swap are listed regardless of
// load state (the router loads/unloads on demand).  Model layers are named
// model-<lexorank>-<environ>-<uniquename>.json and are collected+sorted at
// merge time (see docs/models-layered-cake.md).
//
// Usage: node generate-model-010-local-default.json.mjs [out]
//   out defaults to $PI_MODELS_JSON else ./model-010-local-default.json.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));

if (process.env.http_proxy || process.env.HTTP_PROXY ||
    process.env.https_proxy || process.env.HTTPS_PROXY) {
  const require = createRequire(import.meta.url);
  const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const REQUEST_TIMEOUT_MS = 8000;

// pi's openai-completions api expects a /v1-prefixed baseUrl (the built-in
// llama.cpp provider uses the same convention); llama-swap speaks that API.
const LLAMA_SWAP_PROVIDER_ID = "llama-swap";
const OPENAI_COMPLETIONS_API = "openai-completions";

// Provider-level compat shared by every llama-swap model — same block the
// built-in llama.cpp extension attaches per-model (see pi docs/models.md).
const LLAMA_SWAP_COMPAT = Object.freeze({
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
});

function normalizeServerUrl(value) {
  return String(value).trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

async function fetchModels(serverUrl, apiKey) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  let url = `${serverUrl}/models`;
  let res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 404 && !url.endsWith("/v1/models")) {
    url = `${serverUrl}/v1/models`;
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const data = body.data ?? body.models ?? body;
  if (!Array.isArray(data)) {
    throw new Error(`GET ${url} returned no models array`);
  }
  return data.map((entry) => entry.id).filter(Boolean);
}

async function main() {
  const serverUrl = normalizeServerUrl(process.env.LLAMA_SWAP_BASE_URL ?? "");
  const apiKey = (process.env.LLAMA_SWAP_API_KEY ?? "").trim();
  if (!serverUrl) {
    console.warn("  note: LLAMA_SWAP_BASE_URL unset — nothing to do");
    return;
  }
  const ids = [...new Set(await fetchModels(serverUrl, apiKey))];
  if (ids.length === 0) {
    console.warn("  note: llama-swap /models returned no model ids");
    return;
  }

  const provider = {
    baseUrl: `${serverUrl}/v1`,
    api: OPENAI_COMPLETIONS_API,
    compat: LLAMA_SWAP_COMPAT,
  };
  if (apiKey) {
    provider.apiKey = "$LLAMA_SWAP_API_KEY";
  }
  provider.models = ids.map((id) => ({ id }));

  const out = process.argv[2] ?? process.env.PI_MODELS_JSON ?? join(scriptDir, "model-010-local-default.json");
  writeFileSync(out, `${JSON.stringify({ providers: { [LLAMA_SWAP_PROVIDER_ID]: provider } }, null, 2)}\n`);
  console.warn(`  wrote ${out} (${ids.length} models)`);
}

await main();
