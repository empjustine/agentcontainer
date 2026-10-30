/**
 * @fileoverview merge.mjs — the ONE place a catalog record becomes a model
 * record, shared by both halves of this folder: generate.mjs renders the
 * result into the committed pi `models.json` provider block, and the
 * extension imports this same file so its runtime shaping is identical
 * (one shape in, one shape out; docs/d096's folder contract, applied here).
 *
 * Mirrors the fleet's hyper row (coding-agent/generate-pi-coding-agent.mjs
 * `hyperFactsRecord` + `catalogPiModel` + the spec's modelCompat) — the
 * fleet owns the reference logic (docs/d033) and this folder is its
 * standalone projection, copied rather than imported because the standalone
 * rule forbids a runner folder reaching into a sibling runner
 * (docs/architecture.md).
 *
 * The two projections differ in exactly one place, because pi's schemas
 * differ (the same divergence pi-synthetic and pi-cline-pass document):
 * `cost` is OPTIONAL in models.json and MANDATORY on a registered model.
 *
 * No modality gate here, on purpose: hyper's records publish a boolean
 * attachment flag, not modality arrays, so every row is text or text+image —
 * by construction inside what pi drives, and the d049 gate has no dimension
 * left to judge.
 */

/** @typedef {import("./sources.mjs").CatalogRecord} CatalogRecord */

/**
 * @typedef {Record<string, string|null>} ThinkingLevelMap
 */

/**
 * One model, shaped but still schema-agnostic: everything downstream is a
 * projection of this.
 * @typedef {object} MergedModel
 * @property {string} id
 * @property {string} name display name — the catalog's, or the id itself
 * @property {string[]} input already pi-shaped (what pi drives, from the
 *   record's attachment flag)
 * @property {number|undefined} contextWindow
 * @property {number|undefined} maxTokens
 * @property {boolean} reasoning
 * @property {string[]|undefined} efforts published reasoning efforts
 * @property {ThinkingLevelMap|null} thinkingLevelMap pi's per-level wire
 *   values, derived ONLY from the published effort enum: a level the
 *   provider does not list is null (pi hides it, docs/d033), the whole map
 *   is null when no enum was published — nothing is rendered rather than a
 *   wire value invented — EXCEPT for reasoning models with no enum, which
 *   get the ON_OFF representative map below (the fleet row's
 *   onOffThinking: true)
 * @property {{input: number, output: number, cacheRead: number, cacheWrite: number}|undefined} cost
 *   a complete four-field block, or undefined when the record published no
 *   usable prices (docs/d057)
 */

/**
 * The gateway's wire-compat facts, transcribed from the vendor extension
 * (charmbracelet/pi-hyper-provider src/models.ts) exactly as the fleet's
 * modelCompat mirror is (docs/d033) — the ONE behavioral copy this folder
 * makes, and the one provenance risk that comes with it: upstream can revise
 * its table and this mirror has no tripwire. The README's provenance section
 * owns that caveat; re-derive against the repo before changing any value
 * here on a hunch.
 *
 * `supportsReasoningEffort` is the one per-model member (the published
 * effort enum decides it) and is filled in by the projections.
 * @type {Readonly<{supportsStore: boolean, thinkingFormat: string, maxTokensField: string}>}
 */
const HYPER_WIRE_COMPAT = Object.freeze({
	supportsStore: false,
	thinkingFormat: "deepseek",
	maxTokensField: "max_tokens",
});

/**
 * pi's thinking levels, with the wire values the provider's own effort enum
 * uses. The provider spells "none" where pi spells "off"; the rest map by
 * identity.
 * @type {readonly string[]}
 */
const PI_THINKING_LEVELS = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/** @type {Readonly<Record<string,string>>} */
const EFFORT_TO_PI = Object.freeze({
	none: "off",
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
});

/**
 * The thinking map for reasoning models that publish NO effort enum (the
 * fleet row's onOffThinking: true — the vendor extension's ON_OFF map,
 * docs/d033): pi "max" is the single representative "on" state, "off"
 * disables thinking, everything between is unsupported. Only valid paired
 * with thinkingFormat: "deepseek" + supportsReasoningEffort: false, which
 * the compat mirror above carries — the wire translation then drops efforts
 * entirely.
 * @type {Readonly<ThinkingLevelMap>}
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
 * The record's published effort enum, lowercased. `undefined` (not `[]`)
 * when the record publishes none, so the caller can tell "no enum" from "an
 * empty enum".
 * @param {CatalogRecord} record
 * @returns {string[]|undefined}
 */
export function effortValues(record) {
	const levels = record?.reasoning_levels;
	if (!Array.isArray(levels) || levels.length === 0) return;
	return levels.map((v) => String(v).toLowerCase());
}

/**
 * The published effort enum → pi's thinking levels. Returns null when the
 * record publishes NO enum: that is not "no reasoning", it is "the source
 * did not say" — the caller decides whether the ON_OFF fallback applies
 * (docs/d057's rule for prices, applied to efforts).
 * @param {string[]|undefined} efforts
 * @returns {ThinkingLevelMap|null}
 */
export function thinkingLevelMapFor(efforts) {
	if (!efforts || efforts.length === 0) return null;
	/** @type {ThinkingLevelMap} */
	const map = {};
	for (const level of PI_THINKING_LEVELS) {
		const effort = Object.keys(EFFORT_TO_PI).find(
			(e) => EFFORT_TO_PI[e] === level,
		);
		map[level] = effort && efforts.includes(effort) ? effort : null;
	}
	return map;
}

/**
 * The "complete or absent" price rule (docs/d057) with the fleet's
 * complete-with-zeros variant: hyper's wire is numeric and routinely
 * publishes a real `0` for cache-write, and the fleet's modelCompat-era
 * rows carry `cacheWrite: 0` for exactly those models (model-016) — voiding
 * the block would drop the prices that ARE published. An all-zero (or
 * absent) block still yields undefined: "priced at nothing" is spelled by
 * omitting the block, not by asserting a number pi already assumes.
 * @param {{input?: number, output?: number, cacheRead?: number, cacheWrite?: number}|undefined} cost
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}|undefined}
 */
export function piCost(cost) {
	if (!cost) return;
	const price = {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cacheRead ?? 0,
		cacheWrite: cost.cacheWrite ?? 0,
	};
	return Object.values(price).some((value) => value !== 0) ? price : undefined;
}

/**
 * The record's price block, already per-million dollars, in pi's field names.
 * The cached-price pairing looks crossed and is not: the provider's
 * `cost_per_1m_in_cached` is what a cached INPUT costs to have written
 * (cache WRITE), `cost_per_1m_out_cached` what a cached OUTPUT costs to
 * read back (cache READ) — verified against catwalk's own schema and code
 * (pi-synthetic/TODO.md, "neither side is wrong").
 * @param {CatalogRecord} record
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}|undefined}
 */
function toCost(record) {
	return piCost({
		input: record.cost_per_1m_in,
		output: record.cost_per_1m_out,
		cacheRead: record.cost_per_1m_out_cached,
		cacheWrite: record.cost_per_1m_in_cached,
	});
}

/** A finite number, or undefined. */
function num(/** @type {unknown} */ value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return value;
}

/**
 * What pi drives, from the record's attachment flag: the listing publishes
 * no modality arrays, only whether a model accepts attachments, so text is
 * the always-present core and image rides the flag.
 * @param {CatalogRecord} record
 * @returns {string[]}
 */
function toInput(record) {
	return record.supports_attachments === true ? ["text", "image"] : ["text"];
}

/**
 * Shape one catalog record. Returns the model record, or undefined when the
 * record carries no id.
 * @param {CatalogRecord} record
 * @returns {MergedModel|undefined}
 */
export function shapeRow(record) {
	const id = record?.id;
	if (typeof id !== "string" || id.length === 0) return;
	const efforts = effortValues(record);
	const reasoning = record.can_reason === true;
	return {
		id,
		name: typeof record.name === "string" && record.name ? record.name : id,
		input: toInput(record),
		contextWindow: num(record.context_window),
		maxTokens: num(record.default_max_tokens),
		reasoning,
		efforts,
		thinkingLevelMap: reasoning
			? (thinkingLevelMapFor(efforts) ?? { ...ON_OFF_THINKING_LEVEL_MAP })
			: null,
		cost: toCost(record),
	};
}

/**
 * Shape the whole catalog into the published lineup, sorted by id (the
 * canonical order a rerun must reproduce, docs/d050).
 * @param {readonly CatalogRecord[]} records
 * @returns {MergedModel[]}
 */
export function shapeCatalog(records) {
	/** @type {MergedModel[]} */
	const models = [];
	for (const record of records ?? []) {
		const model = shapeRow(record);
		if (model) models.push(model);
	}
	return models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The wire-compat mirror for one shaped model: the provider-level facts plus
 * the one per-model member the published enum decides — which is why it is
 * DERIVED here rather than stored on the record (it is a function of
 * 'efforts'). Same values on both projections — the registration surface
 * has no provider-level compat slot, so the per-model copy is the only
 * placement that survives registration.
 * @param {MergedModel} model
 * @returns {{supportsStore: boolean, supportsReasoningEffort: boolean, thinkingFormat: string, maxTokensField: string}}
 */
export function compatFor(model) {
	return {
		supportsStore: HYPER_WIRE_COMPAT.supportsStore,
		supportsReasoningEffort: (model.efforts?.length ?? 0) > 0,
		thinkingFormat: HYPER_WIRE_COMPAT.thinkingFormat,
		maxTokensField: HYPER_WIRE_COMPAT.maxTokensField,
	};
}

/* ------------------------------ projections -------------------------------- */

/**
 * The models.json model entry — the fields pi's manifest schema takes, and
 * nothing else. `contextWindow`/`maxTokens` fall back to pi's own schema
 * defaults when the catalog published nothing; those values are the
 * schema's, not an invented vendor fact.
 * @param {MergedModel} model
 * @returns {Record<string, unknown>}
 */
export function toPiModel(model) {
	/** @type {Record<string, unknown>} */
	const entry = {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow ?? 128000,
		maxTokens: model.maxTokens ?? 16384,
		compat: compatFor(model),
	};
	if (model.cost) entry.cost = model.cost;
	if (model.reasoning && model.thinkingLevelMap) {
		entry.thinkingLevelMap = model.thinkingLevelMap;
	}
	return entry;
}

/**
 * The extension's model entry: pi's `ProviderChatModelConfig` surface,
 * verified against `@earendil-works/pi-coding-agent@1.4.0` the same way
 * pi-synthetic verified its own.
 *
 * `cost` is MANDATORY on a registered model and `calculateCost()`
 * dereferences the block on every scored turn, so an omitted block throws
 * instead of streaming. Zeros are the correct fill: pi already assumes a
 * zero price for an absent block, which is exactly why the manifest path
 * omits it.
 *
 * `thinkingLevelMap` is carried on every reasoning model, map or ON_OFF:
 * its absence makes pi fabricate `off`…`high`, which would advertise
 * levels the provider never published AND hide the `max` the ON_OFF map
 * exists to offer.
 * @param {MergedModel} model
 * @returns {Record<string, unknown>}
 */
export function toExtensionModel(model) {
	/** @type {Record<string, unknown>} */
	const entry = {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow ?? 128000,
		maxTokens: model.maxTokens ?? 16384,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: compatFor(model),
	};
	if (model.reasoning && model.thinkingLevelMap) {
		entry.thinkingLevelMap = model.thinkingLevelMap;
	}
	return entry;
}
