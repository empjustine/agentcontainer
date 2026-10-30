/**
 * @fileoverview merge.mjs — the ONE place a listing row becomes a model record,
 * shared by both halves of this folder: generate.mjs renders the result into the
 * committed pi `models.json` provider block, and the extension imports this same
 * file so its runtime shaping is identical.
 *
 * One shape in, one shape out. `shapeListing` turns the provider's raw rows into
 * `MergedModel`s (pi's modality gate, the thinking level map, the cost rule,
 * the alias display name), and the two projections render that one record for
 * their two schemas. Nothing here reads a second catalog: the fold-in of the
 * vendored models.dev/catwalk sources was deleted because it changed no value
 * they did not already have (docs/d096).
 *
 * The two projections differ in exactly two places, both because pi's schemas
 * differ, and both are commented where they happen:
 *   - `cost`: OPTIONAL in `models.json`, MANDATORY on a registered model;
 *   - `thinkingLevelMap`: rendered in both, and required in the extension
 *     because its absence makes pi fabricate levels.
 */

import { ALIAS_TIER_IDS } from "./sources.mjs";

/** @typedef {import("./sources.mjs").ListingRow} ListingRow */

/**
 * @typedef {import("../coding-agent/route-probe.mjs").Cost} Cost
 * @typedef {Record<string, string|null>} ThinkingLevelMap
 */

/**
 * One model, shaped but still schema-agnostic: everything downstream is a
 * projection of this.
 * @typedef {object} MergedModel
 * @property {string} id
 * @property {string} name display name; for an alias row it carries the target
 * @property {string[]} input already pi-shaped (trimmed to what pi drives)
 * @property {string[]|undefined} output the raw published set — kept for
 *   eligibility only, never rendered
 * @property {string} [pointsAt] the model id this row ALIASES (the provider's
 *   category tiers), present only when the row names one — the disambiguation
 *   the display name renders
 * @property {number|undefined} contextWindow
 * @property {number|undefined} maxTokens
 * @property {boolean} reasoning
 * @property {string[]|undefined} efforts published reasoning efforts
 * @property {ThinkingLevelMap|null} thinkingLevelMap pi's per-level wire values,
 *   derived ONLY from the published effort enum: a level the provider does not
 *   list is null (pi hides it, docs/d033), and the whole map is null when no
 *   enum was published — nothing is rendered rather than a wire value invented
 * @property {Cost|undefined} cost a complete four-field block, or undefined
 *   when the listing published no usable prices (docs/d057)
 */

/**
 * pi's driving-capability declaration, copied from the repo's shared projection
 * (coding-agent/gen-lib.mjs PI_MODALITY_CAPABILITY, docs/d049 — copied rather
 * than imported, for the standalone rule): input is trimmed to the modalities
 * pi originates, output must be consumable, and a record without the drivable
 * core cannot be driven at all.
 * @type {Readonly<{input: readonly string[], output: readonly string[]}>}
 */
const PI_MODALITY_CAPABILITY = Object.freeze({
	input: Object.freeze(["text", "image"]),
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
 * The display name a user sees in /model.
 *
 * The provider's category tiers (`syn:large:text` and friends) have ids that
 * never move while the model behind them rotates, so the display name is the
 * only place a user can learn what they are about to talk to. The id stays
 * literal (it is what gets sent) and the target is appended in parentheses —
 * derived from the row, never hand-written, so it cannot go stale.
 * @param {string} id
 * @param {string|undefined} published the row's own display name, if any
 * @param {string|undefined} pointsAt the model this row serves, if it is an alias
 * @returns {string}
 */
export function displayNameFor(id, published, pointsAt) {
	const base = published ?? id;
	return pointsAt ? `${base} (${pointsAt})` : base;
}

/**
 * Whether the display `name` is exactly the one `displayNameFor` produces for
 * this id and target — the only sound way to ask "does this name still describe
 * this mapping?".
 *
 * There is deliberately NO "parse the name back into a target" function: a name
 * is display text, and a model may legitimately be called "Nemotron 3 Super
 * 120B (NVFP4)", whose trailing parenthesis any regex would read as a target.
 * The alias mapping is always carried as data (the seed's `SYNTHETIC_ALIASES`
 * export); this predicate is all the name is used for.
 * @param {string} id row id
 * @param {string|undefined} name the display name to check
 * @param {string} target the candidate alias target
 * @returns {boolean}
 */
export function isAliasName(id, name, target) {
	return name === displayNameFor(id, undefined, target);
}

/**
 * The provider's published effort enum -> pi's thinking levels.
 *
 * Returns null when the row publishes NO enum: that is not "no reasoning", it
 * is "the source did not say", and the caller renders nothing rather than
 * inventing a wire value the API never advertised (docs/d057's rule for prices,
 * applied to efforts).
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
 * pi's "complete or absent" price rule (docs/d057) for the MANIFEST path: the
 * block is optional, but the moment it appears pi requires all four fields, so
 * a partial block is omitted rather than completed with zeros.
 *
 * The extension path does NOT use this — a registered model's `cost` is
 * mandatory and pi dereferences it on every scored turn, so
 * `toExtensionModel` below fills a zero block. That divergence is real and
 * deliberate; see the comment there.
 * @param {Partial<Cost>|undefined} cost
 * @returns {Cost|undefined}
 */
export function piCost(cost) {
	if (!cost) return;
	const { input, output, cacheRead, cacheWrite } = cost;
	if (
		input === undefined ||
		output === undefined ||
		cacheRead === undefined ||
		cacheWrite === undefined
	) {
		return;
	}
	const price = { input, output, cacheRead, cacheWrite };
	return Object.values(price).some((value) => value !== 0) ? price : undefined;
}

/**
 * Whether the row's published modalities fit what pi drives (docs/d049): judge
 * only the dimensions the row actually carries — a missing dimension is
 * unjudgeable and passes, so id-only rows are never dropped for lack of
 * metadata.
 * @param {{input?: string[], output?: string[]}} modalities
 * @returns {boolean}
 */
export function laysWithinPiModalities(modalities) {
	const input = modalities?.input;
	const output = modalities?.output;
	if (input?.length > 0 && !input.includes(PI_MODALITY_CAPABILITY.input[0])) {
		return false;
	}
	if (
		output?.length > 0 &&
		!output.every((o) => PI_MODALITY_CAPABILITY.output.includes(o))
	) {
		return false;
	}
	return true;
}

/**
 * Intersect published input with what pi drives, in capability order, falling
 * back to the drivable core for rows with no modality metadata.
 * @param {string[]|undefined} input
 * @returns {string[]}
 */
function toInput(input) {
	const kept = PI_MODALITY_CAPABILITY.input.filter((m) => input?.includes(m));
	return kept.length > 0 ? [...kept] : [PI_MODALITY_CAPABILITY.input[0]];
}

/* ------------------------------- shaping ---------------------------------- */

/** A string array from an unknown value, or undefined. */
function strings(/** @type {unknown} */ value) {
	return Array.isArray(value) && value.every((v) => typeof v === "string")
		? /** @type {string[]} */ (value)
		: undefined;
}

/**
 * A finite number, or undefined. The listing mixes JSON numbers with
 * dollar-prefixed strings ("$0.0000006"), so the `$` is stripped before
 * parsing — otherwise every string-priced model silently reports no price.
 */
function num(/** @type {unknown} */ value) {
	const raw =
		typeof value === "string" ? value.trim().replace(/^\$/, "") : value;
	if (raw === "" || raw === undefined || raw === null) return;
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

/** A per-million-token price: the wire spells dollars-per-token. */
function perMillion(/** @type {unknown} */ value) {
	const n = num(value);
	return n === undefined ? undefined : Number((n * 1_000_000).toFixed(9));
}

/**
 * The `hf:`-prefixed id the row actually serves, when that differs from the
 * row's own id (the alias case).
 *
 * Read from `hugging_face_id`, which names a MODEL. The sibling `alias_of`
 * field is a display STRING ("DeepSeek V4.1 Flash 10/17") and is deliberately
 * unread: it cannot name a catalog row, so it cannot be a target.
 * @param {ListingRow} row
 * @returns {string|undefined}
 */
function aliasTarget(row) {
	const serves =
		typeof row.hugging_face_id === "string" ? row.hugging_face_id : "";
	if (!serves) return;
	const prefixed = `hf:${serves}`;
	return prefixed === row.id ? undefined : prefixed;
}

/**
 * The listing's effort enum, flattened and lowercased. `undefined` (not `[]`)
 * when the row publishes none, so the caller can tell "no enum" from "an empty
 * enum".
 * @param {ListingRow} row
 * @returns {string[]|undefined}
 */
function effortsOf(row) {
	const efforts = strings(row.reasoning_parameters?.efforts);
	if (!efforts || efforts.length === 0) return;
	return efforts.map((e) => e.toLowerCase());
}

/**
 * Shape one listing row. Returns the model record, or undefined when the row
 * cannot be driven by pi at all (the modality gate) or carries no id.
 * @param {ListingRow} row
 * @returns {MergedModel|undefined}
 */
export function shapeRow(row) {
	if (typeof row?.id !== "string" || row.id.length === 0) return;
	const input = strings(row.input_modalities);
	const output = strings(row.output_modalities);
	// Gate BEFORE projecting: trimming first would turn an audio-only input into
	// the text fallback and admit a model pi cannot drive.
	if (!laysWithinPiModalities({ input, output })) return;
	const pricing = row.pricing ?? {};
	const target = aliasTarget(row);
	return {
		id: row.id,
		...(target ? { pointsAt: target } : {}),
		name: displayNameFor(
			row.id,
			typeof row.display_name === "string" ? row.display_name : undefined,
			target,
		),
		input: toInput(input),
		output,
		contextWindow: num(row.context_length),
		maxTokens: num(row.max_output_length),
		reasoning:
			(strings(row.supported_features)?.includes("reasoning") ?? false) ||
			Boolean(effortsOf(row)?.some((e) => e !== "none")),
		efforts: effortsOf(row),
		thinkingLevelMap: thinkingLevelMapFor(effortsOf(row)),
		cost: piCost({
			input: perMillion(pricing.prompt),
			output: perMillion(pricing.completion),
			cacheRead: perMillion(pricing.input_cache_reads),
			cacheWrite: perMillion(pricing.input_cache_writes),
		}),
	};
}

/**
 * Shape a whole listing into the model list, sorted by id (the canonical order
 * a rerun must reproduce, docs/d050).
 * @param {readonly ListingRow[]} rows
 * @returns {MergedModel[]}
 */
export function shapeListing(rows) {
	/** @type {MergedModel[]} */
	const models = [];
	for (const row of rows) {
		const model = shapeRow(row);
		if (model) models.push(model);
	}
	return models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The alias mapping a shaped lineup implies: tier id -> the model it points at.
 * This is what the generator commits (the seed's `SYNTHETIC_ALIASES`) and what
 * the extension reads back, so the resolution is DATA and never parsed out of a
 * display name.
 * @param {readonly MergedModel[]} models
 * @returns {Record<string, string>}
 */
export function aliasMap(models) {
	/** @type {Record<string, string>} */
	const aliases = {};
	for (const model of models) {
		if (model.pointsAt && ALIAS_TIER_IDS.includes(model.id)) {
			aliases[model.id] = model.pointsAt;
		}
	}
	return aliases;
}

/* ------------------------------ projections -------------------------------- */

/**
 * The models.json model entry — the fields pi's manifest schema takes, and
 * nothing else.
 *
 * `contextWindow`/`maxTokens` fall back to pi's own schema defaults when the
 * listing published nothing, matching the repo's catalog path; those values are
 * the schema's, not an invented vendor fact.
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
	};
	if (model.cost) entry.cost = model.cost;
	if (model.reasoning && model.thinkingLevelMap) {
		entry.thinkingLevelMap = model.thinkingLevelMap;
	}
	return entry;
}

/**
 * The extension's model entry: pi's `ProviderChatModelConfig` surface, verified
 * against `@earendil-works/pi-coding-agent@1.4.0`.
 *
 * Two fields differ from the manifest projection, both for reasons the type
 * declarations and pi-ai's runtime spell out:
 *
 *   - `cost` is MANDATORY on a registered model and `calculateCost()`
 *     dereferences `model.cost.tiers` on every scored turn, so an omitted block
 *     throws instead of streaming. Zeros are the correct fill: pi already
 *     assumes a zero price for an absent block, which is exactly why the
 *     manifest path omits it.
 *   - `thinkingLevelMap` is carried, not optional polish:
 *     `getSupportedThinkingLevels()` fabricates `off`…`high` when no map is
 *     present, which would advertise an `off` the provider never published AND
 *     hide `max`/`xhigh` that it does.
 *
 * No folder-specific field rides along: pi's schema is strict and a vendor
 * field here would be a gamble. The alias mapping lives in the seed's separate
 * `SYNTHETIC_ALIASES` export for the same reason.
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
		compat: {
			supportsReasoningEffort: model.efforts?.length > 0,
		},
	};
	if (model.reasoning && model.thinkingLevelMap) {
		entry.thinkingLevelMap = model.thinkingLevelMap;
	}
	return entry;
}
