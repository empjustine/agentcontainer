/**
 * @fileoverview merge.mjs — the ONE place a catalog record becomes a model
 * record, shared by both halves of this folder: generate.mjs renders the
 * result into the committed pi `models.json` provider block, and the
 * extension imports this same file so its runtime shaping is identical.
 *
 * Mirrors the fleet's catalogPiModel (coding-agent/generate-pi-coding-agent.mjs)
 * record-for-record: the fleet owns the reference logic (docs/d033, d040,
 * d049, d057) and this folder is its standalone projection — copied rather
 * than imported, because the standalone rule forbids a runner folder
 * reaching into a sibling runner (docs/architecture.md).
 *
 * The two projections differ in exactly two places, both because pi's
 * schemas differ — the same divergence pi-synthetic documents:
 *   - `cost`: OPTIONAL in models.json, MANDATORY on a registered model;
 *   - the extension fills the zero block the manifest would omit.
 *
 * Deliberate differences from pi-synthetic's merge.mjs, all owned by the
 * fleet's cline-pass spec row:
 *   - ONE compat fact, two homes: the developer-role rejection is a
 *     provider-level fact (the fleet's modelCompat is null), so models.json
 *     carries it as the provider's compat block — and toExtensionModel
 *     projects the same value per model, because pi 1.4.0's ProviderConfig
 *     has no provider-level compat slot and registration overwrites the
 *     models layer: a fact placed anywhere else never reaches pi-ai.
 *     One spelling, both homes (CLINE_PASS_COMPAT).
 *   - a partial price block COMPLETES with zeros instead of being refused:
 *     models.dev routinely omits `cache_write`, and the fleet's toCost/piCost
 *     complete it (model-015 carries `cacheWrite: 0` for exactly those
 *     models). pi-synthetic's refusing variant exists because ITS wire
 *     mixes strings and numbers; this source does not.
 *   - NO alias tiers: ClinePass publishes no rotating tier ids, so there is
 *     no alias map to carry — inventing one would be an invented contract.
 */

import { CLINE_PASS_ID_PREFIX } from "./sources.mjs";

/** @typedef {import("./sources.mjs").CatalogRecord} CatalogRecord */

/**
 * @typedef {import("../coding-agent/route-probe.mjs").Cost} Cost
 * @typedef {Record<string, string|null>} ThinkingLevelMap
 */

/**
 * One model, shaped but still schema-agnostic: everything downstream is a
 * projection of this.
 * @typedef {object} MergedModel
 * @property {string} id
 * @property {string} name display name — the catalog's, or the id itself
 * @property {string[]} input already pi-shaped (trimmed to what pi drives)
 * @property {string[]|undefined} output the raw published set — kept for
 *   eligibility only, never rendered
 * @property {number|undefined} contextWindow
 * @property {number|undefined} maxTokens
 * @property {boolean} reasoning
 * @property {string[]|undefined} efforts published reasoning efforts
 * @property {ThinkingLevelMap|null} thinkingLevelMap pi's per-level wire
 *   values, derived ONLY from the published effort enum: a level the
 *   provider does not list is null (pi hides it, docs/d033), and the whole
 *   map is null when no enum was published — nothing is rendered rather
 *   than a wire value invented
 * @property {Cost|undefined} cost a complete four-field block, or undefined
 *   when the source published no usable prices (docs/d057)
 */

/**
 * The gateway's ONE compat fact (docs/d022, docs/d033): ClinePass rejects
 * the `developer` role pi-ai emits for reasoning models. Provider-level in
 * models.json (fleet parity); projected per model by toExtensionModel, the
 * only placement a registration can deliver (ProviderConfig has no
 * provider-level compat field — verified against pi 1.4.0's shipped
 * declarations).
 * @type {Readonly<{supportsDeveloperRole: boolean}>}
 */
export const CLINE_PASS_COMPAT = Object.freeze({
	supportsDeveloperRole: false,
});
/** The one input modality every drivable model must accept (docs/d049). */
const PI_DRIVABLE_CORE = "text";

/**
 * pi's driving-capability declaration (docs/d049), copied from the repo's
 * shared projection (coding-agent/gen-lib.mjs PI_MODALITY_CAPABILITY —
 * copied rather than imported, for the standalone rule): input is trimmed
 * to the modalities pi originates, output must be consumable, and a record
 * without the drivable core cannot be driven at all.
 * @type {Readonly<{input: readonly string[], output: readonly string[]}>}
 */
const PI_MODALITY_CAPABILITY = Object.freeze({
	input: Object.freeze([PI_DRIVABLE_CORE, "image"]),
	output: Object.freeze(["text"]),
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
 * The record's reasoning-effort enum, flattened and lowercased. `undefined`
 * (not `[]`) when the record publishes none, so the caller can tell "no
 * enum" from "an empty enum".
 * @param {CatalogRecord} record
 * @returns {string[]|undefined}
 */
function effortValues(record) {
	/** @type {string[]} */
	const values = [];
	for (const opt of record?.reasoning_options ?? []) {
		if (opt?.type === "effort" && Array.isArray(opt.values)) {
			for (const v of opt.values) {
				values.push(String(v).toLowerCase());
			}
		}
	}
	return values.length > 0 ? values : undefined;
}

/**
 * The published effort enum → pi's thinking levels. Returns null when the
 * record publishes NO enum: that is not "no reasoning", it is "the source
 * did not say" — the caller renders nothing rather than inventing a wire
 * value the API never advertised (docs/d057's rule for prices, applied to
 * efforts; the fleet pairs this with onOffThinking: false for this row, so
 * there is no ON_OFF fallback to apply either).
 * @param {string[]|undefined} efforts
 * @returns {ThinkingLevelMap|null}
 */
export function thinkingLevelMapFor(efforts) {
	if (!efforts || efforts.length === 0) {
		return null;
	}
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
 * pi's "complete or absent" price rule (docs/d057): the manifest block is
 * optional, but the moment it appears pi requires all four fields. Unlike
 * pi-synthetic's variant of this rule, missing fields COMPLETE WITH ZEROS
 * rather than voiding the block: models.dev commonly omits `cache_write`
 * and the fleet publishes those models with `cacheWrite: 0` — voiding it
 * here would drop the price facts that ARE published. An all-zero (or
 * absent) block still yields undefined: "priced at nothing" is spelled by
 * omitting the block, not by asserting a number pi already assumes.
 * @param {{input?: number|undefined, output?: number|undefined, cacheRead?: number|undefined, cacheWrite?: number|undefined}|undefined} cost
 * @returns {Cost|undefined}
 */
export function piCost(cost) {
	if (!cost) {
		return;
	}
	const price = {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cacheRead ?? 0,
		cacheWrite: cost.cacheWrite ?? 0,
	};
	return Object.values(price).some((value) => value !== 0) ? price : undefined;
}

/**
 * The catalog's price block (already per-million dollars — unlike
 * pi-synthetic's wire, no scaling applies) in pi's field names, through the
 * complete-or-absent rule.
 * @param {CatalogRecord["cost"]} cost the catalog's block, or null when the
 *   source publishes no prices at all
 * @returns {Cost|undefined}
 */
function toCost(cost) {
	if (cost === null || cost === undefined) {
		return;
	}
	return piCost({
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cache_read,
		cacheWrite: cost.cache_write,
	});
}

/** A string array from an unknown value, or undefined. */
function strings(/** @type {unknown} */ value) {
	return Array.isArray(value) && value.every((v) => typeof v === "string")
		? /** @type {string[]} */ (value)
		: undefined;
}

/** A finite number, or undefined. */
function num(/** @type {unknown} */ value) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return;
	}
	return value;
}

/**
 * Whether the record's published modalities fit what pi drives (docs/d049):
 * judge only the dimensions the record actually carries — a missing
 * dimension is unjudgeable and passes, so id-only records are never dropped
 * for lack of metadata.
 * @param {{input?: string[]|undefined, output?: string[]|undefined}} modalities
 * @returns {boolean}
 */
export function laysWithinPiModalities(modalities) {
	const input = modalities?.input;
	const output = modalities?.output;
	if (
		input &&
		input.length > 0 &&
		!input.includes(PI_DRIVABLE_CORE)
	) {
		return false;
	}
	if (
		output &&
		output.length > 0 &&
		!output.every((o) => PI_MODALITY_CAPABILITY.output.includes(o))
	) {
		return false;
	}
	return true;
}

/**
 * Intersect published input with what pi drives, in capability order,
 * falling back to the drivable core for records with no modality metadata.
 * @param {string[]|undefined} input
 * @returns {string[]}
 */
function toInput(input) {
	const kept = PI_MODALITY_CAPABILITY.input.filter((m) => input?.includes(m));
	return kept.length > 0 ? [...kept] : [PI_DRIVABLE_CORE];
}

/* ------------------------------- shaping ---------------------------------- */

/**
 * Shape one catalog record. Returns the model record, or undefined when the
 * record cannot be driven by pi at all (the modality gate) or carries no id.
 * @param {CatalogRecord} record
 * @returns {MergedModel|undefined}
 */
export function shapeRow(record) {
	const id = record?.id;
	if (typeof id !== "string" || id.length === 0) {
		return;
	}
	// Documented family/id exception (docs/d049, fleet parity): models.dev
	// labels embedding endpoints output ["text"], so the modality gate below
	// would trust that label — this check is what refuses them.
	if (
		record.family === "text-embedding" ||
		id.toLowerCase().includes("embedding")
	) {
		return;
	}
	const input = strings(record.modalities?.input);
	const output = strings(record.modalities?.output);
	// Gate BEFORE projecting: trimming first would turn an audio-only input
	// into the text fallback and admit a model pi cannot drive.
	if (!laysWithinPiModalities({ input, output })) {
		return;
	}
	const efforts = effortValues(record);
	return {
		id,
		name: typeof record.name === "string" && record.name ? record.name : id,
		input: toInput(input),
		output,
		contextWindow: num(record.limit?.context),
		maxTokens: num(record.limit?.output),
		reasoning: record.reasoning === true,
		efforts,
		thinkingLevelMap: thinkingLevelMapFor(efforts),
		cost: toCost(record.cost),
	};
}

/**
 * Shape the whole catalog slice into the published lineup: the prefix guard
 * (the billing contract), the allowlist (the reconciled docs ∪ catalog set
 * — undefined means "no lineup bound"), the d049 gate — then sort by id
 * (the canonical order a rerun must reproduce, docs/d050).
 * @param {Record<string, CatalogRecord>} records the fetched cline-pass slice
 * @param {readonly string[]|undefined} allowlist resolved lineup ids
 * @returns {MergedModel[]}
 */
export function shapeCatalog(records, allowlist) {
	/** @type {MergedModel[]} */
	const models = [];
	for (const [key, record] of Object.entries(records ?? {})) {
		if (!key.startsWith(CLINE_PASS_ID_PREFIX)) {
			continue;
		}
		if (allowlist && !allowlist.includes(key)) {
			continue;
		}
		// The KEY is the prefix-guarded, allowlist-matched identity; a record
		// body that carries its own id must never replace it — an unprefixed id
		// published here bills at standard API pricing (docs/d040).
		const model = shapeRow({ ...record, id: key });
		if (model) {
			models.push(model);
		}
	}
	return models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ------------------------------ projections -------------------------------- */

/**
 * The models.json model entry — the fields pi's manifest schema takes, and
 * nothing else. NO per-model compat: the fleet's cline-pass row emits none
 * (modelCompat: null) and pi's defaults are correct for this gateway.
 *
 * `contextWindow`/`maxTokens` fall back to pi's own schema defaults when the
 * catalog published nothing; those values are the schema's, not an invented
 * vendor fact.
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
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 16_384,
	};
	if (model.cost) {
		entry.cost = model.cost;
	}
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
 * Two fields differ from the manifest projection, both for reasons pi-ai's
 * runtime and the type declarations spell out (pi-synthetic's README carries
 * the verification):
 *
 *   - `cost` is MANDATORY on a registered model and `calculateCost()`
 *     dereferences the block on every scored turn, so an omitted block
 *     throws instead of streaming. Zeros are the correct fill: pi already
 *     assumes a zero price for an absent block, which is exactly why the
 *     manifest path omits it.
 *   - `thinkingLevelMap` is carried when the catalog published an enum,
 *     because its absence makes pi fabricate `off`…`high`. Models with NO
 *     published enum deliberately get none — the fleet's onOffThinking:
 *     false for this row: pi's default on/off handling covers them.
 *
 * `compat` carries the ONE published fact (CLINE_PASS_COMPAT) on every
 * row: the registration surface has no provider-level compat slot, so a
 * per-model copy is the only placement that survives registration (see the
 * file header). Any other folder-specific field stays absent — pi's schema
 * is strict.
 * @param {MergedModel} model
 * @returns {Record<string, unknown>}
 */
export function toExtensionModel(model) {
	/** @type {Record<string, unknown>} */
	const entry = {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 16_384,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { ...CLINE_PASS_COMPAT },
	};
	if (model.reasoning && model.thinkingLevelMap) {
		entry.thinkingLevelMap = model.thinkingLevelMap;
	}
	return entry;
}
