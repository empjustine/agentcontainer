/**
 * @fileoverview generate-cloud-pi-native-providers.mjs — Emit the pi overlay
 * `model-012-cloud-pi-native.json`: a **reroute-only override** for every
 * pi-native cloud provider (openrouter / opencode / opencode-go / mistral /
 * google) whose default endpoint is NOT reachable from this host. When nothing
 * is emitted, pi's built-in providers just work (docs/d024).
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Shared lib/ helpers (docs/d023): the structured logger, the HTTP probe
// toolkit, the provider fact table and the pi model shaping, resolved through
// the LIB_DIR convention (generate.sh stages them into the scratch dir and
// points LIB_DIR there; manual in-place runs fall back to the sibling ../lib).
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
const { bearerHeaders, peerBaseUrl, probePeerRoutes, probeDirect } =
	/** @type {typeof import("../lib/peer-probe.mjs")} */ (
		await import(`${LIB_DIR}/peer-probe.mjs`)
	);
const { CLOUD_PROVIDERS: CLOUD_PROVIDER_FACTS, PI_NATIVE_CLOUD_IDS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);
const { piModel, providerReroute } =
	/** @type {typeof import("../lib/pi-models.mjs")} */ (
		await import(`${LIB_DIR}/pi-models.mjs`)
	);
setLogTool("coding-agent/generate-cloud-pi-native");

// Peer base — vault-sourced (peerBaseUrl(); see the header there).  No
// localhost candidates — the LAN :8080 (llm-reverse-proxy) and :8101
// (llama-swap) listen addresses are not routable from outside the serving
// host (docs/d022).
const CLOUD_PEER_CANDIDATES = [peerBaseUrl()];

// The vendored models.dev catalog (fallback model-list source, docs/d023):
// next to this script when run from generate.sh's scratch dir, the shared
// vendored copy for manual in-place runs. Absent ⇒ the (a)-listings above
// are the only model source.
const API_JSON =
	process.env.MODELS_DEV_JSON ??
	(existsSync(join(scriptDir, "models.dev.api.json"))
		? join(scriptDir, "models.dev.api.json")
		: join(LIB_DIR, "models.dev.api.json"));

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
 * @param {string} id provider id (models.dev key)
 * @returns {string[]|null}
 */
function catalogModelIds(id) {
	try {
		const catalog =
			/** @type {Record<string, { models?: Record<string, unknown> }>} */ (
				JSON.parse(readFileSync(API_JSON, "utf-8"))
			);
		const models = catalog[id]?.models ?? {};
		const filter = PEER_MODEL_FILTERS[id];
		const ids = Object.keys(models).filter((mid) => filter?.(mid) ?? true);
		return ids.length ? ids : null;
	} catch (err) {
		logWarn("models.dev catalog fallback unavailable", {
			provider: id,
			path: API_JSON,
			error: /** @type {Error} */ (err).message,
		});
		return null;
	}
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

	// Direct-first: probe each provider's DEFAULT endpoint; only if that fails
	// do we look for its peer path-route (lazy — no peer probe, no 401 noise,
	// when every direct endpoint is reachable).
	/** @type {string[]} */
	const needsPeer = [];
	for (const id of PI_NATIVE_CLOUD_IDS) {
		const { baseUrl, apiKeyEnv } = CLOUD_PROVIDER_FACTS[id];
		const { result, error } = await probeDirect(
			baseUrl,
			bearerHeaders(process.env[apiKeyEnv]?.trim()),
		);
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
	for (const id of needsPeer) {
		const { apiKeyEnv } = CLOUD_PROVIDER_FACTS[id];
		const route = await probePeerRoutes(
			CLOUD_PEER_CANDIDATES,
			id,
			bearerHeaders(process.env[apiKeyEnv]?.trim()),
		);
		if (!route) {
			logWarn("no usable peer path-route — provider left on built-in routing", {
				provider: id,
			});
			continue;
		}
		const models = listingModels(route.entries, id);
		if (models) {
			logInfo("override models from live peer listing", {
				provider: id,
				models: models.length,
			});
		} else {
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
			continue;
		}
		providers[id] = providerReroute(route.url, models);
	}

	if (Object.keys(providers).length === 0) {
		logWarn("nothing usable detected — output left untouched", { out });
		return;
	}

	// lib/artifact.mjs write contract: atomic tmp+rename, replace by default,
	// DRY_RUN=1 leaves the layer untouched and writes a preview.
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
