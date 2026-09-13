/**
 * @fileoverview generate-cloud-pi-native-providers.mjs — Emit the pi overlay
 * `model-012-cloud-pi-native.json`: a **reroute-only override** for every
 * pi-native cloud provider (openrouter / opencode / opencode-go / mistral /
 * google / nvidia) whose default endpoint is NOT reachable from this host. When
 * nothing is emitted, pi's built-in providers just work (docs/d024).
 *
 * The opposite semantic — providers pi does NOT ship, where the layer is the
 * sole full definition — is generate-cloud-alternative-providers.mjs.
 * generate-opencode.jsonc.mjs is the opencode-schema twin. Detection cascade,
 * reachability rule, model-list source priority and the per-provider filters
 * live in docs/d033. Merge contract: merge-models-json.mjs.
 *
 * Usage: node generate-cloud-pi-native-providers.mjs [out]
 *   out defaults to $PI_MODELS_JSON else ./model-012-cloud-pi-native.json.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	bearerHeaders,
	CLOUD_PROVIDERS as CLOUD_PROVIDER_FACTS,
	getCatwalkModels,
	logInfo,
	logWarn,
	modelsDevCatalogPath,
	peerBaseUrls,
	piModel,
	PI_NATIVE_CLOUD_IDS,
	probeDirect,
	probePeerRoutes,
	providerReroute,
	refreshCatwalkFacts,
	scriptDir,
	setLogTool,
	writeArtifact,
} from "./gen-lib.mjs";

setLogTool("coding-agent/generate-cloud-pi-native");

// Peer candidates — vault-sourced (peerBaseUrls(); see lib/peer-probe.mjs).
// Supports multi-hop proxy chains (PEER_BASE_URLS comma/newline delimited);
// no localhost candidates — the LAN :8080 (proxy) and :8101 (llama-swap)
// listen addresses are not routable from outside the serving host (docs/d022).
const CLOUD_PEER_CANDIDATES = peerBaseUrls();

// The vendored models.dev catalog (fallback model-list source, docs/d023):
// next to this script when run from generate.sh's scratch dir, the shared
// vendored copy for manual in-place runs. Absent ⇒ the (a)-listings above
// are the only model source.
const API_JSON = modelsDevCatalogPath();

/**
 * Per-provider scoping of the override's model list, applied to BOTH sources
 * (live peer listing and catalog fallback). These are the slices this fleet
 * can actually use — the llama-swap era encoded them on the SERVING side
 * (gen-lib's `filter`); with routing per provider the client scopes its own
 * override.
 *
 *   - openrouter: the ":free" slice (the same scope the peer always served).
 *   - mistral: chat-capable only — the catalog/listing also carries
 *     mistral-embed (embeddings) and voxtral-*-tts (speech).
 *   - google: the gemini chat slice — the listing also carries imagen/veo/
 *     lyria (media generation), embeddings, tts and the gemini image-output
 *     variants, none of which pi can drive.
 *
 * @type {Record<string, ((id: string) => boolean)|undefined>}
 */
const PEER_MODEL_FILTERS = {
	openrouter: (id) => id.endsWith(":free"),
	mistral: (id) => !/embed|tts/i.test(id),
	google: (id) => /^gemini-/.test(id) && !/(-image|-tts)/i.test(id),
};

/**
 * The scoped model-id list for one provider from the vendored models.dev
 * catalog, or null when the catalog has no usable slice for it.
 * Falls back to catwalk when models.dev is stale.
 * @param {string} id provider id (models.dev key)
 * @returns {string[]|null}
 */
function catalogModelIds(id) {
	// --- 1. models.dev catalog ------------------------------------------
	try {
		const catalog =
			/** @type {Record<string, { models?: Record<string, unknown> }>} */ (
				JSON.parse(readFileSync(API_JSON, "utf-8"))
			);
		const models = catalog[id]?.models ?? {};
		const filter = PEER_MODEL_FILTERS[id];
		const ids = Object.keys(models).filter((mid) => filter?.(mid) ?? true);
		if (ids.length) return ids;
	} catch (err) {
		logWarn("models.dev catalog unavailable — trying catwalk fallback", {
			provider: id,
			error: /** @type {Error} */ (err).message,
		});
	}

	// --- 2. catwalk fallback --------------------------------------------
	// Catwalk provider mapping: openrouter→openrouter, opencode→opencode-zen,
	// google→gemini. nvidia/mistral have no catwalk entry.
	const catwalkModels = getCatwalkModels(id);
	if (catwalkModels) {
		const filter = PEER_MODEL_FILTERS[id];
		const ids = catwalkModels
			.map((m) => m.id)
			.filter((mid) => filter?.(mid) ?? true);
		if (ids.length) {
			logInfo(`${id} model IDs from catwalk fallback`, {
				models: ids.length,
			});
			return ids;
		}
	}

	logWarn("no model list available from models.dev or catwalk", {
		provider: id,
	});
	return null;
}

/**
 * The override's models for one provider, from the peer route's live
 * listing. Returns null when the listing yields nothing usable (the caller
 * falls back to the catalog).
 * @param {import("../lib/peer-probe.mjs").RawModelEntry[]} entries
 * @param {string} id provider id (for logging)
 * @returns {import("../lib/pi-models.mjs").PiModel[]|null}
 */
function listingModels(entries, id) {
	const filter = PEER_MODEL_FILTERS[id];
	const models = entries.filter((e) => filter?.(e.id) ?? true).map(piModel);
	return models.length ? models : null;
}

/** @returns {Promise<void>} */
async function main() {
	const out =
		process.argv[2] ??
		process.env.PI_MODELS_JSON ??
		join(scriptDir, "model-012-cloud-pi-native.json");

	// Direct-first: probe each provider's DEFAULT endpoint in parallel; only
	// providers whose direct endpoint is unreachable get peer path-route probes.
	// Parallelized to reduce unnecessary critical path latency — each probe
	// is I/O-bound with an 8s timeout, so running them concurrently avoids
	// N * 8s sequential wait.
	/** @type {string[]} */
	const needsPeer = [];
	// Refresh catwalk catalog once at the start — best-effort, used as
	// fallback for providers that catwalk covers (openrouter, opencode-go,
	// google via gemini). Catwalk is public (no keys needed).
	await refreshCatwalkFacts();

	// Phase 1: parallel direct probes
	const directResults = await Promise.allSettled(
		PI_NATIVE_CLOUD_IDS.map((id) =>
			probeDirect(
				CLOUD_PROVIDER_FACTS[id].baseUrl,
				bearerHeaders(process.env[CLOUD_PROVIDER_FACTS[id].apiKeyEnv]?.trim()),
			).then(
				(r) => ({ id, ...r }),
				// probeDirect classifies transport failures itself, so a throw is
				// unexpected — but the id must survive it, or the provider silently
				// loses its peer path-route probe (the rejection branch used to
				// push a literal "unknown" instead).
				(err) => {
					logWarn("direct probe threw — will probe peer path-route", {
						provider: id,
						error: /** @type {any} */ (err)?.message ?? String(err),
					});
					return {
						id,
						result: /** @type {"unreachable"} */ ("unreachable"),
						error: /** @type {any} */ (err)?.message ?? String(err),
					};
				},
			),
		),
	);

	// Classify results: reachable providers keep built-in routing;
	// unreachable ones need peer probing.
	for (const r of directResults) {
		if (r.status !== "fulfilled") continue; // rejection already handled + logged above
		const { id, result, error } = r.value;
		if (result !== "unreachable") {
			if (result === "auth") {
				// Not a routing problem: the endpoint answered and refused our
				// (absent) credentials — pi authenticates itself at request time.
				logInfo(
					"default endpoint reachable but credential-gated — keeping built-in routing",
					{ provider: id, error },
				);
			} else if (result === "reachable") {
				logWarn(
					"default endpoint reachable but answered unexpectedly — keeping built-in routing",
					{ provider: id, error },
				);
			}
			continue; // direct endpoint reachable — pi's built-in provider handles it
		}
		logInfo("default endpoint unreachable — will probe peer path-route", {
			provider: id,
			error,
		});
		needsPeer.push(id);
	}

	/** @type {Record<string, import("../lib/pi-models.mjs").PiProvider>} */
	const providers = {};
	// Phase 2: parallel peer path-route probes for providers that need it
	const peerResults = await Promise.allSettled(
		needsPeer.map((id) =>
			probePeerRoutes(
				CLOUD_PEER_CANDIDATES,
				id,
				bearerHeaders(process.env[CLOUD_PROVIDER_FACTS[id].apiKeyEnv]?.trim()),
			).then(
				(r) => ({ id, route: r ?? null }),
				// Same id-preservation rule as the direct phase above.
				(err) => {
					logWarn("peer probe threw — provider left on built-in routing", {
						provider: id,
						error: /** @type {any} */ (err)?.message ?? String(err),
					});
					return { id, route: null };
				},
			),
		),
	);

	for (const r of peerResults) {
		if (r.status !== "fulfilled" || !r.value.route) {
			if (r.status === "fulfilled") {
				logWarn("no usable peer path-route — provider left on built-in routing", {
					provider: r.value.id,
				});
			}
			continue;
		}
		const { id, route } = r.value;
		const models = listingModels(route.entries, id);
		if (models) {
			logInfo("override models from live peer listing", {
				provider: id,
				models: models.length,
			});
			providers[id] = providerReroute(route.url, models);
			continue;
		}
		// Route proved but not listable (401/403 without a key, or an
		// unexpected answer): the catalog mirrors the provider's own ids.
		const ids = catalogModelIds(id);
		if (!ids) {
			logWarn("no model list available — skipping", { provider: id });
			continue;
		}
		logInfo("override models from models.dev catalog fallback", {
			provider: id,
			models: ids.length,
		});
		providers[id] = providerReroute(
			route.url,
			ids.map((mid) => piModel({ id: mid })),
		);
	}

	if (Object.keys(providers).length === 0) {
		logWarn("nothing usable detected — output left untouched", { out });
		return;
	}

	const written = writeArtifact(
		out,
		`${JSON.stringify({ providers }, null, 2)}\n`,
	);
	const summary = Object.entries(providers)
		.map(([id, p]) => `${id}=${p.baseUrl}(${p.models.length})`)
		.join(", ");
	logInfo("wrote models layer", { path: written, providers: summary });
}

await main();
