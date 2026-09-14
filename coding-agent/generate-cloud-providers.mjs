/**
 * @fileoverview generate-cloud-providers.mjs — the ONE table-driven generator
 * for every CLOUD provider layer (docs/d037 merged the former
 * generate-cloud-pi-native-providers.mjs + generate-cloud-alternative-
 * providers.mjs; d030 option 6). One PROVIDER_SPECS table, two emission
 * modes:
 *
 *   - `override-only` (the pi-native set): pi ships the provider, so the
 *     layer can only ever REROUTE it. Direct endpoint reachable ⇒ emit
 *     nothing (pi's built-in routing stays). Peer path-route usable ⇒
 *     `providerReroute` with filtered models from the live listing, else
 *     bare catalog ids. All rows land in the ONE layer
 *     `model-012-cloud-pi-native.json`.
 *   - `full` (providers pi does NOT ship — cline-pass/hyper/inferx): the
 *     layer is the sole definition, so a FULL block is always emitted —
 *     direct mode at the real endpoint (with live-listing sync when the
 *     provider's key is in the environment + facts enrichment), peer mode at
 *     the peer route with the catalog lineup. One layer file per row
 *     (model-015/016/017).
 *
 * Detection cascade, reachability rule ("reachable ≠ authenticated"),
 * model-list source priority and the per-provider quirks live in docs/d033 —
 * this header deliberately does not duplicate them. Merge contract:
 * merge-models-json.mjs (same `model-012/015/016/017` filenames as before).
 *
 * Usage: node generate-cloud-providers.mjs
 *   Layers are written next to this script (the scratch dir when staged).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	bearerHeaders,
	CLOUD_PROVIDERS as CLOUD_PROVIDER_FACTS,
	fetchModelEntries,
	getCatwalkModels,
	loadHyperFacts,
	logInfo,
	logWarn,
	modelsDevCatalogPath,
	PI_NATIVE_CLOUD_IDS,
	peerBaseUrls,
	piModel as peerModel,
	probeDirect,
	probePeerRoutes,
	providerReroute,
	refreshCatwalkFacts,
	refreshHyperFacts,
	scriptDir,
	setLogTool,
	writeArtifact,
} from "./gen-lib.mjs";

setLogTool("coding-agent/generate-cloud-providers");

// Peer candidates — vault-sourced (peerBaseUrls(); see peer-probe.mjs).
// Supports multi-hop proxy chains (PEER_BASE_URLS comma/newline delimited);
// no localhost candidates — the LAN :8080 (proxy) and :8101 (llama-swap)
// listen addresses are not routable from outside the serving host (docs/d022).
const CLOUD_PEER_CANDIDATES = peerBaseUrls();

// Catalog lookup order: a models.dev.api.json next to this script wins — when
// run from generate.sh's scratch dir that entry is a symlink to the vendored
// catalog which the best-effort refresh replaces with the freshly fetched
// copy, so the generator always reads what this run validated. Manual
// in-place runs fall back to the shared vendored catalog (docs/d023).
const API_JSON = modelsDevCatalogPath();

// The vendored models.dev catalog parsed ONCE and shared by both modes
// (override-only uses it for bare-id fallbacks, full mode for the whole
// lineup). Absent ⇒ override-only rows still have catwalk; full rows fail
// their row (logged, layer untouched) exactly as the old generator did.
/** @type {Record<string, { api?: string, models?: Record<string, unknown> }>|null} */
let CATALOG = null;
try {
	CATALOG = /** @type {typeof CATALOG} */ (
		JSON.parse(readFileSync(API_JSON, "utf-8"))
	);
} catch (err) {
	logWarn("models.dev catalog unreadable — full-mode rows cannot load", {
		path: API_JSON,
		error: /** @type {Error} */ (err).message,
	});
}

/**
 * Per-provider scoping of the override's model list, applied to BOTH sources
 * (live peer listing and catalog fallback). These are the slices this fleet
 * can actually use — the llama-swap era encoded them on the SERVING side
 * (gen-lib's `filter`); with routing per provider the client scopes its own
 * override (docs/d033).
 *
 *   - openrouter: the ":free" slice (the same scope the peer always served).
 *   - mistral: chat-capable only — the catalog/listing also carries
 *     mistral-embed (embeddings) and voxtral-*-tts (speech).
 *   - google: the gemini chat slice — the listing also carries imagen/veo/
 *     lyria (media generation), embeddings, tts and the gemini image-output
 *     variants, none of which pi can drive.
 * @type {Record<string, ((id: string) => boolean)|undefined>}
 */
const PEER_MODEL_FILTERS = {
	openrouter: (id) => id.endsWith(":free"),
	mistral: (id) => !/embed|tts/i.test(id),
	google: (id) => /^gemini-/.test(id) && !/(-image|-tts)/i.test(id),
};

/**
 * Provider spec rows for BOTH modes (docs/d037). One row = one emission
 * unit; adding a provider is a row here (full rows also need a merge-order
 * row in merge-models-json.mjs's header — that contract lives there).
 * @typedef {object} CloudProviderSpec
 * @property {string} id models.dev provider key AND pi provider id
 * @property {'override-only'|'full'} mode emission semantic (see header)
 * @property {string} [name] display name for the pi provider block (full)
 * @property {string} [file] output layer filename (full; relative to script)
 * @property {string} envKey the provider's own key variable — read only for
 *   the probes; full rows reference it as `$<envKey>` in the emitted layer
 * @property {((id: string) => boolean)|undefined} [filter] model-id scoping
 *   (override-only — see PEER_MODEL_FILTERS below)
 * @property {{ supportsDeveloperRole: boolean }|null} compat provider-level
 *   compat pi cannot infer; null = no override (full)
 * @property {((m: ModelsDevModel) => Record<string, unknown>|null)|null} modelCompat
 *   builds the per-model compat mirror; null = none (full)
 * @property {boolean} onOffThinking swaps the all-null effort-less map for
 *   the ON_OFF representative map (full; see that constant)
 * @property {boolean} [enrichFromFacts] refresh + consume the hyper-facts
 *   cache (hyper only — the one provider with a non-models.dev cache)
 * @property {readonly string[]} [modelAllowlist] bare model ids (provider
 *   prefix stripped) to restrict the catalog lineup to (full; docs/d040)
 * @property {boolean} [liveSync] when false, direct mode never syncs the
 *   lineup against the provider's live /models listing (full; docs/d040 —
 *   cline-pass's listing serves the `cline` provider's data)
 * @property {Record<string, string>} [headers] provider-level request headers
 */

/**
 * The curated ClinePass lineup, verbatim from Cline's published model table
 * (~/Downloads/references/github/cline/cline/docs/getting-started/clinepass.mdx,
 * "Models" section). models.dev's cline-pass slice is a superset (it also
 * lists deepseek-v4.1-flash and glm-5.3-flash, which the docs do not) — the
 * published lineup wins until Cline's docs add a model (docs/d040).
 * @type {readonly string[]}
 */
const CLINE_PASS_LINEUP = /** @type {readonly string[]} */ (Object.freeze([
	"glm-5.3",
	"glm-5.2",
	"kimi-k3",
	"kimi-k2.7-code",
	"kimi-k2.6",
	"deepseek-v4-pro",
	"deepseek-v4-flash",
	"mimo-v2.5",
	"mimo-v2.5-pro",
	"minimax-m3",
	"qwen3.8-max",
	"qwen3.7-max",
	"qwen3.7-plus",
]));

/** @type {CloudProviderSpec[]} */
const PROVIDER_SPECS = [
	// --- override-only: the pi-native set (fact table owns the base URL) ---
	...PI_NATIVE_CLOUD_IDS.map(
		(id) =>
			/** @type {CloudProviderSpec} */ ({
				id,
				mode: "override-only",
				envKey: CLOUD_PROVIDER_FACTS[id].apiKeyEnv,
				filter: PEER_MODEL_FILTERS[id],
			}),
	),
	// --- full: providers pi does not ship natively (docs/d024) ---
	{
		id: "cline-pass",
		mode: "full",
		name: "ClinePass",
		file: "model-015-cloud-cline-pass.json",
		envKey: "CLINE_API_KEY",
		// ClinePass rejects the `developer` role pi-ai emits for reasoning
		// models: both reference extensions force it off (docs/d033).
		compat: { supportsDeveloperRole: false },
		modelCompat: null,
		onOffThinking: false,
		// The live /models listing at api.cline.bot serves the `cline`
		// (usage-billing) provider's catalog — a different provider's data, so
		// syncing against it would prune the real lineup and append 400+ wrong
		// ids. The published ClinePass table is the contract instead (docs/d040).
		modelAllowlist: CLINE_PASS_LINEUP,
		liveSync: false,
	},
	{
		id: "hyper",
		mode: "full",
		name: "Charm Hyper",
		file: "model-016-cloud-hyper.json",
		envKey: "HYPER_API_KEY",
		// Standard OpenAI-compatible gateway: the vendor extension accepts the
		// default role handling, so no provider-level compat override.
		compat: null,
		// Per-model compat mirror of charmbracelet/pi-hyper-provider
		// src/models.ts: the full block on EVERY model, exactly like the
		// extension (docs/d033).
		modelCompat: (m) => ({
			supportsStore: false,
			supportsReasoningEffort: effortValues(m).size > 0,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		}),
		// Pair the deepseek thinking format with the ON_OFF map for
		// effort-less reasoning models — see ON_OFF_THINKING_LEVEL_MAP.
		onOffThinking: true,
		// The one non-models.dev enrichment source: refresh + consume
		// hyper-facts (docs/d033).
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
		mode: "full",
		name: "InferX",
		file: "model-017-cloud-inferx.json",
		envKey: "INFERX_API_KEY",
		// Plain OpenAI-compatible gateway (models.dev:
		// @ai-sdk/openai-compatible): no developer-role quirk (unlike
		// cline-pass), no per-model wire-compat mirror (unlike hyper) — pi's
		// defaults are correct as-is.
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
 * an out-of-enum value (docs/d033).
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
 * A models.dev model record — the subset the full mode reads.
 * @typedef {object} ModelsDevModel
 * @property {string} id
 * @property {string} [name]
 * @property {string} [family]
 * @property {boolean} [reasoning]
 * @property {{ input?: string[] }} [modalities]
 * @property {{ context?: number, output?: number }} [limit]
 * @property {{ input?: number, output?: number, cache_read?: number, cache_write?: number }} [cost]
 * @property {Array<{ type?: string, values?: string[] }>} [reasoning_options]
 */

/**
 * A pi-shaped model entry as the full mode publishes it. Only the first
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
 * A models.json provider layer for one full-mode provider.
 * @typedef {object} ProviderBlock
 * @property {Record<string, { name: string, baseUrl: string, api: string, apiKey: string, authHeader?: boolean, headers?: Record<string, string>, compat?: { supportsDeveloperRole: boolean }, models: PiAlternativeModel[] }>} providers
 */

/**
 * Build the pi-shaped model entry for one models.dev model of provider
 * `spec.id`. `id` is the fully-qualified model id to publish; the default
 * keeps the catalog's own id (ClinePass catalog ids are already
 * `cline-pass/<modelId>`; Hyper's are bare — both are published verbatim in
 * direct mode, since pi namespaces them under the provider id itself).
 * Distinct from gen-lib's `peerModel` (renamed import) on purpose: that one
 * mirrors a RAW /models entry, this one derives from a full models.dev
 * record incl. thinkingLevelMap/compat (docs/d033).
 * @param {CloudProviderSpec} spec the provider spec row
 * @param {ModelsDevModel} m a models.dev model record
 * @param {string} [id] the id to publish (defaults to the record's own id)
 * @returns {PiAlternativeModel|null} a pi model entry, or null for an
 *   embedding model (pi cannot drive one)
 */
function catalogPiModel(spec, m, id = m.id) {
	if (m.family === "text-embedding" || id.toLowerCase().includes("embedding"))
		return null;
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
 * Load one full-mode provider's slice of the (once-parsed) models.dev
 * catalog. Catwalk is NOT a fallback here: it carries none of the
 * alternative providers (docs/d028 coverage gap — hyper/cline-pass/inferx
 * are absent).
 * @param {CloudProviderSpec} spec the provider spec row
 * @returns {{ api: string, models: Record<string, ModelsDevModel> }} the
 *   provider record (api endpoint + per-model metadata)
 */
function loadProvider(spec) {
	if (!CATALOG) {
		throw new Error(`models.dev catalog unreadable (${API_JSON})`);
	}
	const provider = CATALOG[spec.id];
	if (!provider?.models) {
		throw new Error(
			`provider ${spec.id} not found in the models.dev catalog (${API_JSON})`,
		);
	}
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
 * @param {CloudProviderSpec} spec the provider spec row
 * @param {string} baseUrl
 * @param {PiAlternativeModel[]} models
 * @param {{ apiKey: string, authHeader?: boolean }} auth
 * @returns {ProviderBlock} a models.json provider layer for the provider
 */
function providerBlock(spec, baseUrl, models, auth) {
	return {
		providers: {
			[spec.id]: {
				name: /** @type {string} */ (spec.name),
				baseUrl,
				api: "openai-completions",
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
 * Rebuild a raw hyper-facts (live /provider) record as a models.dev-shaped
 * model record, so the enrichment reuses catalogPiModel()'s full derivation
 * (input, costs, effort-enum → thinkingLevelMap/compat). Fields pi models but
 * the live record lacks stay undefined → catalogPiModel()'s defaults; the
 * display name is overridden back to the models.dev one by the enricher
 * (names stay catalog — see the header whitelist note).
 * @param {import("./hyper-facts.mjs").HyperProviderModel} l a raw live /provider record
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
 * @param {CloudProviderSpec} spec
 * @param {PiAlternativeModel[]} models the current catalog-derived lineup
 * @param {import("./peer-probe.mjs").RawModelEntry[]} liveEntries the listing from the provider's /models endpoint
 * @returns {PiAlternativeModel[]} the pruned and augmented lineup
 */
function enrichWithLiveListing(spec, models, liveEntries) {
	const liveIds = new Set(
		liveEntries.map((e) => stripProviderPrefixes(spec.id, e.id)),
	);
	const catalogIds = new Set(
		models.map((m) => stripProviderPrefixes(spec.id, m.id)),
	);

	const pruned = models.filter((m) =>
		liveIds.has(stripProviderPrefixes(spec.id, m.id)),
	);

	const liveOnly = liveEntries
		.filter((e) => !catalogIds.has(stripProviderPrefixes(spec.id, e.id)))
		.map((e) => {
			const m = {
				id: e.id,
				name: e.name ?? e.id,
			};
			return catalogPiModel(spec, m);
		})
		.filter((m) => m !== null);

	return [...pruned, ...liveOnly];
}

/**
 * Enrich pi-shaped models with the hyper facts cache: rebuild every model
 * whose (prefix-stripped) id is in the live records through catalogPiModel()
 * on LIVE data, keeping the models.dev display name (see the header
 * whitelist). Models absent from the cache pass through untouched; live-only
 * records are returned for the caller to append (direct mode appends them,
 * peer mode appends only ids the peer actually serves).
 * @param {CloudProviderSpec} spec
 * @param {PiAlternativeModel[]} models the models to enrich
 * @param {import("./hyper-facts.mjs").LoadedHyperFacts} facts loaded cache
 * @returns {{ enriched: PiAlternativeModel[], liveOnly: ModelsDevModel[], untouched: PiAlternativeModel[] }}
 */
function enrichWithFacts(spec, models, facts) {
	const live = new Map(
		facts.models.map((l) => [stripProviderPrefixes(spec.id, l.id), l]),
	);
	/** @type {PiAlternativeModel[]} */
	const enriched = [];
	/** @type {PiAlternativeModel[]} */
	const untouched = [];
	for (const m of models) {
		const l = live.get(stripProviderPrefixes(spec.id, m.id));
		if (!l) {
			untouched.push(m);
			continue;
		}
		const merged = { ...liveToCatalogRecord(l), name: m.name };
		const rebuilt = catalogPiModel(spec, merged, m.id);
		if (rebuilt) enriched.push(rebuilt);
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
 * The scoped model-id list for one override-only row from the (once-parsed)
 * models.dev catalog, or null when the catalog has no usable slice for it.
 * Falls back to catwalk when models.dev is stale (docs/d033 model-list
 * priority).
 * @param {CloudProviderSpec} spec
 * @returns {string[]|null}
 */
function catalogModelIds(spec) {
	const models = CATALOG?.[spec.id]?.models ?? {};
	const filter = spec.filter;
	const ids = Object.keys(models).filter((mid) => filter?.(mid) ?? true);
	if (ids.length) return ids;

	// Catwalk fallback: openrouter→openrouter, opencode→opencode-zen,
	// google→gemini. nvidia/mistral have no catwalk entry.
	const catwalkModels = getCatwalkModels(spec.id);
	if (catwalkModels) {
		const cids = catwalkModels
			.map((m) => m.id)
			.filter((mid) => filter?.(mid) ?? true);
		if (cids.length) {
			logInfo(`${spec.id} model IDs from catwalk fallback`, {
				models: cids.length,
			});
			return cids;
		}
	}

	logWarn("no model list available from models.dev or catwalk", {
		provider: spec.id,
	});
	return null;
}

/**
 * The override's models for one row, from the peer route's live listing.
 * Returns null when the listing yields nothing usable (the caller falls back
 * to the catalog).
 * @param {import("./peer-probe.mjs").RawModelEntry[]} entries
 * @param {CloudProviderSpec} spec
 * @returns {import("./gen-lib.mjs").PiModel[]|null}
 */
function listingModels(entries, spec) {
	const filter = spec.filter;
	const models = entries.filter((e) => filter?.(e.id) ?? true).map(peerModel);
	return models.length ? models : null;
}

/**
 * Run the override-only cascade for one pi-native row and record its
 * `providerReroute` in `providers` when (and only when) the direct endpoint
 * is unreachable and a peer path-route is usable. Reachable ⇒ emit NOTHING —
 * pi's built-in provider definition handles the provider as-is (docs/d033).
 * @param {CloudProviderSpec} spec
 * @param {Record<string, import("./gen-lib.mjs").PiProvider>} providers
 * @returns {Promise<void>}
 */
async function emitOverrideOnly(spec, providers) {
	const facts = CLOUD_PROVIDER_FACTS[spec.id];
	const direct = await probeDirect(
		facts.baseUrl,
		bearerHeaders(process.env[spec.envKey]?.trim()),
	);
	if (direct.result !== "unreachable") {
		if (direct.result === "auth") {
			// Not a routing problem: the endpoint answered and refused our
			// (absent) credentials — pi authenticates itself at request time.
			logInfo(
				"default endpoint reachable but credential-gated — keeping built-in routing",
				{ provider: spec.id, error: direct.error },
			);
		} else {
			logWarn(
				"default endpoint reachable but answered unexpectedly — keeping built-in routing",
				{ provider: spec.id, error: direct.error },
			);
		}
		return;
	}
	logInfo("default endpoint unreachable — probing peer path-route", {
		provider: spec.id,
		error: direct.error,
	});
	const route = await probePeerRoutes(
		CLOUD_PEER_CANDIDATES,
		spec.id,
		bearerHeaders(process.env[spec.envKey]?.trim()),
	);
	if (!route) {
		logWarn("no usable peer path-route — provider left on built-in routing", {
			provider: spec.id,
		});
		return;
	}
	const models = listingModels(route.entries, spec);
	if (models) {
		logInfo("override models from live peer listing", {
			provider: spec.id,
			models: models.length,
		});
		providers[spec.id] = providerReroute(route.url, models);
		return;
	}
	// Route proved but not listable (401/403 without a key, or an
	// unexpected answer): the catalog mirrors the provider's own ids.
	const ids = catalogModelIds(spec);
	if (!ids) {
		logWarn("no model list available — skipping", { provider: spec.id });
		return;
	}
	logInfo("override models from models.dev catalog fallback", {
		provider: spec.id,
		models: ids.length,
	});
	providers[spec.id] = providerReroute(
		route.url,
		ids.map((mid) => peerModel({ id: mid })),
	);
}

/**
 * Run the full-mode cascade for one alternative row and write its layer file.
 * The full block is emitted in BOTH modes — direct at the real endpoint
 * (with live-listing sync when the provider's key is in the environment)
 * or peer at the route URL with the catalog lineup; the layer IS the
 * provider definition, an empty layer would leave pi with nothing (docs/d033).
 * @param {CloudProviderSpec} spec
 * @returns {Promise<void>}
 */
async function emitFull(spec) {
	const provider = loadProvider(spec);
	const headers = bearerHeaders(process.env[spec.envKey]?.trim());

	const direct = await probeDirect(provider.api, headers);
	if (direct.result !== "unreachable") {
		if (direct.result === "auth") {
			// Reachable but refusing our probe credentials: the endpoint is
			// fine — still route direct (pi authenticates at request time).
			logInfo(
				"default endpoint reachable but credential-gated — routing direct",
				{ provider: spec.id, error: direct.error },
			);
		} else {
			logWarn(
				"default endpoint reachable but answered unexpectedly — routing direct",
				{ provider: spec.id, error: direct.error },
			);
		}
		return emitFullAt(
			spec,
			provider,
			provider.api,
			{ apiKey: `$${spec.envKey}`, authHeader: true },
			true,
		);
	}
	logInfo("default endpoint unreachable — probing peer path-route", {
		provider: spec.id,
		error: direct.error,
	});
	const route = await probePeerRoutes(CLOUD_PEER_CANDIDATES, spec.id, headers);
	if (!route) {
		logWarn("no usable peer path-route — no layer written", {
			provider: spec.id,
		});
		return;
	}
	return emitFullAt(
		spec,
		provider,
		route.url,
		{ apiKey: `$${spec.envKey}`, authHeader: true },
		false,
	);
}

/**
 * Write one full-mode layer at `baseUrl`, shaped by `directMode`:
 * direct mode syncs the lineup against the live listing (when the provider's
 * key is in the environment) and, for hyper, appends live-only records;
 * peer mode keeps the catalog lineup, restricted to the ids the peer route
 * actually serves.
 * @param {CloudProviderSpec} spec
 * @param {{ api: string, models: Record<string, ModelsDevModel> }} provider
 * @param {string} baseUrl
 * @param {{ apiKey: string, authHeader?: boolean }} auth
 * @param {boolean} directMode
 * @returns {Promise<void>}
 */
async function emitFullAt(spec, provider, baseUrl, auth, directMode) {
	const allow = spec.modelAllowlist;
	const catalogModels = Object.entries(provider.models)
		.filter(([id]) => !allow || allow.includes(stripProviderPrefixes(spec.id, id)))
		.map(([, m]) => m);
	/** @type {PiAlternativeModel[]} */
	let models = catalogModels
		.map((m) => catalogPiModel(spec, m))
		.filter((m) => m !== null);

	// Direct mode only: sync the catalog lineup against the live listing when
	// the provider's key is available — prunes retired ids, appends live-only
	// ones (minimal entries; the listing carries no metadata). Peer mode has
	// no lineup source beyond the catalog (the providers' own listings mirror
	// passthrough catalogs that do not match their models.dev lineups).
	if (directMode && spec.liveSync !== false && process.env[spec.envKey]?.trim()) {
		try {
			const liveEntries = await fetchModelEntries(
				provider.api,
				bearerHeaders(process.env[spec.envKey]?.trim()),
			);
			models = enrichWithLiveListing(spec, models, liveEntries);
			logInfo("lineup synchronized with live /models listing", {
				provider: spec.id,
				liveCount: liveEntries.length,
				finalCount: models.length,
			});
		} catch (err) {
			logWarn("live listing fetch failed — falling back to catalog", {
				provider: spec.id,
				error: /** @type {Error} */ (err).message,
			});
		}
	}

	if (spec.enrichFromFacts) {
		// refreshHyperFacts tries the provider endpoint, then every multi-hop
		// peer candidate (docs/d034), then falls back to the last good cache;
		// passing the API url keeps the multi-hop walk pointed at the right
		// provider path even when direct mode already answered.
		await refreshHyperFacts(provider.api);
		const facts = loadHyperFacts();
		if (facts) {
			const { enriched, liveOnly, untouched } = enrichWithFacts(
				spec,
				models,
				facts,
			);
			models = [...enriched, ...untouched];
			if (directMode && liveOnly.length) {
				// Direct mode serves everything the provider offers, including
				// records the catalog does not know yet; peer mode stays on the
				// catalog (enriched) — the router does not gate ids, but its
				// upstream may not carry a record the catalog lacks.
				models = [
					...models,
					...liveOnly
						.map((l) => catalogPiModel(spec, l, l.id))
						.filter((m) => m !== null),
				];
			}
			logInfo("enriched from facts cache", {
				provider: spec.id,
				fetchedAt: facts.fetchedAt,
				ageMs: facts.ageMs,
				enriched: enriched.length,
				...(directMode ? { liveOnlyAppended: liveOnly.length } : {}),
				catalogOnlyKept: untouched.length,
			});
		} else {
			logWarn("facts cache unavailable — using catalog metadata", {
				provider: spec.id,
			});
		}
	}

	if (!models.length) {
		logWarn("no models resolved — no layer written", { provider: spec.id });
		return;
	}
	const written = writeArtifact(
		join(scriptDir, /** @type {string} */ (spec.file)),
		`${JSON.stringify(providerBlock(spec, baseUrl, models, auth), null, 2)}\n`,
	);
	logInfo("provider layer written", {
		provider: spec.id,
		path: written,
		baseUrl,
		models: models.length,
		mode: directMode ? "direct" : "peer",
	});
}

/** @returns {Promise<void>} */
async function main() {
	// Best-effort cache refresh before the cascade reads it (order is
	// irrelevant — it only writes lib caches; a failing refresh must not fail
	// generation). Hyper's refresh is NOT here: it belongs to the hyper row's
	// emit path, which passes the provider's own API url so the multi-hop
	// walk (docs/d034) stays pointed at the right provider path.
	await Promise.allSettled([refreshCatwalkFacts()]);

	/** @type {Record<string, import("./gen-lib.mjs").PiProvider>} */
	const providers = {};
	const results = await Promise.allSettled(
		PROVIDER_SPECS.map((spec) =>
			spec.mode === "full" ? emitFull(spec) : emitOverrideOnly(spec, providers),
		),
	);
	results.forEach((res, i) => {
		if (res.status === "rejected") {
			logWarn("provider spec failed — layer left untouched", {
				provider: PROVIDER_SPECS[i].id,
				error: /** @type {Error} */ (res.reason).message,
			});
		}
	});

	if (!Object.keys(providers).length) {
		logInfo("no override-only reroutes needed — model-012 layer written empty");
	}
	const written = writeArtifact(
		join(scriptDir, "model-012-cloud-pi-native.json"),
		`${JSON.stringify({ providers }, null, 2)}\n`,
	);
	logInfo("pi-native override layer written", { path: written });
}

main();
