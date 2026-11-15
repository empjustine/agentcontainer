/**
 * @fileoverview merge.mjs — the one place a published lineup entry becomes a
 * pi model record, and the only shaping this folder has: generate.mjs renders
 * the result into the committed pi `models.json` provider block, and the
 * extension imports this same file, so a runtime model and a committed one
 * cannot drift.
 *
 * Every field besides the id and the display name is pi's own schema default,
 * because no source publishes one for these ids (docs/d189): the docs table
 * names the ids, and the reference prices it prints are not what a subscriber
 * pays — a flat subscription bills the quota, not the token.
 *
 * The two projections differ exactly where pi's schemas do, and one rule
 * covers all three cases — the manifest never states what no source stated,
 * the registration writes the schema default the API requires:
 *
 *   - cost: optional in `models.json`, mandatory on a registration; the
 *     extension writes the zero block, the manifest says nothing.
 *   - limits: optional in `models.json` (pi applies 128000/16384 itself), so
 *     the manifest omits them and the extension restates them as the default.
 *   - compat: provider-level in `models.json`, per-model on a registration,
 *     because pi's `ProviderConfig` has no provider-level compat slot and the
 *     provider composer replaces the `models.json` layer wholesale (d022, d033).
 *
 * Deliberately absent: alias tiers (ClinePass publishes no rotating tier ids)
 * and a thinking-level map (no source publishes an effort enum for these ids,
 * so `reasoning` stays false and pi sends no thinking parameter).
 */


import { CLINE_PASS_ID_PREFIX } from "./sources.mjs";
/** @typedef {import("./sources.mjs").LineupEntry} LineupEntry */

/**
 * What a registration needs and a `models.json` entry may omit: pi dereferences
 * `cost` on every scored turn, and the schema's own defaults are the only
 * non-invented limits available here (docs/d189).
 * @typedef {object} ExtensionModel
 * @property {string} id
 * @property {string} name
 * @property {boolean} reasoning
 * @property {string[]} input
 * @property {number} contextWindow
 * @property {number} maxTokens
 * @property {{input: number, output: number, cacheRead: number, cacheWrite: number}} cost
 * @property {Readonly<{supportsDeveloperRole: boolean}>} compat
 */

/**
 * The gateway's ONE compat fact (docs/d022, docs/d033): ClinePass rejects the
 * `developer` role pi-ai emits for reasoning models — both reference
 * extensions force it off, and without it those models answer 400.
 * @type {Readonly<{supportsDeveloperRole: boolean}>}
 */
export const CLINE_PASS_COMPAT = Object.freeze({
	supportsDeveloperRole: false,
});

/**
 * One published model, still schema-agnostic: the id in the billing namespace
 * and the table's display name, nothing else.
 * @typedef {object} MergedModel
 * @property {string} id
 * @property {string} name
 */

/**
 * Shape the lineup into the emitted rows: drop an id outside the billing
 * namespace (docs/d040) and sort by id — the canonical order a rerun must
 * reproduce, so a table reorder never shows up as an artifact diff.
 * @param {readonly LineupEntry[]} lineup
 * @returns {MergedModel[]}
 */
export function shapeCatalog(lineup) {
	return lineup
		.filter((entry) => entry.id.startsWith(CLINE_PASS_ID_PREFIX))
		.map(({ id, name }) => ({ id, name }))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The pi `models.json` entry for one model: the id and the name, which is the
 * whole of what a published source stated.
 * @param {MergedModel} model
 * @returns {{id: string, name: string}}
 */
export function toPiModel({ id, name }) {
	return { id, name };
}

/**
 * The extension projection: the registration schema requires the fields
 * `models.json` may omit, so they carry pi's own defaults
 * (docs/models-configuration.md) and cost is the zero block — the subscription
 * is not billed per token.
 * @param {MergedModel} model
 * @returns {ExtensionModel}
 */
export function toExtensionModel({ id, name }) {
	return {
		id,
		name,
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: CLINE_PASS_COMPAT,
	};
}
