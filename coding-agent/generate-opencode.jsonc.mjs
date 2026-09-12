/**
 * @fileoverview generate-opencode.jsonc.mjs — Emit opencode's overlay config: one
 * `provider` map holding ONLY the providers whose built-in routing does not work from this
 * host, rewritten to route through their PEER PATH-ROUTE on the simplified cloud router.
 * This is opencode's counterpart to pi's generate-cloud-pi-native-providers.mjs — same
 * detection cascade, its provider subset (the shared fact table lib/cloud-providers.mjs,
 * minus cline-pass and hyper which opencode has no built-in entry for), different output schema.
 *
 * The peer's cloud face is llm-reverse-proxy: a dumb, faithful reverse proxy that routes
 * `/<providerId>/<path>` byte-for-byte to that provider's FULL real base URL — no model
 * routing, no credential handling (docs/d027). So in peer mode a provider's base URL is
 * simply `<peerBase>/<providerId>` (e.g. `<peerBase>/opencode-go`), and the model ids in
 * the emitted config are the provider's OWN bare ids (the listing under the route IS the
 * provider's `/models` — the `<providerId>/` prefixes of the llama-swap era are gone).
 * Auth is the provider's REAL key (env from the shared fact table) forwarded untouched by
 * the proxy — the old PEER_API_KEY gateway-bearer scheme belonged to llama-swap's key
 * injection and has no meaning here.
 *
 * The emitted file uses opencode's V1 config schema: the provider map lives
 * under the top-level key `provider` (SINGULAR) — `providers` is only a V2 key
 * and is rejected/ignored by the V1 loader (see opencode
 * packages/core/src/v1/config/config.ts, `provider: Schema.Record(...)`).
 *
 * Detection cascade:
 *   1. Cloud providers: if the REAL default endpoint is reachable, opencode's
 *      built-in provider just works — emit nothing. Unreachable + a usable
 *      peer path-route -> emit an override routing that provider through
 *      `<peerBase>/<providerId>`. The peer is probed per provider and lazily:
 *      no unreachable provider means no peer route is needed, so we never
 *      spend the request (or log its failures).
 *   2. Local GGUF: probe the vault-sourced peer base (lib/peer-probe.mjs
 *      peerBaseUrl()), as the llama-swap
 *      path-route of the same funnel (`<base>/llama-swap`, forwarded by
 *      llm-reverse-proxy to the local instance on loopback :8101); emit an
 *      openai-compatible provider for GGUF models.  No localhost candidates
 *      are probed — the LAN :8080 (proxy) and :8101 (llama-swap) listen
 *      addresses are only reachable on the local host (docs/d022).
 *
 * "Reachable" is about the NETWORK PATH, not about credentials. A 401/403 from
 * e.g. https://api.openai.com/v1/models is what an OpenAI-compatible endpoint
 * returns to any unauthenticated request — this generator runs without
 * provider keys by design (opencode holds its own OAuth login / key at
 * runtime), so such a response proves the endpoint is reachable and says
 * nothing about whether opencode's built-in provider works. Only the absence
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
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
const {
	bearerHeaders,
	peerBaseUrl,
	peerProviderUrl,
	probePeerRoutes,
	probeCandidates,
	probeDirect,
} = /** @type {typeof import("../lib/peer-probe.mjs")} */ (
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
 * The provider id a model belongs to in the LOCAL llama-swap catalog (the
 * only catalog still classified by id — cloud models are no longer routed by
 * id and need no attribution, docs/d027).
 * @typedef {"local"} ProviderKind
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

// The peer's funnel base URL — vault-sourced (peerBaseUrl(); see the
// header there).  No localhost candidates are probed — the LAN :8080 (proxy)
// and :8101 (llama-swap) listen addresses are not routable from outside the
// serving host (docs/d022).
const LOCAL_SOURCE_CANDIDATES = [peerProviderUrl(peerBaseUrl(), "llama-swap")];

// Peer candidates for the CLOUD path-routes (docs/d027): the same single
// vault-sourced base.  No localhost candidates — the LAN :8080
// (llm-reverse-proxy) and :8101 (llama-swap) listen addresses are not routable
// from outside the serving host.
const CLOUD_PEER_CANDIDATES = [peerBaseUrl()];

/**
 * Classify a LOCAL llama-swap catalog model id (docs/d027: cloud ids are no
 * longer classified — each cloud provider's peer path-route returns its own
 * models).
 * @param {string} id
 * @returns {ProviderKind|null}
 */
function classify(id) {
	const slash = id.indexOf("/");
	const head = slash === -1 ? undefined : id.slice(0, slash);
	switch (head) {
		case "gfx1030":
			return "local";
		default:
			break;
	}
	if (id.includes("-GGUF")) return "local";
	return null;
}

/**
 * Per-provider scoping of the override's model list (same slices the pi-side
 * generator applies — see its PEER_MODEL_FILTERS): openrouter keeps the
 * ":free" slice; opencode / opencode-go take everything their route serves.
 * @type {Record<string, ((id: string) => boolean)|undefined>}
 */
const PEER_MODEL_FILTERS = {
	openrouter: (id) => id.endsWith(":free"),
};

/**
 * Build an opencode provider entry routing `label`'s models through the
 * provider's peer path-route on the simplified cloud router (docs/d027):
 * baseURL is `<peerBase>/<providerId>`, auth is the provider's REAL key env
 * (the proxy forwards credentials untouched — it performs none), and the
 * model ids are the provider's own bare ids as its `/models` listing under
 * the route served them.
 * @param {string} label
 * @param {string} routeUrl the provider's peer path-route (probePeerRoutes)
 * @param {string} apiKeyEnv the provider's real key env (shared fact table)
 * @param {ModelEntry[]} models
 * @returns {OpenCodeProvider}
 */
function peerProvider(label, routeUrl, apiKeyEnv, models) {
	return {
		name: `Peer: ${label}`,
		env: [apiKeyEnv],
		npm: "@ai-sdk/openai-compatible",
		options: { baseURL: routeUrl },
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

	// Cloud overrides are decided per provider by their own path-route probes
	// below — no shared cloud catalog probe gates them (docs/d027).
	for (const id of needsPeer) {
		const cfg = CLOUD_PROVIDERS[id];
		const route = await probePeerRoutes(
			CLOUD_PEER_CANDIDATES,
			id,
			bearerHeaders(process.env[cfg.apiKeyEnv]?.trim()),
		);
		if (!route) {
			logWarn("no usable peer path-route — skipping", { provider: id });
			continue;
		}
		const filter = PEER_MODEL_FILTERS[id];
		const models = route.entries.filter((e) => filter?.(e.id) ?? true);
		if (models.length === 0) {
			logWarn("no models visible via peer path-route — skipping", {
				provider: id,
				routeUrl: route.url,
			});
			continue;
		}
		providers[id] = peerProvider(cfg.label, route.url, cfg.apiKeyEnv, models);
	}

	// --- 2. local GGUF ---------------------------------------------------
	if (local) {
		const models = local.entries.filter((e) => classify(e.id) === "local");
		if (models.length > 0) {
			// The LOCAL llama-swap face keeps its own OpenAI surface (/v1) and
			// its model-id routing — llama-swap is still what swaps GGUFs
			// (docs/d027) — and llama-swap's own bearer key guards it. The
			// probed baseUrl is already the funnel's /llama-swap path-route;
			// appending /v1 gives <peerBase>/llama-swap/v1, which the proxy
			// forwards to the local instance as /v1/….
			providers.local = peerProvider(
				"Local LLM",
				`${local.baseUrl}/v1`,
				"PEER_API_KEY",
				models,
			);
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
	// lib/artifact.mjs write contract: atomic tmp+rename, replace by default,
	// DRY_RUN=1 leaves the live config untouched and writes a preview.
	const written = writeArtifact(
		out,
		`${JSON.stringify({ provider: providers }, null, 2)}\n`,
	);
	const summary = Object.entries(providers)
		.map(
			([id, p]) =>
				`${id}=${p.options.baseURL}(${Object.keys(p.models).length})`,
		)
		.join(", ");
	logInfo("wrote opencode config", { path: written, providers: summary });
}

await main();
