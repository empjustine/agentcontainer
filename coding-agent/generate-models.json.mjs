// Emit the pi overlay `model-010-local-default.json`: one layer of the layered
// models.json (see docs/models-layered-cake.md) carrying every provider whose
// default routing is NOT usable from this host, rewritten to routes that are.
//
// Detection cascade:
//
//   1. Local inference (provider id `llama-swap`): probe the multipurpose
//      llama-swap instance — $PEER_BASE_URL, then the co-located LAN port
//      :8080 (tailscale funnel reverse-proxies this same port, so the
//      world-visible FQDN serves the identical catalog), then the bazzite
//      tailscale URL.  First candidate serving GGUF models wins; its model
//      catalog becomes the `llama-swap` provider (pi-shaped metadata mirrored
//      from meta.llamaswap).  (The legacy :18080 local-inference port is
//      DEPRECATED with the serving-dir squash — do not add it back.)
//
//   2. Cloud providers (`openrouter`, `opencode`, `opencode-go`): probe each
//      provider's DEFAULT /v1/models endpoint.  Reachable ⇒ pi's built-in
//      provider handles it natively, nothing is emitted.  Unreachable ⇒ look
//      for the models behind a llama-swap peer router ($PEER_BASE_URL, the
//      co-located multipurpose openai-completions instance, then the bazzite
//      tailscale URL); if found, emit a provider override so pi routes that
//      provider through the peer instead.
//
// Every emitted baseUrl is a LITERAL url resolved at generation time (pi does
// not expand ${vars} in baseUrl); apiKey is the literal "$PEER_API_KEY", which
// pi resolves from the environment at request time.
//
// Usage: node generate-models.json.mjs [out]
//   out defaults to $PI_MODELS_JSON else ./model-010-local-default.json.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, renameSync } from "node:fs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const REQUEST_TIMEOUT_MS = 8000;

const OPENAI_COMPLETIONS_API = "openai-completions";

// Provider-level compat shared by every llama-swap-routed model — same block
// the built-in llama.cpp extension attaches per-model (see pi docs/models.md).
const LLAMA_SWAP_COMPAT = Object.freeze({
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
});

// The bazzite tailscale URL reverse-proxies the LAN llama-swap instance
// (:8080), which serves BOTH concerns — local GGUF (FQN "gfx1030/<id>" when
// reached remotely) and cloud peers — so it is a valid candidate for either.
const BAZZITE_ROUTER_TAILSCALE_URL =
  "https://bazzite.coelacanth-barb.ts.net/8654b72a-de9b-402b-abe6-7201dcb38438";

// Ordered best-first: explicit override, co-located LAN port, remote proxy.
const LOCAL_SOURCE_CANDIDATES = [
  process.env.PEER_BASE_URL?.replace(/\/+$/, ""),
  "http://localhost:8080",
  BAZZITE_ROUTER_TAILSCALE_URL,
].filter(Boolean);

// Cloud peers are served by the same multipurpose llama-swap instance as
// local GGUF — one instance per host since the openai-completions squash, on
// the LAN port :8080 (also what the tailscale funnel reverse-proxies).
const CLOUD_PEER_CANDIDATES = [
  process.env.PEER_BASE_URL?.replace(/\/+$/, ""),
  "http://localhost:8080",
  BAZZITE_ROUTER_TAILSCALE_URL,
].filter(Boolean);

// Cloud providers are attributed by their llama-swap peer id when models are
// seen through the peers-only router (ids arrive fully qualified as
// "<peerId>/<modelId>"); bare ids fall back to the same suffix heuristics the
// peer generators use (":free" -> openrouter, "-free" -> opencode, remainder
// -> opencode-go minus grok).
const CLOUD_PEER_IDS = ["openrouter", "opencode", "opencode-go"];

function classifyCloud(id) {
  const slash = id.indexOf("/");
  const head = slash === -1 ? undefined : id.slice(0, slash);
  const prefixed = CLOUD_PEER_IDS.includes(head);
  const bare = prefixed ? id.slice(slash + 1) : id;
  const owner = prefixed ? head : undefined;
  if (bare.endsWith(":free")) return owner ?? "openrouter";
  if (bare.endsWith("-free")) return owner ?? "opencode";
  if (
    !bare.includes("/") &&
    !id.toLowerCase().includes("grok") &&
    !id.includes("-GGUF")
  ) {
    return owner ?? "opencode-go";
  }
  return undefined;
}

// Default cloud endpoints; reachable means pi's built-in provider just works.
const CLOUD_PROVIDERS = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    matches: (id) => classifyCloud(id) === "openrouter",
  },
  opencode: {
    baseUrl: "https://opencode.ai/zen/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    matches: (id) => classifyCloud(id) === "opencode",
  },
  "opencode-go": {
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    matches: (id) => classifyCloud(id) === "opencode-go",
  },
};

function bearerOrBasic(key) {
  return key ? { Authorization: `Bearer ${key}` } : undefined;
}

async function fetchModelEntries(serverUrl, headers) {
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
  return data.filter((entry) => Boolean(entry?.id));
}

async function probeCandidates(candidates, accept) {
  const failures = [];
  for (const baseUrl of candidates) {
    try {
      const entries = await fetchModelEntries(
        baseUrl,
        bearerOrBasic(process.env.PEER_API_KEY?.trim()),
      );
      const ids = entries.map((e) => e.id);
      if (!accept(ids)) throw new Error("no usable models for this concern");
      return { baseUrl, entries };
    } catch (err) {
      failures.push(`${baseUrl}: ${err.message}`);
    }
  }
  if (failures.length) console.warn(`  note: ${failures.join(" | ")}`);
  return null;
}

// "<slug>-ctx<NNN>-<org>/<repo>[:<quant>]" -> "Qwen3.8-27B UD-Q6_K"
function displayName(id) {
  const m = /^([^-]+)-ctx(\d+)-(.+)$/.exec(id);
  if (!m) return undefined;
  const [, , , repoFull] = m;
  const [repoPath, quant] = repoFull.split(":");
  const base = (repoPath.split("/").pop() ?? "").replace(/-GGUF$/i, "");
  return [base, quant].filter(Boolean).join(" ");
}

function piModel(entry) {
  const meta = entry.meta?.llamaswap;
  const contextWindow =
    meta?.contextWindow ?? entry.context_length ?? entry.meta?.n_ctx ?? undefined;
  const input = meta?.input
    ?? entry.architecture?.input_modalities
    ?? (entry.capabilities?.vision ? ["text", "image"] : ["text"]);
  return {
    id: entry.id,
    ...(displayName(entry.id) ? { name: displayName(entry.id) } : {}),
    reasoning: meta?.reasoning ?? true,
    input,
    contextWindow,
    maxTokens: meta?.maxTokens ?? contextWindow,
    cost: meta?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function providerEntry(baseUrl, models) {
  const provider = {
    // Literal url — pi does not expand environment references in baseUrl.
    baseUrl: `${baseUrl}/v1`,
    api: OPENAI_COMPLETIONS_API,
    compat: LLAMA_SWAP_COMPAT,
  };
  if (process.env.PEER_API_KEY?.trim()) {
    provider.apiKey = "$PEER_API_KEY";
  }
  provider.models = models;
  return provider;
}

async function main() {
  const out = process.argv[2] ?? process.env.PI_MODELS_JSON ?? join(scriptDir, "model-010-local-default.json");

  // --- 1. local inference -------------------------------------------------
  const local = await probeCandidates(
    LOCAL_SOURCE_CANDIDATES,
    (ids) => ids.some((id) => id.includes("-GGUF")),
  );
  const providers = {};
  if (local) {
    const gguf = local.entries.filter((e) => e.id.includes("-GGUF"));
    providers["llama-swap"] = providerEntry(local.baseUrl, gguf.map(piModel));
  } else {
    console.warn("  note: no local GGUF source reachable — omitting llama-swap provider");
  }

  // --- 2. cloud providers -------------------------------------------------
  // Direct-first: probe each provider's DEFAULT endpoint; only if that fails
  // do we look for a llama-swap peer route (lazy — no peer probe, no 401
  // noise, when every direct endpoint is reachable).
  const needsPeer = [];
  for (const [id, p] of Object.entries(CLOUD_PROVIDERS)) {
    try {
      await fetchModelEntries(p.baseUrl, bearerOrBasic(process.env[p.apiKeyEnv]?.trim()));
      continue; // direct endpoint reachable — pi's built-in provider handles it
    } catch (err) {
      console.warn(`  note: ${id} default endpoint unreachable (${err.message})`);
    }
    needsPeer.push([id, p]);
  }

  if (needsPeer.length > 0) {
    const peer = await probeCandidates(CLOUD_PEER_CANDIDATES, (ids) =>
      ids.some((id) => classifyCloud(id) !== undefined),
    );
    if (!peer) console.warn("  note: no cloud-peer route visible — keeping built-in cloud routing");
    for (const [id, p] of needsPeer) {
      if (!peer) continue;
      const models = peer.entries.filter((e) => p.matches(e.id)).map(piModel);
      if (models.length === 0) {
        console.warn(`  note: ${id} models not visible thru ${peer.baseUrl} — skipping`);
        continue;
      }
      providers[id] = providerEntry(peer.baseUrl, models);
    }
  }

  if (Object.keys(providers).length === 0) {
    console.warn(`  note: nothing usable detected — ${out} left untouched`);
    return;
  }

  const tmp = `${out}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ providers }, null, 2)}\n`);
  renameSync(tmp, out); // atomic on the same filesystem
  const summary = Object.entries(providers)
    .map(([id, p]) => `${id}=${p.baseUrl}(${p.models.length})`)
    .join(", ");
  console.warn(`  wrote ${out}: ${summary}`);
}

await main();
