/**
 * @fileoverview merge.mjs — the ONE place a listing row becomes a pi model
 * record, for BOTH registered providers.
 *
 * `shapeListing` is the whole shaping step: it decides which rows are chat
 * models at all, drops the tier-suffix rows, and returns the two lineups as one
 * value, so the two `registerProvider` calls cannot disagree about a model's
 * price, limits, compat or reasoning map.
 *
 * The rules, each with the reason it exists:
 *
 *   - NOT a chat model (dropped): `metadata.capabilities.task` present (the
 *     docs: "Present only on models that do not generate text … Such a model
 *     rejects /v1/chat/completions with a 400"), `metadata.deprecated`, or
 *     `metadata.pricing.pricing_tbd` (placeholder prices — pi needs real
 *     numbers for its mandatory `cost` block).
 *   - TIER rows (dropped): `-flex`, `-speed`, `-fast`. The tier is the
 *     extension's own pick (see `TIER_SUFFIX`), so a suffix that encodes it in
 *     the model name is noise in `/model`.
 *   - FLEX capability is read, never assumed: a standard row has Flex iff a
 *     sibling `<id>-flex` row exists with `pricing.service_tier: "flex"`, and
 *     that twin's own four prices are the ones the flex lineup publishes.
 *   - `maxTokens`: `metadata.limits.max_output_tokens`, or the context window
 *     when the provider publishes `null`/0 — "no separate cap applies, prompt
 *     and output share max_context_length". pi clamps the request to the room
 *     left, so a context-sized value means "use what is left", never an
 *     over-limit request. A published cap (16384 on gemma-4-31b) is kept.
 *   - THINKING LEVELS are alias-expanded over `accepted_efforts`, so a legacy
 *     pick keeps working on a model whose distinct levels are fewer: `:high`
 *     on qwen-3.8-27b resolves to `xhigh` through `effort_aliases` instead of
 *     being hidden. `off` is `"none"` unless the model cannot stop reasoning.
 */

import { CHAT_COMPAT, thinkingKwargsFor } from "./compat.mjs";

/** @typedef {import("./sources.mjs").ListingRow} ListingRow */
/** @typedef {import("./sources.mjs").ListingLimits} ListingLimits */
/** @typedef {import("./sources.mjs").ListingReasoning} ListingReasoning */
/**
 * pi's registration surface, and the CHAT arm of its model union — the only
 * arm this folder emits (decision and embedding rows are dropped, not
 * registered). The host's own types, pinned by the folder's devDependency
 * (docs/d107), so a schema field pi changes becomes a tsc finding here.
 * @typedef {import("@earendil-works/pi-coding-agent").ProviderModelConfig} ProviderModelConfig
 * @typedef {Extract<ProviderModelConfig, {reasoning: boolean}>} ProviderChatModelConfig
 */

/** @typedef {Record<string, string|null>} ThinkingLevelMap */

/** @type {readonly string[]} */
const PI_THINKING_LEVELS = Object.freeze([
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/**
 * The tier suffixes this extension refuses to publish. `-flex` is derivable
 * (the sibling row's `pricing.service_tier`), but the other two are this
 * folder's policy and the only remembered strings in it:
 *   - `-speed` is the Speed lane: energy-billed only, and an account billed at
 *     listed token prices is refused with `403
 *     speed_tier_requires_energy_accounting` (/guides/speed-tier). It also
 *     cannot be selected through `service_tier` at all — the request enum is
 *     auto/default/flex, and only the response reports `"speed"`.
 *   - `-fast` is a legacy thinking-off alias of a served model (qwen3.6-35b-fast
 *     is qwen3.6-35b with thinking pinned off, at the same price). The parent
 *     row publishes `"none"` in `accepted_efforts`, so the `off` level
 *     reaches exactly that state — nothing is lost by dropping the row.
 */
const TIER_SUFFIX = /-(?:flex|speed|fast)$/u;

/** @type {string} the body field that picks the tier. */
const SERVICE_TIER_FIELD = "service_tier";

/** A finite number, or undefined. */
function num(/** @type {unknown} */ value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A finite number greater than zero, or undefined. */
function positive(/** @type {unknown} */ value) {
	const n = num(value);
	return n !== undefined && n > 0 ? n : undefined;
}

/** A string array, or undefined when the field is not one. */
function strings(/** @type {unknown} */ value) {
	if (!Array.isArray(value)) {
		return;
	}
	return value.filter((v) => typeof v === "string").map((v) => String(v));
}

/**
 * A chat model, not a decision/embedding model, and not a retired or
 * placeholder-priced row.
 * @param {ListingRow} row
 * @returns {boolean}
 */
export function isChatRow(row) {
	const meta = row?.metadata;
	if (!meta) {
		return false;
	}
	if (meta.deprecated === true) {
		return false;
	}
	if (meta.pricing?.pricing_tbd === true) {
		return false;
	}
	const task = meta.capabilities?.task;
	return !(typeof task === "string" && task.length > 0);
}

/**
 * A row that already publishes the Flex tier (its prices are the discounted
 * ones, per `flex_discount_multiplier`).
 * @param {ListingRow} row
 * @returns {boolean}
 */
export function isFlexRow(row) {
	return row?.metadata?.pricing?.service_tier === "flex";
}

/**
 * The thinking map: every pi level resolved to a wire value the provider
 * accepted, or null (pi hides it).
 *
 * `effort_aliases` wins over identity because it names the level the model is
 * actually served at; the target must still be a published
 * `supported_efforts` value, so a stale alias leaves the level hidden instead
 * of sending a literal the gateway would 400. `off` is `"none"` only when
 * the model both accepts it and can stop reasoning.
 * @param {ListingReasoning|null|undefined} reasoning
 * @returns {ThinkingLevelMap|null}
 */
export function thinkingLevelMapFor(reasoning) {
	if (!reasoning) {
		return null;
	}
	const supported = strings(reasoning.supported_efforts) ?? [];
	const accepted = strings(reasoning.accepted_efforts) ?? supported;
	const aliases = reasoning.effort_aliases ?? {};
	/** @type {ThinkingLevelMap} */
	const map = {};
	map.off =
		reasoning.mandatory === true
			? null
			: accepted.includes("none")
				? "none"
				: null;
	for (const level of PI_THINKING_LEVELS) {
		const alias = aliases[level];
		if (typeof alias === "string" && supported.includes(alias)) {
			map[level] = alias;
			continue;
		}
		map[level] = accepted.includes(level) ? level : null;
	}
	return map;
}

/**
 * What pi drives, from the published modalities: chat completions reads text
 * and image, and `audio` has no pi arm (a model that also takes audio is
 * registered as text+image and loses nothing pi can use). Video never applies —
 * chat completions does not take it.
 * @param {ListingRow} row
 * @returns {("text"|"image")[]}
 */
export function toInput(row) {
	const modalities = row.architecture?.input_modalities;
	if (!Array.isArray(modalities)) {
		return ["text"];
	}
	const input = /** @type {("text"|"image")[]} */ ([]);
	if (modalities.includes("text")) {
		input.push("text");
	}
	if (modalities.includes("image")) {
		input.push("image");
	}
	return input.length > 0 ? input : ["text"];
}

/**
 * The output cap to publish: the provider's own number when it published one,
 * the context window when it published `null` (or the 0 some rows carry) —
 * because "no separate cap applies, prompt and output share
 * max_context_length".
 * @param {unknown} published `metadata.limits.max_output_tokens`
 * @param {number} contextWindow
 * @returns {number}
 */
export function resolveMaxTokens(published, contextWindow) {
	return positive(published) ?? contextWindow;
}

/**
 * The per-message and per-request image limits, only for the numbers the
 * provider published (`null` on a text-only model).
 * @param {ListingLimits} limits
 * @returns {{maxPerMessage?: number, maxPerRequest?: number}|undefined}
 */
function imageLimits(limits) {
	const perMessage = positive(limits.max_images);
	const perRequest = positive(limits.max_images_total);
	if (perMessage === undefined && perRequest === undefined) {
		return;
	}
	return {
		...(perMessage === undefined ? {} : { maxPerMessage: perMessage }),
		...(perRequest === undefined ? {} : { maxPerRequest: perRequest }),
	};
}

/**
 * The body fields this extension adds: the tier pick and the family's
 * thinking-preservation kwarg. Absent when neither applies, so a standard-tier
 * model with no kwarg sends no `samplingParams` at all.
 * @param {string|null|undefined} huggingfaceId
 * @param {boolean} flex
 * @returns {Record<string, unknown>|undefined}
 */
function samplingParamsFor(huggingfaceId, flex) {
	const kwargs = thinkingKwargsFor(huggingfaceId);
	if (!flex && !kwargs) {
		return;
	}
	/** @type {Record<string, unknown>} */
	const params = {};
	if (flex) {
		params[SERVICE_TIER_FIELD] = "flex";
	}
	if (kwargs) {
		params.chat_template_kwargs = kwargs;
	}
	return params;
}

/**
 * The published display name, else the id.
 * @param {ListingRow} row
 * @returns {string}
 */
function displayName(row) {
	const name = row.metadata?.display_name;
	return typeof name === "string" && name.length > 0 ? name : row.id;
}

/**
 * Shape one row, or undefined when it carries nothing publishable (no metadata,
 * no usable context window).
 * @param {ListingRow} row
 * @param {{id?: string, name?: string, flex?: boolean}} [overrides]
 * @returns {ProviderChatModelConfig|undefined}
 */
function toModel(row, overrides = {}) {
	const meta = row.metadata;
	if (!meta) {
		return;
	}
	const limits = meta.limits ?? {};
	const pricing = meta.pricing ?? {};
	const capabilities = meta.capabilities ?? {};
	const contextWindow =
		positive(row.max_model_len) ?? positive(limits.max_context_length);
	if (contextWindow === undefined) {
		return;
	}
	const input = toInput(row);
	/** @type {ProviderChatModelConfig} */
	const model = {
		id: overrides.id ?? row.id,
		name: overrides.name ?? displayName(row),
		contextWindow,
		maxTokens: resolveMaxTokens(limits.max_output_tokens, contextWindow),
		reasoning: capabilities.reasoning === true,
		input,
		cost: {
			input: num(pricing.input_per_million) ?? 0,
			output: num(pricing.output_per_million) ?? 0,
			cacheRead: num(pricing.cached_input_per_million) ?? 0,
			cacheWrite: 0,
		},
		compat: {
			...CHAT_COMPAT,
			supportsReasoningEffort: capabilities.reasoning_effort === true,
		},
	};
	if (model.reasoning) {
		const map = thinkingLevelMapFor(meta.reasoning);
		if (map) {
			model.thinkingLevelMap = map;
		}
	}
	if (input.includes("image")) {
		const images = imageLimits(limits);
		if (images) {
			model.inputLimits = { images };
		}
	}
	const samplingParams = samplingParamsFor(meta.huggingface_id, overrides.flex === true);
	if (samplingParams) {
		model.samplingParams = samplingParams;
	}
	return model;
}

/** Canonical order (docs/d050): a rerun must reproduce the same list. */
function byId(/** @type {ProviderChatModelConfig[]} */ models) {
	return models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The whole shaping step: one listing in, the two lineups out.
 *
 * A standard row appears in `standard` always, and in `flex` only when the
 * listing proves Flex capacity by carrying its twin. Model ids are the STANDARD
 * ones in both lineups — the tier is a request field, not a name — so the same
 * conversation keeps its wire model name (and prompt cache) across a tier
 * switch.
 * @param {readonly ListingRow[]} rows
 * @returns {{standard: ProviderChatModelConfig[], flex: ProviderChatModelConfig[]}}
 */
export function shapeListing(rows) {
	const chat = (rows ?? []).filter(isChatRow);
	const byIdMap = new Map(chat.map((row) => [row.id, row]));
	/** @type {ProviderChatModelConfig[]} */
	const standard = [];
	/** @type {ProviderChatModelConfig[]} */
	const flex = [];
	for (const row of chat) {
		if (TIER_SUFFIX.test(row.id)) {
			continue;
		}
		const model = toModel(row);
		if (!model) {
			continue;
		}
		standard.push(model);
		const twin = byIdMap.get(`${row.id}-flex`);
		if (!twin || !isFlexRow(twin)) {
			continue;
		}
		const flexModel = toModel(twin, {
			id: row.id,
			name: displayName(row),
			flex: true,
		});
		if (flexModel) {
			flex.push(flexModel);
		}
	}
	return { standard: byId(standard), flex: byId(flex) };
}
