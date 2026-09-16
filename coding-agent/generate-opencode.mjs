/**
 * @fileoverview generate-opencode.mjs — Emit opencode's overlay config: one
 * `provider` map holding ONLY the providers whose built-in routing does not
 * work from this host, rewritten to their peer path-route on the simplified
 * cloud router.
 *
 * The opencode-side generator, kept separate from the unified pi generator
 * (`generate-pi-coding-agent.mjs`) because it emits a different schema and
 * consumes a different input set — the merge is BY CODING AGENT: all pi
 * config in one generator, all opencode config in this one. Same detection
 * cascade as the pi generator's override-only rows, its provider subset
 * (lib/cloud-providers.mjs minus cline-pass/hyper), different schema.
 *
 * Detection cascade, reachability rule and emitted shape: docs/d033.
 * Peer-route mechanics: docs/d027. Merge/write contract: lib/artifact.mjs.
 *
 * GOTCHA: opencode's V1 config puts the provider map under the top-level key
 * `provider` (**singular**) — `providers` is a V2 key the V1 loader rejects.
 *
 * Usage: node generate-opencode.mjs [out]
 *   out defaults to ./opencode.jsonc.
 */

import { join } from "node:path";

import {
	bearerHeaders,
	CLOUD_PROVIDERS as CLOUD_PROVIDER_FACTS,
	logInfo,
	logWarn,
	peerBaseUrls,
	peerProviderUrl,
	peersOnly,
	probeCandidates,
	probeDirect,
	probePeerRoutes,
	scriptDir,
	setLogTool,
	suppressedProbe,
	writeArtifact,
} from "./gen-lib.mjs";

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
// generate-pi-coding-agent.mjs's full rows (docs/d022).
const CLOUD_PROVIDER_IDS = ["opencode", "opencode-go", "openrouter"];

/** @type {Record<string, import("../lib/cloud-providers.mjs").CloudProviderFacts>} */
const CLOUD_PROVIDERS = Object.fromEntries(
	CLOUD_PROVIDER_IDS.map((id) => [id, CLOUD_PROVIDER_FACTS[id]]),
);

// Peer candidates (docs/d027): vault-sourced peer bases for the LOCAL
// llama-swap path-route and the CLOUD path-routes. Supports multi-hop proxy
// chains (PEER_BASE_URLS comma/newline delimited). No localhost candidates —
// the LAN :8080 (proxy) and :8101 (llama-swap) listen addresses are not
// routable from outside the serving host (docs/d022).
const CLOUD_PEER_CANDIDATES = peerBaseUrls();
const LOCAL_SOURCE_CANDIDATES = CLOUD_PEER_CANDIDATES.map((base) =>
	peerProviderUrl(base, "llama-swap"),
);

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

	// --- 1. cloud providers: direct first (parallel) -------------------
	// Only providers whose real endpoint is genuinely UNREACHABLE are peer
	// candidates; a 401/403 (or any other http answer) keeps the built-in
	// routing opencode already has. Parallelized to reduce unnecessary
	// critical path latency. PEERS_ONLY=1 (docs/d033) skips this phase
	// entirely — the operator declared the cloud unreachable, so every
	// provider's result is pre-classified "unreachable" (a blocked cloud
	// would cost the full 8s probe timeout per provider) and the peer
	// path-route phase below decides everything.
	const cloudResults = await Promise.allSettled(
		peersOnly()
			? Object.keys(CLOUD_PROVIDERS).map((id) =>
					Promise.resolve({
						id,
						result: /** @type {"unreachable"} */ ("unreachable"),
						error: Object.assign(
							new Error("PEERS_ONLY — direct probe skipped"),
							{ provider: id },
						),
					}),
				)
			: Object.entries(CLOUD_PROVIDERS).map(([id, cfg]) =>
					probeDirect(
						cfg.baseUrl,
						bearerHeaders(process.env[cfg.apiKeyEnv]?.trim()),
					).then(
						(r) => ({ id, ...r }),
						// probeDirect classifies transport failures itself, so a throw is
						// unexpected — but the id must survive it, or the provider silently
						// loses its peer path-route probe (the rejection branch used to
						// push a literal "unknown" instead).
						(err) => {
							logWarn("cloud probe threw — will check peer routing", {
								provider: id,
								error: err,
							});
							return {
								id,
								result: /** @type {"unreachable"} */ ("unreachable"),
								error: err,
							};
						},
					),
				),
	);

	/** @type {string[]} */
	const needsPeer = [];
	for (const r of cloudResults) {
		if (r.status !== "fulfilled") continue; // rejection already handled + logged above
		const { id, result, error } = r.value;
		if (result !== "unreachable") {
			if (result === "ok") {
				logInfo("reachable directly — keeping built-in routing", {
					provider: id,
				});
			} else {
				// Same SuppressedError composition as the pi generator's demotion
				// records (docs/d045): expectation + chained probe failure.
				logInfo("reachable — keeping built-in routing", {
					provider: id,
					error: suppressedProbe(
						{ result, error },
						"expected a usable /models listing from the default endpoint",
					),
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
	const peerResults = await Promise.allSettled(
		needsPeer.map((id) =>
			probePeerRoutes(
				CLOUD_PEER_CANDIDATES,
				id,
				bearerHeaders(process.env[CLOUD_PROVIDERS[id].apiKeyEnv]?.trim()),
			).then(
				(r) => ({ id, route: r ?? null }),
				// Same id-preservation rule as the direct phase above.
				(err) => {
					logWarn("peer probe threw — skipping", {
						provider: id,
						error: err,
					});
					return { id, route: null };
				},
			),
		),
	);

	for (const r of peerResults) {
		if (r.status !== "fulfilled" || !r.value.route) {
			if (r.status === "fulfilled") {
				logWarn("no usable peer path-route — skipping", {
					provider: r.value.id,
				});
			}
			continue;
		}
		const { id, route } = r.value;
		const cfg = CLOUD_PROVIDERS[id];
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
