// Emit the opencode overlay `opencode.jsonc`: one `providers` map mirroring
// pi's peer-mode routing (see coding-agent/generate-models.json.mjs) but for
// opencode's provider model. The peer is a llama-swap instance with peer
// routing enabled: a reverse proxy that listens on /v1/completions,
// /v1/responses and /v1/messages and routes to the correct upstream model
// endpoint based on the "model" body. So for every provider, in peer mode,
// the base URL is simply the peer — opencode keeps using its native protocol
// and the peer forwards by composite "provider/model" model id (e.g.
// `opencode/hy3-free`, `openrouter/gpt-4`), which we pass through unchanged.
// Auth is a bearer PEER_API_KEY (peer accepts bearer tokens).
//
// The emitted file uses opencode's V1 config schema: the provider map lives
// under the top-level key `provider` (SINGULAR) — `providers` is only a V2
// key and is rejected/ignored by the V1 loader (see opencode
// packages/core/src/v1/config/config.ts, `provider: Schema.Record(...)`).
//
// Detection cascade (same as generate-models.json.mjs):
//   1. Cloud providers: if the REAL default endpoint is reachable, opencode's
//      built-in provider just works — emit nothing. Unreachable + visible via
//      the peer -> emit an override routing that provider through the peer.
//   2. Local GGUF: probe PEER_BASE_URL, the co-located LAN :8080, then the
//      tailscale router; emit an openai-compatible provider for GGUF models.
//      (The legacy :18080 local-inference port is deprecated — the single
//      multipurpose instance lives on the LAN port :8080.)
//
// opencode-go IS included: the opencode models.dev catalog ships a built-in
// `opencode-go` provider (env OPENCODE_API_KEY, api https://opencode.ai/zen/go/v1).
//
// Usage: node generate-opencode.jsonc.mjs [out]
//   out defaults to ./opencode.jsonc.

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { writeFileSync, renameSync } from "node:fs"

const scriptDir = dirname(fileURLToPath(import.meta.url))

const REQUEST_TIMEOUT_MS = 8000

// The bazzite tailscale URL reverse-proxies the LAN llama-swap instance
// (:8080), which serves BOTH concerns, so it is a valid candidate for either.
const BAZZITE_ROUTER_TAILSCALE_URL =
  "https://bazzite.coelacanth-barb.ts.net/8654b72a-de9b-402b-abe6-7201dcb38438"

// Peer base URL; must be set via env (no localhost:8080 fallback — the peer
// router is never addressed directly without an explicit PEER_BASE_URL).
const PEER_BASE_URL = (process.env.PEER_BASE_URL ?? "").replace(/\/+$/, "")

// Peer candidates: explicit override, the co-located multipurpose instance
// (LAN :8080 — serves local GGUF + cloud peers on one port), then the remote
// tailscale proxy.
const CLOUD_PEER_CANDIDATES = [PEER_BASE_URL, "http://localhost:8080", BAZZITE_ROUTER_TAILSCALE_URL].filter(Boolean)

// Local GGUF is served by the same multipurpose llama-swap instance (:8080
// LAN); fall back to PEER_BASE_URL / the tailscale router (which exposes the
// gfx1030 catalog as FQN ids) and the tailscale router.
const LOCAL_SOURCE_CANDIDATES = [
  PEER_BASE_URL,
  "http://localhost:8080",
  BAZZITE_ROUTER_TAILSCALE_URL,
].filter(Boolean)

// Cloud providers opencode can reach natively; overriden only when the real
// endpoint is unreachable. `keyEnv` is the env var holding the real provider
// key (used only for the direct-reachability probe). In peer mode the
// provider's base URL is the peer itself.
const CLOUD_PROVIDERS = {
  opencode: {
    label: "OpenCode Zen",
    realBase: "https://opencode.ai/zen/v1",
    keyEnv: "OPENCODE_API_KEY",
  },
  "opencode-go": {
    label: "OpenCode Go",
    realBase: "https://opencode.ai/zen/go/v1",
    keyEnv: "OPENCODE_API_KEY",
  },
  openrouter: {
    label: "OpenRouter",
    realBase: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
  },
  openai: {
    label: "OpenAI",
    realBase: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
  },
}

function bearerOrBasic(key) {
  return key ? { Authorization: `Bearer ${key}` } : undefined
}

async function fetchModelEntries(serverUrl, headers) {
  let url = `${serverUrl}/models`
  let res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (res.status === 404 && !url.endsWith("/v1/models")) {
    url = `${serverUrl}/v1/models`
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  }
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  const body = await res.json()
  const data = body.data ?? body.models ?? body
  if (!Array.isArray(data)) throw new Error(`GET ${url} returned no models array`)
  return data.filter((entry) => Boolean(entry?.id))
}

async function probeCandidates(candidates, accept) {
  const failures = []
  for (const baseUrl of candidates) {
    try {
      const entries = await fetchModelEntries(baseUrl, bearerOrBasic(process.env.PEER_API_KEY?.trim()))
      const ids = entries.map((e) => e.id)
      if (!accept(ids)) throw new Error("no usable models for this concern")
      return { baseUrl, entries }
    } catch (err) {
      failures.push(`${baseUrl}: ${err.message}`)
    }
  }
  if (failures.length) console.warn(`  note: ${failures.join(" | ")}`)
  return null
}

// Map a (possibly composite) model id to a peer-routed opencode provider, or
// null to skip. opencode-go is skipped per project decision.
function classify(id) {
  const slash = id.indexOf("/")
  const head = slash === -1 ? undefined : id.slice(0, slash)
  const bare = slash === -1 ? id : id.slice(slash + 1)
  switch (head) {
    case "opencode":
      return "opencode"
    case "opencode-go":
      return "opencode-go"
    case "openrouter":
      return "openrouter"
    case "openai":
      return "openai"
    case "gfx1030":
      return "local"
    default:
      break
  }
  if (id.includes("-GGUF")) return "local"
  if (bare.endsWith(":free")) return "openrouter"
  if (bare.endsWith("-free")) return "opencode"
  return null
}

async function main() {
  const out = process.argv[2] ?? join(scriptDir, "opencode.jsonc")

  const peer = await probeCandidates(
    CLOUD_PEER_CANDIDATES,
    (ids) => ids.some((id) => classify(id) !== null),
  )
  const peerEntries = peer?.entries ?? []

  const local = await probeCandidates(
    LOCAL_SOURCE_CANDIDATES,
    (ids) => ids.some((id) => classify(id) === "local"),
  )

  const providers = {}

  for (const [id, cfg] of Object.entries(CLOUD_PROVIDERS)) {
    let direct = false
    try {
      await fetchModelEntries(cfg.realBase, bearerOrBasic(process.env[cfg.keyEnv]?.trim()))
      direct = true
    } catch (err) {
      console.warn(`  note: ${id} default endpoint unreachable (${err.message})`)
    }
    if (direct) {
      console.warn(`  note: ${id} reachable directly — keeping built-in routing`)
      continue
    }
    const models = peerEntries.filter((e) => classify(e.id) === id)
    if (models.length === 0) {
      console.warn(`  note: no ${id} models visible via peer — skipping`)
      continue
    }
    // Route through the peer that was actually detected (NOT the literal
    // PEER_BASE_URL — the winning candidate may be localhost:8080 or the
    // tailscale router), with the /v1 suffix the peer's OpenAI-compatible
    // endpoints live under (same convention as generate-models.json.mjs).
    providers[id] = {
      name: `Peer: ${cfg.label}`,
      env: ["PEER_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${peer.baseUrl}/v1` },
      models: Object.fromEntries(models.map((e) => [e.id, { name: e.id }])),
    }
  }

  if (local) {
    const models = local.entries.filter((e) => classify(e.id) === "local")
    if (models.length > 0) {
      providers["local"] = {
        name: "Peer: Local LLM",
        env: ["PEER_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${local.baseUrl}/v1` },
        models: Object.fromEntries(models.map((e) => [e.id, { name: e.id }])),
      }
    } else {
      console.warn("  note: no local GGUF models visible — omitting local provider")
    }
  } else {
    console.warn("  note: no local GGUF source reachable — omitting local provider")
  }

  if (Object.keys(providers).length === 0) {
    console.warn(`  note: nothing usable detected — ${out} left untouched`)
    return
  }

  // opencode V1 config: the provider map key is `provider` (singular).
  const tmp = `${out}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ provider: providers }, null, 2)}\n`)
  renameSync(tmp, out) // atomic on the same filesystem
  const summary = Object.entries(providers)
    .map(([id, p]) => `${id}=${p.options.baseURL}(${Object.keys(p.models).length})`)
    .join(", ")
  console.warn(`  wrote ${out}: ${summary}`)
}

await main()
