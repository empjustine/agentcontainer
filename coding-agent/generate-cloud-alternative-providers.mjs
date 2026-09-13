/**
 * @fileoverview generate-cloud-alternative-providers.mjs — Emit the pi overlay
 * layers for the cloud ALTERNATIVE providers pi does NOT ship natively
 * (cline-pass / hyper / inferx). Because pi has no built-in definition for any
 * of them, this layer is the ONLY source of the full provider block and is
 * always emitted in full — the opposite of the override-only semantic in
 * generate-cloud-pi-native-providers.mjs (docs/d024). The table-driven set is
 * PROVIDER_SPECS below; one row = one emitted layer.
 *
 * Detection cascade, reachability rule, the exact emitted field/spec mirrors
 * (cline-pass/hyper/inferx quirks, hyper facts cache, known models.dev drift,
 * extension-only features) all live in docs/d033 — this header deliberately
 * does not duplicate them. Merge contract: merge-models-json.mjs.
 *
 * Usage: node generate-cloud-alternative-providers.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Shared lib/ helpers (docs/d023): structured logger, artifact writer, HTTP
// probe toolkit, hyper facts cache — all via the LIB_DIR convention.
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
const { bearerHeaders, peerBaseUrl, probePeerRoutes, probeDirect, fetchModelEntries } =
	/** @type {typeof import("../lib/peer-probe.mjs")} */ (
		await import(`${LIB_DIR}/peer-probe.mjs`)
	);
const { loadHyperFacts, refreshHyperFacts } =
	/** @type {typeof import("../lib/hyper-facts.mjs")} */ (
		await import(`${LIB_DIR}/hyper-facts.mjs`)
	);
setLogTool("coding-agent/generate-cloud-alternative");

const OPENAI_COMPLETIONS_API = "openai-completions";
// Catalog lookup order: a models.dev.api.json next to this script wins — when
// run from generate.sh's scratch dir that entry is a symlink to the vendored
// catalog which the best-effort refresh replaces with the freshly fetched
// copy, so the generator always reads what this run validated.  Manual
// in-place runs fall back to the shared vendored catalog (docs/d023).
const API_JSON =
	process.env.MODELS_DEV_JSON ??
	(existsSync(join(scriptDir, "models.dev.api.json"))
		? join(scriptDir, "models.dev.api.json")
		: join(LIB_DIR, "models.dev.api.json"));

// Peer base — vault-sourced (peerBaseUrl(); see the header there).  No
// localhost candidates — the LAN :8080 (llm-reverse-proxy) and :8101
// (llama-swap) listen addresses are not routable from outside the serving
// host (docs/d022).
const CLOUD_PEER_CANDIDATES = [peerBaseUrl()];

/**
 * The alternative-provider table: one row per provider pi does not ship
 * natively. Adding support for a new one is a row here plus a merge-order
 * row in merge-models-json.mjs's header — everything else (catalog load,
 * cascade, peer normalization, layer emission) is generic.
 * @typedef {object} AlternativeProviderSpec
 * @property {string} id models.dev provider key AND pi provider id
 * @property {string} name display name for the pi provider block
 * @property {string} file output layer filename (relative to this script);
 *   numbered into merge-models-json.mjs's lexical merge order (zero-padded,
 *   after model-015)
 * @property {string} envKey the provider's own key variable (from the
 *   catalog's `env`) — referenced as `$<envKey>` in the emitted layer, and
 *   read here only for the direct probe
 * @property {{ supportsDeveloperRole: boolean }|null} compat provider-level
 *   compat pi cannot infer (null = no override)
 * @property {((m: ModelsDevModel) => Record<string, unknown>|null)|null} modelCompat
 *   builds the per-model compat mirror (null = none)
 * @property {boolean} onOffThinking swaps the all-null effort-less map for
 *   the ON_OFF representative map (see header)
 * @property {boolean} [enrichFromFacts] refresh + consume the lib/hyper-facts
 *   cache (hyper only — the one provider with a non-models.dev cache)
 * @property {Record<string, string>} [headers] provider-level request headers
 */
/** @type {AlternativeProviderSpec[]} */
const PROVIDER_SPECS = [
	{
		id: "cline-pass",
		name: "ClinePass",
		file: "model-015-cloud-cline-pass.json",
		envKey: "CLINE_API_KEY",
		// ClinePass rejects the `developer` role pi-ai emits for reasoning
		// models (see header): both reference extensions force it off.
		compat: { supportsDeveloperRole: false },
		modelCompat: null,
		onOffThinking: false,
	},
	{
		id: "hyper",
		name: "Charm Hyper",
		file: "model-016-cloud-hyper.json",
		envKey: "HYPER_API_KEY",
		// Standard OpenAI-compatible gateway: the vendor extension accepts the
		// default role handling, so no provider-level compat override.
		compat: null,
		// Per-model compat mirror of charmbracelet/pi-hyper-provider
		// src/models.ts (see header): the full block on EVERY model, exactly
		// like the extension.
		modelCompat: (m) => ({
			supportsStore: false,
			supportsReasoningEffort: effortValues(m).size > 0,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		}),
		// Pair the deepseek thinking format with the extension's ON_OFF map
		// for effort-less reasoning models — see the header note.
		onOffThinking: true,
		// The one non-models.dev enrichment source: refresh + consume
		// lib/hyper-facts (see header + lib/hyper-facts.mjs).
		enrichFromFacts: true,
		headers: {
			// Mirror of the extension's "pi-hyper-provider/<version>" UA
			// (models.json headers are static literals; versioning is
			// extension-only).
			"User-Agent": "pi-hyper-models-layer/1",
		},
	},
	{
		id: "inferx",
		name: "InferX",
		file: "model-017-cloud-inferx.json",
		envKey: "INFERX_API_KEY",
		// Plain OpenAI-compatible gateway (models.dev: @ai-sdk/openai-compatible):
		// no developer-role quirk (unlike cline-pass), no per-model wire-compat
		// mirror (unlike hyper) — pi's defaults are correct as-is.
		compat: null,
		modelCompat: null,
		// Reasoning models expose only a `toggle` option (no effort enum), so
		// there is nothing to map: no thinkingLevelMap, no ON_OFF fallback —
		// pi's default on/off handling covers them.
		onOffThinking: false,
	},
];

/**
 * Map models.dev `reasoning_options` effort values onto pi thinking levels
 * (off, minimal, low, medium, high, xhigh, max). ClinePass exposes enums like
 * ["none","low","medium","high","xhigh"] and Hyper (e.g. inkling) like
 * ["none","minimal","low","medium","high","xhigh"]; "none" disables thinking
 * (pi "off"), the rest map 1:1. Levels absent from the provider enum are
 * marked unsupported (null) so they are hidden in /model and pi never sends
 * an out-of-enum value.
 * @type {Record<string, string>}
 */
const EFFORT_TO_PI = {
	none: "off",
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Thinking map for reasoning models that expose NO effort enum (Hyper's
 * glm-5, kimi-k2-thinking, ...): the charmbracelet/pi-hyper-provider
 * ON_OFF_THINKING_LEVEL_MAP — pi "max" is the single representative "on"
 * state, "off" disables thinking. Only valid for providers that pair it
 * with thinkingFormat: "deepseek" + supportsReasoningEffort: false (the
 * wire translation then drops efforts entirely).
 * @type {Readonly<Record<string, string|null>>}
 */
const ON_OFF_THINKING_LEVEL_MAP = Object.freeze({
	off: "off",
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
});

/**
 * The model's reasoning-effort enum as a lowercase set (empty when the model
 * exposes none). Accepts any record carrying `reasoning_options` (full
 * models.dev records as well as the bare shape buildThinkingLevelMap passes).
 * @param {{ reasoning_options?: Array<{ type?: string, values?: string[] }> }} m
 * @returns {Set<string>}
 */
function effortValues(m) {
	const values = new Set();
	for (const opt of m?.reasoning_options ?? []) {
		if (opt?.type === "effort" && Array.isArray(opt.values)) {
			for (const v of opt.values) values.add(String(v).toLowerCase());
		}
	}
	return values;
}

/**
 * A models.dev model record — the subset this generator reads.
 * @typedef {object} ModelsDevModel
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [reasoning]
 * @property {{ input?: string[] }} [modalities]
 * @property {{ context?: number, output?: number }} [limit]
 * @property {{ input?: number, output?: number, cache_read?: number, cache_write?: number }} [cost]
 * @property {Array<{ type?: string, values?: string[] }>} [reasoning_options]
 */

/**
 * A pi-shaped model entry as this generator publishes it.  Only the first
 * three fields are guaranteed: peer-served ids with no models.dev equivalent
 * are published minimal (the rest falls back to pi's defaults).
 * @typedef {object} PiAlternativeModel
 * @property {string} id
 * @property {boolean} reasoning
 * @property {string[]} input
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number }} [cost]
 * @property {Record<string, string|null>} [thinkingLevelMap]
 * @property {Record<string, unknown>} [compat]
 */

/**
 * A models.json provider layer for one alternative provider.
 * @typedef {object} ProviderBlock
 * @property {Record<string, { name: string, baseUrl: string, api: string, apiKey: string, authHeader?: boolean, headers?: Record<string, string>, compat?: { supportsDeveloperRole: boolean }, models: PiAlternativeModel[] }>} providers
 */

/**
 * @param {Array<{ type?: string, values?: string[] }>} [reasoningOptions]
 * @returns {Record<string, string|null>|null} the map, or null when the model
 *   exposes no effort enum (callers decide the fallback, e.g. ON_OFF thinking)
 */
function buildThinkingLevelMap(reasoningOptions) {
	const values = effortValues({ reasoning_options: reasoningOptions });
	if (values.size === 0) return null;
	/** @type {Record<string, string|null>} */
	const map = {};
	for (const level of PI_LEVELS) {
		const effort = Object.keys(EFFORT_TO_PI).find(
			(e) => EFFORT_TO_PI[e] === level,
		);
		map[level] = effort && values.has(effort) ? effort : null;
	}
	return map;
}

/**
 * pi's input schema accepts only "text" and "image"; video/audio/... are dropped.
 * @param {string[]} [modalitiesInput]
 * @returns {string[]}
 */
function toInput(modalitiesInput) {
	const set = new Set(modalitiesInput ?? ["text"]);
	const out = [];
	if (set.has("text")) out.push("text");
	if (set.has("image")) out.push("image");
	return out.length ? out : ["text"];
}

/**
 * @param {ModelsDevModel["cost"]} cost
 * @returns {PiAlternativeModel["cost"]}
 */
function toCost(cost) {
	if (!cost) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cache_read ?? 0,
		cacheWrite: cost.cache_write ?? 0,
	};
}

/**
 * Build the pi-shaped model entry for one models.dev model of provider
 * `spec.id`.  `id` is the fully-qualified model id to publish; the default
 * keeps the catalog's own id (ClinePass catalog ids are already
 * `cline-pass/<modelId>`; Hyper's are bare — both are published verbatim in
 * direct mode, since pi namespaces them under the provider id itself).
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @param {ModelsDevModel} m a models.dev model record
 * @param {string} [id] the id to publish (defaults to the record's own id)
 * @returns {PiAlternativeModel} a pi model entry
 */
function piModel(spec, m, id = m.id) {
	if (m.family === "text-embedding" || id.toLowerCase().includes("embedding")) return null;
	/** @type {PiAlternativeModel} */
	const model = {
		id,
		name: m.name ?? id,
		reasoning: m.reasoning === true,
		input: toInput(m.modalities?.input),
		contextWindow: m.limit?.context ?? 128000,
		maxTokens: m.limit?.output ?? 16384,
		cost: toCost(m.cost),
	};
	if (model.reasoning) {
		const map = buildThinkingLevelMap(m.reasoning_options);
		const thinking =
			map ?? (spec.onOffThinking ? { ...ON_OFF_THINKING_LEVEL_MAP } : null);
		if (thinking) model.thinkingLevelMap = thinking;
	}
	const compat = spec.modelCompat?.(m);
	if (compat) model.compat = compat;
	return model;
}

/**
 * Load one provider's slice of the vendored models.dev catalog.
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @returns {{ api: string, models: Record<string, ModelsDevModel> }} the
 *   models.dev provider record (api endpoint + per-model metadata)
 */
function loadProvider(spec) {
	const catalog = JSON.parse(readFileSync(API_JSON, "utf-8"));
	const provider = catalog[spec.id];
	if (!provider)
		throw new Error(`provider ${spec.id} not found in ${API_JSON}`);
	return /** @type {{ api: string, models: Record<string, ModelsDevModel> }} */ (
		provider
	);
}

/**
 * Strip any number of repeated `<providerId>/` prefixes from an id (defensive
 * normalization shared by the facts-cache matching below; the llama-swap-era
 * FQN spellings motivated it — docs/d027).
 * @param {string} providerId
 * @param {string} peerId
 * @returns {string} the bare model id
 */
function stripProviderPrefixes(providerId, peerId) {
	let s = peerId;
	while (s.startsWith(`${providerId}/`)) s = s.slice(providerId.length + 1);
	return s;
}

/**
 * Build the provider block routed at `baseUrl` with the given key/auth.
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @param {string} baseUrl
 * @param {PiAlternativeModel[]} models
 * @param {{ apiKey: string, authHeader?: boolean }} auth
 * @returns {ProviderBlock} a models.json provider layer for the provider
 */
function providerBlock(spec, baseUrl, models, auth) {
	return {
		providers: {
			[spec.id]: {
				name: spec.name,
				baseUrl,
				api: OPENAI_COMPLETIONS_API,
				apiKey: auth.apiKey,
				...(auth.authHeader ? { authHeader: true } : {}),
				...(spec.headers ? { headers: spec.headers } : {}),
				...(spec.compat ? { compat: spec.compat } : {}),
				models,
			},
		},
	};
}

/**
 * Rebuild a raw lib/hyper-facts (live /provider) record as a models.dev-shaped
 * model record, so the enrichment reuses piModel()'s full derivation (input,
 * costs, effort-enum → thinkingLevelMap/compat). Fields pi models but the
 * live record lacks stay undefined → piModel()'s defaults; the display name
 * is overridden back to the models.dev one by the enricher (names stay
 * catalog — see the header whitelist note).
 * @param {import("../lib/hyper-facts.mjs").HyperProviderModel} l a raw live /provider record
 * @returns {ModelsDevModel} a models.dev-shaped record with live facts
 */
function liveToCatalogRecord(l) {
	const levels = (l.reasoning_levels ?? []).map((v) => String(v).toLowerCase());
	return {
		id: l.id,
		name: l.name ?? l.id,
		reasoning: l.can_reason === true,
		modalities: {
			input: l.supports_attachments === true ? ["text", "image"] : ["text"],
		},
		limit: {
			context: l.context_window,
			output: l.default_max_tokens,
		},
		// Hyper's /provider prices cached INPUT and cached OUTPUT separately;
		// models.dev files at most one of them per model — the live values win
		// (docs-consistent: cached-in → cache_write, cached-out → cache_read).
		cost: {
			input: l.cost_per_1m_in ?? 0,
			output: l.cost_per_1m_out ?? 0,
			cache_read: l.cost_per_1m_out_cached ?? 0,
			cache_write: l.cost_per_1m_in_cached ?? 0,
		},
		reasoning_options: levels.length
			? [{ type: "effort", values: levels }]
			: [],
	};
}

/**
 * Enrich pi-shaped models with the provider's live /models listing.
 * This is used to prune models no longer served and add new ones found live
 * but missing from the catalog. Since live entries lack full metadata,
 * new models are published as minimal entries (pi defaults).
 * @param {AlternativeProviderSpec} spec
 * @param {PiAlternativeModel[]} models the current catalog-derived lineup
 * @param {RawModelEntry[]} liveEntries the listing from the provider's /models endpoint
 * @returns {PiAlternativeModel[]} the pruned and augmented lineup
 */
function enrichWithLiveListing(spec, models, liveEntries) {
	const liveIds = new Set(liveEntries.map((e) => stripProviderPrefixes(spec.id, e.id)));
	const catalogIds = new Set(models.map((m) => stripProviderPrefixes(spec.id, m.id)));

	const pruned = models.filter((m) => liveIds.has(stripProviderPrefixes(spec.id, m.id)));

	const liveOnly = liveEntries
		.filter((e) => !catalogIds.has(stripProviderPrefixes(spec.id, e.id)))
		.map((e) => {
			const m = {
				id: e.id,
				name: e.name ?? e.id,
			};
			return piModel(spec, m);
		})
		.filter((m) => m !== null);

	return [...pruned, ...liveOnly];
}

/**
 * Enrich pi-shaped models with the hyper facts cache: rebuild every model
 * whose (prefix-stripped) id is in the live records through piModel() on
 * LIVE data, keeping the models.dev display name (see the header whitelist).
 * Models absent from the cache pass through untouched; live-only records are
 * returned for the caller to append (direct mode appends them, peer mode
 * appends only ids the peer actually serves).
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @param {PiAlternativeModel[]} models the models to enrich
 * @param {import("../lib/hyper-facts.mjs").LoadedHyperFacts} facts loaded cache
 * @returns {{ enriched: PiAlternativeModel[], liveOnly: ModelsDevModel[], untouched: PiAlternativeModel[] }}
 */
function enrichWithFacts(spec, models, facts) {
	const live = new Map(
		facts.models.map((l) => [stripProviderPrefixes(spec.id, l.id), l]),
	);
	const enriched = [];
	const untouched = [];
	for (const m of models) {
		const l = live.get(stripProviderPrefixes(spec.id, m.id));
		if (!l) {
			untouched.push(m);
			continue;
		}
		const merged = { ...liveToCatalogRecord(l), name: m.name };
		enriched.push(piModel(spec, merged, m.id));
	}
	const servedIds = new Set(
		models.map((m) => stripProviderPrefixes(spec.id, m.id)),
	);
	const liveOnly = facts.models
		.filter((l) => !servedIds.has(stripProviderPrefixes(spec.id, l.id)))
		.map((l) => liveToCatalogRecord(l));
	return { enriched, liveOnly, untouched };
}

/**
 * Run the per-provider detection cascade and emit that provider's layer.
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @returns {Promise<void>}
 */
async function emitProvider(spec) {
	const provider = loadProvider(spec);
	const allModels = Object.values(provider.models)
		.map((m) => piModel(spec, m))
		.filter((m) => m !== null);

	// --- 1. real endpoint first -----------------------------------------
	// Any non-unreachable response proves the network path works — including a
	// 401/403 credential-gate (this generator runs without provider keys by
	// design; pi authenticates itself at request time) — so keep the real
	// route.  Only a total absence of http response switches to the peer.
	const real = await probeDirect(
		provider.api,
		bearerHeaders(process.env[spec.envKey]?.trim()),
	);
	if (real.result !== "unreachable") {
		let models = allModels;

		// Special case: InferX (and potentially others) provide a /models endpoint
		// that we can use to prune and augment the catalog lineup if the key is available.
		if (process.env[spec.envKey]) {
			try {
				const liveEntries = await fetchModelEntries(
					provider.api,
					bearerHeaders(process.env[spec.envKey].trim()),
				);
				models = enrichWithLiveListing(spec, models, liveEntries);
				logInfo(`${spec.id} lineup synchronized with live /models listing`, {
					liveCount: liveEntries.length,
					finalCount: models.length,
				});
			} catch (err) {
				logWarn(`${spec.id} live listing fetch failed — falling back to catalog`, {
					error: err.message,
				});
			}
		}

		if (spec.enrichFromFacts) {
			await refreshHyperFacts();
			const facts = loadHyperFacts();
			const { enriched, liveOnly, untouched } = enrichWithFacts(
				spec,
				models,
				facts,
			);
			models = [...enriched, ...untouched];
			if (liveOnly.length) {
				models = [...models, ...liveOnly.map((r) => piModel(spec, r))];
			}
			logInfo(`${spec.id} enriched from facts cache`, {
				fetchedAt: facts.fetchedAt,
				ageMs: facts.ageMs,
				enriched: enriched.length,
				liveOnlyAppended: liveOnly.length,
				catalogOnlyKept: untouched.length,
			});
		}
		logInfo(`${spec.id} reachable — emitting real route`, {
			baseUrl: provider.api,
			models: models.length,
			outcome: real.result,
			...(real.error ? { error: real.error } : {}),
		});
		write(
			providerBlock(spec, provider.api, models, {
				apiKey: `$${spec.envKey}`,
				authHeader: true,
			}),
			spec,
		);
		return;
	}

	// --- 2. real endpoint unreachable — try the peer path-route ---------
	logInfo(`${spec.id} endpoint unreachable — probing peer path-route`, {
		error: real.error,
	});
	// Same key the direct probe uses (and the emitted block references): the
	// simplified router forwards credentials untouched, so peer mode is
	// authenticated with the provider's OWN key, never the llama-swap bearer.
	const route = await probePeerRoutes(
		CLOUD_PEER_CANDIDATES,
		spec.id,
		bearerHeaders(process.env[spec.envKey]?.trim()),
	);
	if (!route) {
		logWarn(
			`no ${spec.id} peer path-route visible — emitting nothing, leaving layer untouched`,
		);
		return;
	}

	// The emitted lineup is the CATALOG — the same one direct mode publishes.
	// The proxy does not gate ids (any id the provider accepts is forwarded;
	// llama-swap's model list used to be the routing truth, which is why the
	// old peer mode matched its listing instead), and the providers' live
	// `/models` listings are NOT lineup sources: cline-pass's listing mirrors
	// a passthrough catalog that does not even contain its own models.dev
	// lineup. The route probe above only decides REACHABILITY; the models
	// stay authoritative from the vendored catalog.
	const peerModels = allModels;

	// Peer mode CONSUMES the facts cache stale-tolerantly — no refresh here
	// (peer mode means the provider endpoint itself is unreachable DIRECTLY;
	// the cache from the last direct run is the only enrichment available).
	let facts = null;
	if (spec.enrichFromFacts) facts = loadHyperFacts();
	let models = peerModels;
	if (facts) {
		const { enriched, untouched } = enrichWithFacts(spec, models, facts);
		models = [...enriched, ...untouched];
		logInfo(`${spec.id} peer models enriched from facts cache`, {
			fetchedAt: facts.fetchedAt,
			ageMs: facts.ageMs,
			enriched: enriched.length,
			untouched: untouched.length,
		});
	}

	logInfo(`${spec.id} routed through peer path-route`, {
		baseUrl: route.url,
		models: models.length,
	});
	write(
		// The FULL block — identical to direct mode except the baseUrl: same
		// catalog lineup, same key reference, same authHeader, same compat/
		// headers. The simplified router adds nothing but the path prefix
		// (docs/d027).
		providerBlock(spec, route.url, models, {
			apiKey: `$${spec.envKey}`,
			authHeader: true,
		}),
		spec,
	);
}

/**
 * @param {ProviderBlock} block
 * @param {AlternativeProviderSpec} spec the provider spec row (owns the filename)
 * @returns {void}
 */
function write(block, spec) {
	const out = join(scriptDir, spec.file);
	const written = writeArtifact(out, `${JSON.stringify(block, null, 2)}\n`);
	logInfo(`wrote ${spec.name} models`, {
		path: written,
		models: block.providers[spec.id].models.length,
	});
}

for (const spec of PROVIDER_SPECS) {
	await emitProvider(spec);
}
