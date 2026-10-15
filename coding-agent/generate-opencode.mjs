/**
 * @fileoverview generate-opencode.mjs — Emit opencode's overlay config: a
 * `provider` map whose every entry routes at the reverse-proxy route of its
 * upstream (docs/d063) — the shared cloud trio (opencode, opencode-go,
 * openrouter) is emitted UNCONDITIONALLY, never at a direct URL; a missing
 * provider would let opencode's built-in DIRECT definition carry the
 * traffic. The probe only picks each provider's lineup source, and
 * docs/d064's tiering decides whether a row is probed at all.
 *
 * The opencode-side generator, kept separate from the unified pi generator
 * (`generate-pi-coding-agent.mjs`) because it emits a different schema and
 * consumes a different input set — the merge is BY CODING AGENT: all pi
 * config in one generator, all opencode config in this one. Its provider
 * subset is lib/cloud-providers.mjs minus cline-pass/hyper.
 *
 * Lineup cascade: route listing → models.dev catalog slice (d049 modality
 * gate, then the provider's filter) → an empty lineup, still emitted
 * (docs/d063 §3). Peer-route mechanics: docs/d027. Merge/write contract:
 * lib/artifact.mjs.
 *
 * GOTCHA: opencode's V1 config puts the provider map under the top-level key
 * `provider` (**singular**) — `providers` is a V2 key the V1 loader rejects.
 *
 * Usage: node generate-opencode.mjs [out]
 *   out defaults to ./opencode.jsonc. generate.mjs passes a SCRATCH copy of
 *   the committed overlay as out and then installs the result to BOTH the
 *   host config dir (the sandbox's mount source) and the committed
 *   opencode.jsonc (docs/d065) — so the d064 local stale-preserve below,
 *   which reads the previous state through out, sees the last committed
 *   overlay under generate.mjs and the last out-file standalone.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	bearerHeaders,
	CLOUD_PROVIDERS as CLOUD_PROVIDER_FACTS,
	logError,
	logInfo,
	logWarn,
	modalitiesEligible,
	modelsDevCatalogPath,
	peerBaseUrls,
	peerProviderUrl,
	probeCandidates,
	probePeerRoutes,
	scriptDir,
	setLogTool,
	supportTier,
	writeJsonArtifact,
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

/**
 * The providers opencode ships natively, from the shared fact table
 * (docs/d024). ClinePass is deliberately absent: opencode has no built-in
 * cline-pass provider, and the cline-pass layer is owned exclusively by
 * generate-pi-coding-agent.mjs's full rows (docs/d022).
 * @type {readonly string[]}
 */
const CLOUD_PROVIDER_IDS = ["opencode", "opencode-go", "openrouter"];

/** @type {Record<string, import("../lib/cloud-providers.mjs").CloudProviderFacts>} */
const CLOUD_PROVIDERS = Object.fromEntries(
	CLOUD_PROVIDER_IDS.map((id) => [id, CLOUD_PROVIDER_FACTS[id]]),
);

/**
 * Peer candidates (docs/d027): vault-sourced peer bases for the LOCAL
 * llama-swap path-route and the CLOUD path-routes. Supports multi-hop proxy
 * chains (PEER_BASE_URLS comma/newline delimited). No localhost candidates —
 * the LAN :8080 (proxy) and :8101 (llama-swap) listen addresses are not
 * routable from outside the serving host (docs/d022).
 * @type {readonly string[]}
 */
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
 * The models.dev catalog slice for a provider — the lineup fallback when the
 * route cannot list (docs/d063 §2): the d049 modality gate first, then the
 * provider's model filter.
 * @param {string} id
 * @param {((id: string) => boolean)|undefined} filter
 * @returns {ModelEntry[]}
 */
function catalogModels(id, filter) {
	try {
		const catalog = JSON.parse(readFileSync(modelsDevCatalogPath(), "utf-8"));
		const models = catalog?.[id]?.models ?? {};
		return Object.keys(models)
			.filter((mid) => modalitiesEligible(models[mid]?.modalities))
			.filter((mid) => filter?.(mid) ?? true)
			.map((mid) => ({ id: mid }));
	} catch {
		return [];
	}
}

/**
 * Decide one cloud provider's route URL and lineup (docs/d063): the probe
 * picks the lineup source — the route's own listing, else the models.dev
 * catalog slice — and the URL is the probed route or the first proxy
 * candidate when nothing proved usable. Superficial rows (docs/d064) never
 * probe: catalog slice, first candidate.
 * @param {string} id
 * @returns {Promise<{ routeUrl: string, models: ModelEntry[] }>}
 */
async function resolveCloudProvider(id) {
	const cfg = CLOUD_PROVIDERS[id];
	const filter = PEER_MODEL_FILTERS[id];
	if (supportTier(id) === "superficial") {
		logInfo(
			"superficial provider — not route-probed (docs/d064), catalog lineup",
			{ provider: id },
		);
		return {
			routeUrl: peerProviderUrl(CLOUD_PEER_CANDIDATES[0], id),
			models: catalogModels(id, filter),
		};
	}
	const route = await probePeerRoutes(
		CLOUD_PEER_CANDIDATES,
		id,
		bearerHeaders(process.env[cfg.apiKeyEnv]?.trim()),
	);
	if (!route) {
		logWarn("no usable peer path-route — proxy reroute at the first candidate", {
			provider: id,
		});
	}
	// d063 §1: a dead/absent route never reverts to a direct URL — the first
	// candidate is proxy-only too, only the lineup degrades to the catalog.
	const routeUrl = route?.url ?? peerProviderUrl(CLOUD_PEER_CANDIDATES[0], id);
	const listed = (route?.entries ?? []).filter((e) => filter?.(e.id) ?? true);
	if (listed.length > 0) {
		return { routeUrl, models: listed };
	}
	const models = catalogModels(id, filter);
	if (models.length > 0) {
		logInfo("route unlistable — lineup from the models.dev catalog slice", {
			provider: id,
			models: models.length,
		});
	} else {
		logWarn("no lineup source resolved — proxy reroute with an empty lineup", {
			provider: id,
		});
	}
	return { routeUrl, models };
}

/**
 * Build an opencode provider entry routing `label`'s models through the
 * provider's peer host-form route on the cloud router (docs/d047):
 * baseURL is `<peerBase>/<upstream-host><base-path>`, auth is the provider's
 * REAL key env (the proxy forwards credentials untouched — it performs
 * none), and the model ids are the provider's own bare ids — from the
 * route's `/models` listing when it served one, else the catalog slice
 * (docs/d063).
 * @param {string} label
 * @param {string} routeUrl the provider's reverse-proxy path-route
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
/**
 * The `local` block from the previous overlay, when readable — the d064
 * first-class stale-preserve for the local lineup (a fresh lineup comes only
 * from the live probe; nothing else knows the farm's GGUFs).
 * @param {string} path the overlay about to be rewritten
 * @returns {OpenCodeProvider|null}
 */
function previousLocalProvider(path) {
	try {
		const overlay = JSON.parse(readFileSync(path, "utf-8"));
		const entry = overlay?.provider?.local;
		if (typeof entry?.options?.baseURL !== "string" || !entry.models) {
			return null;
		}
		return entry;
	} catch {
		return null;
	}
}

/** @returns {Promise<void>} */
async function main() {
	const out = process.argv[2] ?? join(scriptDir, "opencode.jsonc");

	// d063 fail closed: every emitted URL is a reverse-proxy route, so a
	// vault peer base is REQUIRED (SKIP_GEN=1 at the generate.mjs level is
	// the sanctioned bypass for hosts without vault env).
	if (!CLOUD_PEER_CANDIDATES.length) {
		logError(
			"no PEER_BASE_URL / PEER_BASE_URLS — proxy-only generation cannot proceed (docs/d063); load the vault env or set SKIP_GEN=1",
		);
		process.exit(1);
	}

	const local = await probeCandidates(LOCAL_SOURCE_CANDIDATES, (ids) =>
		ids.some((id) => classify(id) === "local"),
	);

	/** @type {Record<string, OpenCodeProvider>} */
	const providers = {};

	// --- 1. cloud providers: reverse-proxy routes, always emitted --------
	// d063: the trio is emitted UNCONDITIONALLY at proxy routes; the probe
	// only picks each provider's lineup source, and a dead route falls back
	// to the first candidate — never to a direct URL. Resolutions run in
	// parallel (each is one probe timeout at worst).
	const cloudResults = await Promise.allSettled(
		CLOUD_PROVIDER_IDS.map((id) =>
			resolveCloudProvider(id).then(
				(r) => ({ id, ...r }),
				// resolveCloudProvider is written not to throw, but the id must
				// survive any unexpected rejection or the provider silently loses
				// its reroute.
				(err) => {
					logWarn(
						"cloud resolution threw — proxy reroute with an empty lineup",
						{ provider: id, error: err },
					);
					return {
						id,
						routeUrl: peerProviderUrl(CLOUD_PEER_CANDIDATES[0], id),
						models: /** @type {ModelEntry[]} */ ([]),
					};
				},
			),
		),
	);

	for (const r of cloudResults) {
		if (r.status !== "fulfilled") continue; // rejection already handled + logged above
		const { id, routeUrl, models } = r.value;
		providers[id] = peerProvider(
			CLOUD_PROVIDERS[id].label,
			routeUrl,
			CLOUD_PROVIDERS[id].apiKeyEnv,
			models,
		);
	}

	// --- 2. local GGUF ---------------------------------------------------
	if (local) {
		const models = local.entries.filter((e) => classify(e.id) === "local");
		if (models.length > 0) {
			// The LOCAL llama-swap face keeps its own OpenAI surface (/v1) and
			// its model-id routing — llama-swap is still what swaps GGUFs
			// (docs/d027) — and llama-swap's own bearer key guards it. The
			// probed baseUrl is already the funnel's llama-swap route (the
			// stable logical name, not a loopback host — docs/d047);
			// appending /v1 gives <peerBase>/llama-swap/v1, which the proxy
			// forwards to the local instance as /v1/… (docs/d047).
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
		// d064 first-class stale-preserve: the local lineup exists nowhere
		// else, so when the funnel cannot list it the previous entry is
		// carried forward instead of dropping `local` from the overlay.
		const previous = previousLocalProvider(out);
		if (previous) {
			providers.local = previous;
			logWarn(
				"no local GGUF source reachable — carrying the previous local entry forward",
				{
					baseURL: previous.options.baseURL,
					models: Object.keys(previous.models).length,
				},
			);
		} else {
			logInfo("no local GGUF source reachable — omitting local provider");
		}
	}

	const written = writeJsonArtifact(out, { provider: providers });
	const summary = Object.entries(providers)
		.map(
			([id, p]) =>
				`${id}=${p.options.baseURL}(${Object.keys(p.models).length})`,
		)
		.join(", ");
	logInfo("wrote opencode config", { path: written, providers: summary });
}

main().catch((err) => {
	logError("opencode generator failed — nothing written", { error: err });
	process.exit(1);
});
