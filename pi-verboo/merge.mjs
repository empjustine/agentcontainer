/**
 * @fileoverview merge.mjs — the ONE place a listing row becomes a model
 * record, shared by both halves of this folder: generate.mjs renders the
 * result into the committed pi `models.json` provider block, and the
 * extension imports this same file so its runtime shaping is identical
 * (one shape in, one shape out; docs/d096's folder contract, applied here).
 *
 * Mirrors the fleet's verboo row (coding-agent/generate-pi-coding-agent.mjs
 * `verbooFactsRecord` + `catalogPiModel`) — the fleet owns the reference
 * logic (docs/d033/d057) and this folder is its standalone projection,
 * copied rather than imported because the standalone rule forbids a runner
 * folder reaching into a sibling runner (docs/architecture.md).
 *
 * Two absences are deliberate, not oversights, and both are the fleet row's
 * own documented positions:
 *   - NO cost, ever: the listing publishes no prices (cost: null in the
 *     fleet's mapper), so the manifest omits the block entirely (docs/d057)
 *     and the extension fills the mandatory zero block. Inventing a price
 *     would be a vendor fact nobody published.
 *   - no `maxTokens`: likewise unpublished. pi's schema default (16384) is
 *     the conservative cap to request; inventing context-window-sized
 *     max_tokens against a 1M-context model would send a value the upstream
 *     may reject.
 *
 * The two projections differ in exactly one place, because pi's schemas
 * differ (the same divergence pi-synthetic and pi-cline-pass document):
 * `cost` is OPTIONAL in models.json and MANDATORY on a registered model.
 *
 * No modality gate here, on purpose: the listing publishes a boolean vision
 * flag, not modality arrays, so every row is text or text+image — by
 * construction inside what pi drives, and the d049 gate has no dimension
 * left to judge.
 */

/** @typedef {import("./sources.mjs").ListingRow} ListingRow */

/**
 * @typedef {Record<string, string|null>} ThinkingLevelMap
 */

/**
 * One model, shaped but still schema-agnostic: everything downstream is a
 * projection of this.
 * @typedef {object} MergedModel
 * @property {string} id
 * @property {string} name display name — the listing publishes none, so the
 *   id itself is the honest name
 * @property {string[]} input already pi-shaped (what pi drives, from the
 *   row's vision flag)
 * @property {number|undefined} contextWindow
 * @property {boolean} reasoning
 * @property {string[]|undefined} efforts published reasoning efforts
 * @property {ThinkingLevelMap|null} thinkingLevelMap pi's per-level wire
 *   values, derived ONLY from the published effort enum: a level the
 *   provider does not list is null (pi hides it, docs/d033), and the whole
 *   map is null when no enum was published — nothing is rendered rather
 *   than a wire value invented
 */

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
 * The row's published effort enum, lowercased. `undefined` (not `[]`) when
 * the row publishes none, so the caller can tell "no enum" from "an empty
 * enum".
 * @param {ListingRow} row
 * @returns {string[]|undefined}
 */
export function effortValues(row) {
	const levels = row?.reasoning?.effort_levels;
	if (!Array.isArray(levels) || levels.length === 0) return undefined;
	return levels.map((v) => String(v).toLowerCase());
}

/**
 * The published effort enum → pi's thinking levels. Returns null when the
 * row publishes NO enum: that is not "no reasoning", it is "the source did
 * not say" — the caller renders nothing rather than inventing a wire value
 * the API never advertised (docs/d057's rule for prices, applied to
 * efforts). There is deliberately NO ON_OFF fallback here, matching the
 * fleet row's onOffThinking: false — only a published "none" disables
 * thinking, so a model whose enum lacks it simply offers no off state.
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

/** A finite number, or undefined. */
function num(/** @type {unknown} */ value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value;
}

/**
 * What pi drives, from the row's vision flag: the listing publishes no
 * modality arrays, only whether a model takes images, so text is the
 * always-present core and image rides the flag.
 * @param {ListingRow} row
 * @returns {string[]}
 */
function toInput(row) {
	return row.vision === true ? ["text", "image"] : ["text"];
}

/**
 * Shape one listing row. Returns the model record, or undefined when the row
 * carries no id.
 * @param {ListingRow} row
 * @returns {MergedModel|undefined}
 */
export function shapeRow(row) {
	const id = row?.id;
	if (typeof id !== "string" || id.length === 0) return undefined;
	const efforts = effortValues(row);
	return {
		id,
		name: id,
		input: toInput(row),
		contextWindow: num(row.context_window),
		reasoning: row.reasoning !== undefined,
		efforts,
		thinkingLevelMap: thinkingLevelMapFor(efforts),
	};
}

/**
 * Shape a whole listing into the model list, sorted by id (the canonical
 * order a rerun must reproduce, docs/d050).
 * @param {readonly ListingRow[]} rows
 * @returns {MergedModel[]}
 */
export function shapeListing(rows) {
	/** @type {MergedModel[]} */
	const models = [];
	for (const row of rows ?? []) {
		const model = shapeRow(row);
		if (model) models.push(model);
	}
	return models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ------------------------------ projections -------------------------------- */

/**
 * The models.json model entry — the fields pi's manifest schema takes, and
 * nothing else. No `cost` key at all (the listing publishes no prices,
 * docs/d057) and no `maxTokens` (likewise unpublished; pi's own schema
 * default applies — the fleet row's documented position, see the header).
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
	};
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
 * instead of streaming. Zeros are the correct fill and the honest one: no
 * price was published, and pi already assumes zero for an absent block —
 * which is exactly why the manifest path omits it.
 *
 * `maxTokens` IS carried (the schema default 16384): unlike the manifest,
 * where a missing field falls back to pi's default, the registered-model
 * shape takes the field as given — and 16384 is the schema's own value, not
 * an invented vendor fact.
 *
 * `thinkingLevelMap` is carried when the row published an enum, because its
 * absence makes pi fabricate `off`…`high`, which would advertise an
 * `off` the provider never published AND hide `max`/`xhigh` that it does.
 * @param {MergedModel} model
 * @returns {Record<string, unknown>}
 */
export function toExtensionModel(model) {
	/** @type {Record<string, unknown>} */
	const entry = {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow ?? 128000,
		maxTokens: 16384,
		reasoning: model.reasoning,
		input: model.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	if (model.reasoning && model.thinkingLevelMap) {
		entry.thinkingLevelMap = model.thinkingLevelMap;
	}
	return entry;
}
