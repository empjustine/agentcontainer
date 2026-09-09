/**
 * @fileoverview generate-opencode.jsonc.mjs — Emit opencode's overlay config: one
 * `provider` map holding ONLY the providers whose built-in routing does not work from this
 * host, rewritten to route through the llama-swap peer. This is opencode's counterpart to
 * pi's generate-cloud-pi-native-providers.mjs — same detection cascade, same provider
 * subset (the shared fact table lib/cloud-providers.mjs, minus cline-pass which opencode
 * has no built-in entry for), different output schema.
 *
 * The peer is a llama-swap instance with peer routing enabled: a reverse proxy
 * that listens on /v1/completions, /v1/responses and /v1/messages and routes
 * to the correct upstream model endpoint based on the "model" body. So for
 * every provider, in peer mode, the base URL is simply the peer — opencode
 * keeps using its native protocol and the peer forwards by composite
 * "provider/model" model id (e.g. `opencode/hy3-free`, `openrouter/gpt-4`),
 * which we pass through unchanged. Auth is a bearer PEER_API_KEY (the peer
 * accepts bearer tokens).
 *
 * The emitted file uses opencode's V1 config schema: the provider map lives
 * under the top-level key `provider` (SINGULAR) — `providers` is only a V2 key
 * and is rejected/ignored by the V1 loader (see opencode
 * packages/core/src/v1/config/config.ts, `provider: Schema.Record(...)`).
 *
 * Detection cascade:
 *   1. Cloud providers: if the REAL default endpoint is reachable, opencode's
 *      built-in provider just works — emit nothing. Unreachable + visible via
 *      the peer -> emit an override routing that provider through the peer.
 *      The peer is probed lazily: no unreachable provider means no peer route
 *      is needed, so we never spend the request (or log its failures).
 *   2. Local GGUF: probe PEER_BASE_URL, then the shared fallback FQDN
 *      (lib/peer-probe.mjs DEFAULT_PEER_FALLBACK — the world-visible FQDN
 *      funnel of the LAN :8080 instance); emit an openai-compatible provider
 *      for GGUF models.  No localhost candidates are probed — the LAN :8080
 *      listen address is only reachable on the local host and the legacy
 *      :18080 local-inference port is deprecated, so a co-located peer is
 *      reached via $PEER_BASE_URL or the FQDN.
 *
 * "Reachable" is about the NETWORK PATH, not about credentials. A 401/403 from
 * e.g. https://api.openai.com/v1/models is what an OpenAI-compatible endpoint
 * returns to any unauthenticated request — this generator runs without
 * provider keys by design (opencode holds its own OAuth login / key at
 * runtime, and we will never have an OPENAI_API_KEY here), so such a response
 * proves the endpoint is reachable and says nothing about whether opencode's
 * built-in provider works. Treating it as "unreachable" used to rewrite
 * perfectly reachable providers onto the peer for no reason. Only the absence
 * of ANY http response (DNS failure, connection refused, TLS failure,
 * timeout) is evidence that this host cannot reach the endpoint.
 *
 * opencode-go IS included: the opencode models.dev catalog ships a built-in
 * `opencode-go` provider (env OPENCODE_API_KEY, api
 * https://opencode.ai/zen/go/v1).
 *
 * Usage: node generate-opencode.jsonc.mjs [out]
 *   out defaults to ./opencode.jsonc.
 */

import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Shared lib/ helpers (docs/d023): the structured logger and the HTTP probe
// toolkit, resolved through the LIB_DIR convention (generate.sh stages them
// into the scratch dir and points LIB_DIR there; manual in-place runs fall
// back to the sibling ../lib).
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { bearerHeaders, DEFAULT_PEER_FALLBACK, probeCandidates, probeDirect } =
	/** @type {typeof import("../lib/peer-probe.mjs")} */ (
		await import(`${LIB_DIR}/peer-probe.mjs`)
	);
const { CLOUD_PROVIDERS: CLOUD_PROVIDER_FACTS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);
setLogTool("coding-agent/generate-opencode");

/**
 * A validated `/models` entry.
 * @typedef {object} ModelEntry
 * @property {string} id
 */

/**
 * The provider id a model belongs to once routed through the peer (`local`
 * being the GGUF catalog, which has no built-in opencode provider).
 * @typedef {"opencode"|"opencode-go"|"openrouter"|"local"} ProviderKind
 */

/**
 * An opencode V1 provider entry (the values under the top-level `provider`
 * key).
 * @typedef {object} OpenCodeProvider
 * @property {string} name
 * @property {string[]} env
 * @property {string} npm
 * @property {{ baseURL: string }} options
 * @property {Record<string, { name: string }>} models
 */

// The providers opencode ships natively, from the shared fact table
// (docs/d024). ClinePass is deliberately absent: opencode has no built-in
// cline-pass provider, and the cline-pass layer is owned exclusively by
// generate-cloud-alternative-providers.mjs (docs/d022).
const CLOUD_PROVIDER_IDS = ["opencode", "opencode-go", "openrouter"];

/** @type {Record<string, import("../lib/cloud-providers.mjs").CloudProviderFacts>} */
const CLOUD_PROVIDERS = Object.fromEntries(
	CLOUD_PROVIDER_IDS.map((id) => [id, CLOUD_PROVIDER_FACTS[id]]),
);

// Peer base URL; must be set via env (no localhost:8080 fallback — the peer
// router is never addressed directly without an explicit PEER_BASE_URL).
const PEER_BASE_URL = (process.env.PEER_BASE_URL ?? "").replace(/\/+$/, "");

// Local GGUF rides the same multipurpose llama-swap instance (exposed as
// FQN "gfx1030/<id>" ids via the fallback FQDN); reach it via
// $PEER_BASE_URL or the FQDN.
const LOCAL_SOURCE_CANDIDATES = [PEER_BASE_URL, DEFAULT_PEER_FALLBACK].filter(
	Boolean,
);

// Peer candidates: explicit override, then the shared fallback FQDN (see
// DEFAULT_PEER_FALLBACK).  No localhost candidates — the LAN :8080 listen
// address and the deprecated :18080 local-inference port are not routable from
// outside the serving host.
const CLOUD_PEER_CANDIDATES = [PEER_BASE_URL, DEFAULT_PEER_FALLBACK].filter(
	Boolean,
);

/**
 * Map a (possibly composite) model id to the provider that owns it, or null to
 * skip the model. Peer catalogs serve cloud models fully qualified
 * (`openrouter/<id>`); bare ids fall back to the suffix conventions.
 * @param {string} id
 * @returns {ProviderKind|null}
 */
function classify(id) {
	const slash = id.indexOf("/");
	const head = slash === -1 ? undefined : id.slice(0, slash);
	const bare = slash === -1 ? id : id.slice(slash + 1);
	switch (head) {
		case "opencode":
			return "opencode";
		case "opencode-go":
			return "opencode-go";
		case "openrouter":
			return "openrouter";
		case "gfx1030":
			return "local";
		default:
			break;
	}
	if (id.includes("-GGUF")) return "local";
	if (bare.endsWith(":free")) return "openrouter";
	if (bare.endsWith("-free")) return "opencode";
	return null;
}

/**
 * Build an opencode provider entry routing `label`'s models through the peer
 * that was actually detected (NOT the literal PEER_BASE_URL — the winning
 * candidate may be the tailscale router), under the /v1 suffix the peer's
 * OpenAI-compatible endpoints live under.
 * @param {string} label
 * @param {import("../lib/peer-probe.mjs").PeerSource} peer
 * @param {ModelEntry[]} models
 * @returns {OpenCodeProvider}
 */
function peerProvider(label, peer, models) {
	return {
		name: `Peer: ${label}`,
		env: ["PEER_API_KEY"],
		npm: "@ai-sdk/openai-compatible",
		options: { baseURL: `${peer.baseUrl}/v1` },
		models: Object.fromEntries(models.map((e) => [e.id, { name: e.id }])),
	};
}

/** @returns {Promise<void>} */
async function main() {
	const out = process.argv[2] ?? join(scriptDir, "opencode.jsonc");

	const local = await probeCandidates(LOCAL_SOURCE_CANDIDATES, (ids) =>
		ids.some((id) => classify(id) === "local"),
	);

	/** @type {Record<string, OpenCodeProvider>} */
	const providers = {};

	// --- 1. cloud providers: direct first -------------------------------
	// Only providers whose real endpoint is genuinely UNREACHABLE are peer
	// candidates; a 401/403 (or any other http answer) keeps the built-in
	// routing opencode already has.
	const needsPeer = [];
	for (const [id, cfg] of Object.entries(CLOUD_PROVIDERS)) {
		const { result, error } = await probeDirect(
			cfg.baseUrl,
			bearerHeaders(process.env[cfg.apiKeyEnv]?.trim()),
		);
		if (result !== "unreachable") {
			if (result === "ok") {
				logInfo("reachable directly — keeping built-in routing", {
					provider: id,
				});
			} else {
				// Any non-unreachable response (401/403/other) proves the network
				// path works; only total absence of response means unreachable.
				logInfo("reachable — keeping built-in routing", {
					provider: id,
					error,
				});
			}
			continue;
		}
		logInfo("default endpoint unreachable — will check peer routing", {
			provider: id,
			error,
		});
		needsPeer.push(id);
	}

	const peer =
		needsPeer.length > 0
			? await probeCandidates(CLOUD_PEER_CANDIDATES, (ids) =>
					ids.some((id) => classify(id) !== null),
				)
			: null;

	for (const id of needsPeer) {
		const cfg = CLOUD_PROVIDERS[id];
		if (!peer) {
			logWarn("no peer route visible — skipping", { provider: id });
			continue;
		}
		const models = peer.entries.filter((e) => classify(e.id) === id);
		if (models.length === 0) {
			logWarn("no models visible via peer — skipping", { provider: id });
			continue;
		}
		providers[id] = peerProvider(cfg.label, peer, models);
	}

	// --- 2. local GGUF ---------------------------------------------------
	if (local) {
		const models = local.entries.filter((e) => classify(e.id) === "local");
		if (models.length > 0) {
			providers["local"] = peerProvider("Local LLM", local, models);
		} else {
			logInfo("no local GGUF models visible — omitting local provider");
		}
	} else {
		logInfo("no local GGUF source reachable — omitting local provider");
	}

	if (Object.keys(providers).length === 0) {
		logWarn("nothing usable detected — output left untouched", { out });
		return;
	}

	// opencode V1 config: the provider map key is `provider` (singular).
	const tmp = `${out}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ provider: providers }, null, 2)}\n`);
	renameSync(tmp, out); // atomic on the same filesystem
	const summary = Object.entries(providers)
		.map(
			([id, p]) =>
				`${id}=${p.options.baseURL}(${Object.keys(p.models).length})`,
		)
		.join(", ");
	logInfo("wrote opencode config", { path: out, providers: summary });
}

await main();
