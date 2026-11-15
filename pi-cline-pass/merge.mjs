/**
 * @fileoverview merge.mjs — the one place a published lineup entry becomes a
 * registered pi model: the extension maps the table through `shapeCatalog`
 * and `toExtensionModel`, and nothing else reads a model shape.
 *
 * Every field besides id and display name is pi's own schema default, because
 * no source publishes one for these ids (docs/d189). `cost` is the one field
 * the registration schema requires and no source supplies: a subscription
 * bills the quota, not the token, so the honest block is zero.
 *
 * Deliberately absent: alias tiers (ClinePass publishes no rotating tier ids)
 * and a thinking-level map (no source publishes an effort enum, so
 * `reasoning` stays false and pi sends no thinking parameter).
 */

import { CLINE_PASS_ID_PREFIX } from "./sources.mjs";
/** @typedef {import("./sources.mjs").LineupEntry} LineupEntry */

/**
 * pi's registration surface for one model.
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
 * `developer` role pi-ai emits for reasoning models, and without this those
 * models answer 400.
 * @type {Readonly<{supportsDeveloperRole: boolean}>}
 */
export const CLINE_PASS_COMPAT = Object.freeze({
	supportsDeveloperRole: false,
});

/**
 * One published model, still schema-agnostic: the id in the billing namespace
 * and the table's display name.
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
 * The extension projection: pi's schema requires the fields a lineup entry
 * does not carry, so they carry its documented defaults and the zero cost
 * block (docs/models-configuration.md).
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
