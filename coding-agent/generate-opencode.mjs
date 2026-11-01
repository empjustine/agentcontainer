/**
 * @fileoverview generate-opencode.mjs — Emit opencode's overlay config: a
 * `provider` map whose every entry addresses its upstream's canonical URL
 * (docs/d070/d108) — the shared cloud trio (opencode, opencode-go,
 * openrouter) is emitted UNCONDITIONALLY; a missing provider would let
 * opencode's built-in DIRECT definition carry the traffic. The probe only
 * picks each provider's lineup source, and docs/d064's tiering decides
 * whether a row is probed at all. Reachability comes from the environment
 * proxy (docs/d074).
 *
 * The opencode-side generator, kept separate from the unified pi generator
 * (`generate-pi-coding-agent.mjs`) because it emits a different schema and
 * consumes a different input set — the merge is BY CODING AGENT: all pi
 * config in one generator, all opencode config in this one. Its provider
 * subset is lib/cloud-providers.mjs minus cline-pass/hyper.
 *
 * Lineup cascade: live listing → models.dev catalog slice (d049 modality
 * gate, then the provider's filter) → an empty lineup, still emitted
 * (docs/d063 §3). Probe mechanics: route-probe.mjs. Merge/write contract:
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
	providerFacts,
	logError,
	logInfo,
	logWarn,
	modalitiesEligible,
	modelsDevCatalogPath,
	probeCandidates,
	probeEndpoint,
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

/**
 * The LOCAL row's probe candidate: its canonical fact-table upstream (the
 * tsnet serve hostname), reached over the tailnet directly (docs/d108) —
 * the LAN :8080 proxy listen address is not routable from outside the
 * serving host (docs/d022) and is not what clients address any more.
 * @type {readonly string[]}
 */
const LOCAL_SOURCE_CANDIDATES = [providerFacts("llama-swap").baseUrl];

/**
 * Classify a LOCAL llama-swap catalog model id (docs/d027: cloud ids are no
 * longer classified — each cloud provider's route returns its own
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
	if (id.includes("-GGUF")) {
		return "local";
	}
	return null;
}

/**
 * Per-provider scoping of the override's model list (same slices the pi-side
 * generator applies — see its MODEL_SCOPES): openrouter keeps the
 * ":free" slice; opencode / opencode-go take everything their route serves.
 * @type {Record<string, ((id: string) => boolean)|undefined>}
 */
const MODEL_SCOPES = {
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
 * Resolve one cloud provider's emitted URL and lineup (docs/d108):
 * the probe picks the lineup source — the live listing, else the models.dev
 * catalog slice — and the URL is always the CANONICAL fact-table upstream.
 * Superficial rows
 * (docs/d064) never probe: catalog slice, canonical URL either way.
 * @param {string} id
 * @returns {Promise<{ providerUrl: string, models: ModelEntry[] }>}
 */
async function resolveCloudProvider(id) {
	const cfg = providerFacts(id);
	const filter = MODEL_SCOPES[id];
	if (supportTier(id) === "superficial") {
		logInfo(
			"superficial provider — not route-probed (docs/d064), catalog lineup",
			{ provider: id },
		);
		return {
			providerUrl: cfg.baseUrl,
			models: catalogModels(id, filter),
		};
	}
	const route = await probeEndpoint(
		cfg.baseUrl,
		bearerHeaders(process.env[cfg.apiKeyEnv]?.trim()),
	);
	if (!route.usable) {
		logWarn(
			"no usable endpoint — lineup degrades to the catalog (docs/d108)",
			{ provider: id },
		);
	}
	// The probe only selects the LINEUP source; the emitted URL is the
	// canonical fact-table upstream either way.
	const providerUrl = cfg.baseUrl;
	const listed = route.entries.filter((e) => filter?.(e.id) ?? true);
	if (listed.length > 0) {
		return { providerUrl, models: listed };
	}
	const models = catalogModels(id, filter);
	if (models.length > 0) {
		logInfo("route unlistable — lineup from the models.dev catalog slice", {
			provider: id,
			models: models.length,
		});
	} else {
		logWarn("no lineup source resolved — empty lineup", {
			provider: id,
		});
	}
	return { providerUrl, models };
}

/**
 * Build an opencode provider entry for `label`'s models on the cloud router
 * (docs/d047): baseURL is the provider's URL — CANONICAL fact-table upstream
 * in the committed artifact (docs/d070), rewritten to the client route at
 * install —, auth is the provider's
 * REAL key env (the proxy forwards credentials untouched — it performs
 * none), and the model ids are the provider's own bare ids — from the
 * route's `/models` listing when it served one, else the catalog slice
 * (docs/d063).
 * @param {string} label
 * @param {string} providerUrl the provider's canonical upstream URL
 * @param {string} apiKeyEnv the provider's real key env (shared fact table)
 * @param {ModelEntry[]} models
 * @returns {OpenCodeProvider}
 */
function routedProvider(label, providerUrl, apiKeyEnv, models) {
	return {
		name: `Proxy: ${label}`,
		env: [apiKeyEnv],
		npm: "@ai-sdk/openai-compatible",
		options: { baseURL: providerUrl },
		models: Object.fromEntries(models.map((e) => [e.id, { name: e.id }])),
	};
}

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
						"cloud resolution threw — canonical base with an empty lineup",
						{ provider: id, error: err },
					);
					return {
						id,
						providerUrl: providerFacts(id).baseUrl,
						models: /** @type {ModelEntry[]} */ ([]),
					};
				},
			),
		),
	);

	for (const r of cloudResults) {
		if (r.status !== "fulfilled") {
			continue; // rejection already handled + logged above
		}
		const { id, providerUrl, models } = r.value;
		providers[id] = routedProvider(
			providerFacts(id).label,
			providerUrl,
			providerFacts(id).apiKeyEnv,
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
			// EMITTED URL is canonical (docs/d070): the fact table's llama-swap
			// upstream (the tsnet serve hostname, rooted — no path prefix) plus
			// /v1, which install rewrites to `<base>/<host>/v1`. The probe above
			// only picked the lineup.
			providers.local = routedProvider(
				"Local LLM",
				`${providerFacts("llama-swap").baseUrl}/v1`,
				"REVERSE_PROXY_API_KEY",
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
