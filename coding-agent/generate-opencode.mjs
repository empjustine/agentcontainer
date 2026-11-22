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
 *   opencode.jsonc (docs/d065) — the reviewed snapshot. Nothing reads the
 *   previous state back through out any more (docs/d190 retired the d064
 *   local stale-preserve), so a fresh output dir is enough.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	catalogModelLive,
	cloudProvidersPath,
	modalitiesEligible,
	scriptDir,
} from "./gen-lib.mjs";
import { writeJsonArtifact } from "./lib/artifact.mjs";
import { providerFacts, readCloudProviders } from "./lib/cloud-providers.mjs";
import { exitCodeOf } from "./lib/failure.mjs";
import { logError, logInfo, logWarn, setLogTool } from "./lib/log.mjs";
import {
	bearerHeaders,
	probeCandidates,
	probeEndpoint,
} from "./route-probe.mjs";

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

/** @typedef {import("./generate-pi-coding-agent.mjs").ModelsDevModel} ModelsDevModel */

/**
 * The models.dev catalog slice for a provider — the lineup fallback when the
 * route cannot list (docs/d063 §2): the d049 modality gate first, then the
 * provider's model filter.
 * @param {Record<string, { models?: Record<string, ModelsDevModel> }>|null} catalog
 *   the run's parsed models.dev catalog, read once by main
 * @param {string} id
 * @param {((id: string) => boolean)|undefined} filter
 * @returns {ModelEntry[]}
 */
function catalogModels(catalog, id, filter) {
	// An absent catalog is the manual-run case, not an error: the route's own
	// answer is the lineup then (docs/d191).
	const models = catalog?.[id]?.models ?? {};
	return Object.keys(models)
		// A retired catalog entry never publishes (docs/d048).
		.filter((mid) => catalogModelLive(models[mid]))
		.filter((mid) => modalitiesEligible(models[mid]?.modalities))
		.filter((mid) => filter?.(mid) ?? true)
		.map((mid) => ({ id: mid }));
}

/**
 * The lineup one cloud provider publishes: its live listing when the endpoint
 * serves one, else the models.dev catalog slice (docs/d108). Superficial rows
 * (docs/d064) never probe. Every input arrives as a value — this function
 * reads no table and no env of its own.
 * @param {import("./lib/cloud-providers.mjs").CloudProviderFacts} facts
 * @param {Record<string, { models?: Record<string, ModelsDevModel> }>|null} catalog
 * @param {string|undefined} apiKey the provider's key, from the caller's env
 * @param {boolean} tlsDisabled the runtime TLS state, from the caller
 * @returns {Promise<ModelEntry[]>}
 */
async function resolveCloudModels(facts, catalog, apiKey, tlsDisabled) {
	const filter = MODEL_SCOPES[facts.id];
	if (facts.support === "superficial") {
		logInfo(
			"superficial provider — not route-probed (docs/d064), catalog lineup",
			{ provider: facts.id },
		);
		return catalogModels(catalog, facts.id, filter);
	}
	const route = await probeEndpoint(
		facts.baseUrl,
		bearerHeaders(apiKey?.trim()),
		tlsDisabled,
	);
	if (!route.usable) {
		logWarn(
			"no usable endpoint — lineup degrades to the catalog (docs/d108)",
			{ provider: facts.id },
		);
	}
	// The probe only selects the LINEUP source; the emitted URL is the
	// canonical fact-table upstream either way.
	const listed = route.entries.filter((e) => filter?.(e.id) ?? true);
	if (listed.length > 0) {
		return listed;
	}
	const models = catalogModels(catalog, facts.id, filter);
	if (models.length > 0) {
		logInfo("route unlistable — lineup from the models.dev catalog slice", {
			provider: facts.id,
			models: models.length,
		});
	} else {
		logWarn("no lineup source resolved — empty lineup", {
			provider: facts.id,
		});
	}
	return models;
}

/**
 * One opencode provider entry: display `name`, the URL the client addresses,
 * the env var holding the provider's own key, and its bare model ids
 * (docs/d063). Values in, values out — no table lookup, so a caller sees
 * exactly which row it is emitting.
 * @param {string} name the entry's display name
 * @param {string} baseUrl the provider's canonical upstream (docs/d070)
 * @param {string} apiKeyEnv the provider's own key env (fact table `apiKeyEnv`)
 * @param {ModelEntry[]} models
 * @returns {OpenCodeProvider}
 */
function opencodeProvider(name, baseUrl, apiKeyEnv, models) {
	return {
		name,
		env: [apiKeyEnv],
		npm: "@ai-sdk/openai-compatible",
		options: { baseURL: baseUrl },
		models: Object.fromEntries(models.map((e) => [e.id, { name: e.id }])),
	};
}

/**
 * THE entry point: the env, the argv and both files are read here and passed
 * down; everything below is a function of those values.
 * @returns {Promise<void>}
 */
async function main() {
	setLogTool("coding-agent/generate-opencode");
	const env = process.env;
	const out = process.argv[2] ?? join(scriptDir, "opencode.jsonc");

	// The dir this run owns: generate.mjs points $PI_LAYER_DIR at its per-run
	// output dir, and a manual run lands beside its own sources. The models.dev
	// catalog the run fetched sits there beside the layers (docs/d191) — a
	// manual run simply has none, which the cascade treats as "no fallback".
	const runDir = env.PI_LAYER_DIR ?? scriptDir;
	/** @type {Record<string, { models?: Record<string, ModelsDevModel> }>|null} */
	let catalog = null;
	try {
		catalog = JSON.parse(
			readFileSync(join(runDir, "models.dev.api.json"), "utf-8"),
		);
	} catch {
		// Absent is the manual-run case, not an error (docs/d191).
	}

	const cloudProviders = readCloudProviders(cloudProvidersPath);
	const tlsDisabled = env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
	if (tlsDisabled) {
		logWarn(
			"TLS verification disabled (NODE_TLS_REJECT_UNAUTHORIZED=0) — https endpoints fail closed; only plain-http emergency bases are used",
		);
	}

	// The farm's row, read once here: its tsnet serve hostname is the probe
	// candidate and the emitted base (plus /v1), and its apiKeyEnv is the key
	// the entry names. The LAN port is not routable from outside the serving
	// host (docs/d022).
	const farm = providerFacts(cloudProviders, "llama-swap");
	const farmKey = env[farm.apiKeyEnv];
	const local = await probeCandidates(
		[farm.baseUrl],
		(ids) => ids.some((id) => classify(id) === "local"),
		bearerHeaders(farmKey?.trim()),
		tlsDisabled,
	);

	/** @type {Record<string, OpenCodeProvider>} */
	const providers = {};

	// --- 1. cloud providers: canonical routes, always emitted -----------
	// d063: the trio is emitted UNCONDITIONALLY at its canonical upstream; the
	// probe only picks each provider's lineup source. A resolution that throws
	// still publishes the row (an omitted provider is how a direct URL gets
	// back in), so the catch turns it into an empty lineup. Resolutions run in
	// parallel (each is one probe timeout at worst).
	await Promise.all(
		CLOUD_PROVIDER_IDS.map(async (id) => {
			const facts = providerFacts(cloudProviders, id);
			const models = await resolveCloudModels(
				facts,
				catalog,
				env[facts.apiKeyEnv],
				tlsDisabled,
			).catch((err) => {
				logWarn(
					"cloud resolution threw — canonical base with an empty lineup",
					{ provider: facts.id, error: err },
				);
				return /** @type {ModelEntry[]} */ ([]);
			});
			providers[facts.id] = opencodeProvider(
				`Proxy: ${facts.label}`,
				facts.baseUrl,
				facts.apiKeyEnv,
				models,
			);
		}),
	);

	// --- 2. local GGUF ---------------------------------------------------
	// The farm answers for itself or not at all (docs/d190): an unreachable
	// endpoint publishes an empty lineup, and a visible endpoint with no GGUF
	// rows omits the provider entirely.
	const localModels = local
		? local.entries.filter((e) => classify(e.id) === "local")
		: [];
	if (local && localModels.length === 0) {
		logInfo("no local GGUF models visible — omitting local provider");
	} else {
		if (!local) {
			logWarn(
				"no local GGUF source reachable — the local lineup is empty (docs/d190)",
			);
		}
		// The local face keeps its own OpenAI surface (/v1) — llama-swap is
		// still what swaps GGUFs (docs/d027) — and the tlalocayotl row's own
		// key guards it. The emitted URL is canonical (docs/d070): the fact
		// table's upstream plus /v1, with no install-time rewrite (docs/d108).
		providers.local = opencodeProvider(
			"Proxy: Local LLM",
			`${farm.baseUrl}/v1`,
			farm.apiKeyEnv,
			localModels,
		);
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

if (import.meta.main) {
	main().catch((error) => {
		// One handler (docs/d225 R3): log once, set the status, return.
		const exitCode = exitCodeOf(error);
		if (exitCode === undefined) {
			logError("opencode generator failed — nothing written", {
				error: String(error?.stack ?? error),
			});
			process.exitCode = 1;
		} else {
			logError(error.message, error.fields ?? {});
			process.exitCode = exitCode;
		}
	});
}
