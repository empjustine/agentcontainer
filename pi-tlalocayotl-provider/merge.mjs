/**
 * @fileoverview merge.mjs — the ONE place a llama-swap listing row becomes a
 * model record. The extension is the only consumer: `refreshModels` imports
 * this file and maps the result through `toExtensionModel`, so the shape a
 * user sees is exactly the shape this file builds (one shape in, one shape
 * out; docs/d096's folder contract, applied here).
 *
 * Two classes of fact live here, and the split is why the file exists:
 *   - what the LISTING publishes (window, output cap, input modalities,
 *     reasoning flag), read field by field with a fallback chain each; and
 *   - what the listing cannot carry — the wire-compat block, transcribed from
 *     the host's own llama.cpp provider (see LLAMA_CPP_WIRE_COMPAT).
 *
 * Deliberate absences:
 *   - NO cost from the source: llama-swap is the operator's own inference host
 *     and its listing publishes no prices, so the registration's mandatory
 *     block is the honest zeros rather than an invented number.
 *   - NO status filter: an unloaded model is still routable (llama-swap starts
 *     the backend on the first request), so publishing only resident models
 *     would hide the catalog the gateway exists to serve.
 *   - NO display name invented: the config's `name` when it publishes one, else
 *     the id — GGUF repo plus quant tag, which is what the gateway routes on.
 */

/** @typedef {import("./sources.mjs").ListingRow} ListingRow */
/**
 * pi's registration surface, and the CHAT arm of its model union — the arm this
 * folder always emits (no `type` field; pi normalizes that to "chat"). The
 * host's own types, pinned by the folder's devDependency (docs/d107), so a
 * schema field pi changes becomes a tsc finding here.
 * @typedef {import("@earendil-works/pi-coding-agent").ProviderModelConfig} ProviderModelConfig
 * @typedef {Extract<ProviderModelConfig, {reasoning: boolean}>} ProviderChatModelConfig
 */

/** @typedef {Record<string, string|null>} ThinkingLevelMap */

/**
 * One model, shaped but still schema-agnostic: everything downstream is a
 * projection of this.
 * @typedef {object} MergedModel
 * @property {string} id
 * @property {string} name the config's `name`, or the id when it published none
 * @property {("text"|"image")[]} input already pi-shaped
 * @property {number|undefined} contextWindow the gateway's published window
 * @property {number|undefined} maxTokens the gateway's published output cap,
 *   or the window when it published none (prompt and output share it)
 * @property {boolean} reasoning
 */

/**
 * The gateway's wire-compat facts, TRANSCRIBED from the host's own llama.cpp
 * provider (`@earendil-works/pi-coding-agent@1.5.2`
 * `dist/extensions/llama/provider.js`, `toPiModel`) — llama-swap starts and
 * fronts llama-server backends, so the OpenAI surface pi already binds for
 * llama.cpp is this one, not a guess about a generic gateway. It is the
 * folder's ONE behavioral copy (pi-hyper's HYPER_WIRE_COMPAT is the same
 * kind of transcription): upstream can revise the table and this mirror has
 * no tripwire, so re-read that file before changing a value here.
 *
 * `thinkingFormat` is the one per-model member — only a model that published
 * reasoning gets "qwen-chat-template" — so `compatFor` adds it rather than
 * this table carrying it.
 * @type {Readonly<{
 *   supportsStore: false,
 *   supportsDeveloperRole: false,
 *   supportsReasoningEffort: false,
 *   supportsUsageInStreaming: true,
 *   supportsStrictMode: false,
 *   maxTokensField: "max_tokens",
 * }>}
 */
const LLAMA_CPP_WIRE_COMPAT = Object.freeze({
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
});

/**
 * The thinking map for a reasoning model, transcribed with the same file:
 * llama.cpp's reasoning control is a template switch (`enable_thinking`), not
 * an effort ladder, so `off` disables it, `medium` is the single
 * representative "on" state, and everything between is unsupported. Only
 * valid paired with `thinkingFormat: "qwen-chat-template"` and
 * `supportsReasoningEffort: false`, which is exactly the pair
 * `LLAMA_CPP_WIRE_COMPAT` + `compatFor` produce.
 * @type {Readonly<ThinkingLevelMap>}
 */
const LLAMA_CPP_THINKING_LEVEL_MAP = Object.freeze({
	off: "off",
	minimal: null,
	low: null,
	medium: "medium",
	high: null,
	xhigh: null,
});

/** A finite number, or undefined. */
function num(/** @type {unknown} */ value) {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** A finite number greater than zero, or undefined. */
function positive(/** @type {unknown} */ value) {
	const n = num(value);
	return n !== undefined && n > 0 ? n : undefined;
}

/**
 * Whether the row is a chat model at all. llama.cpp reports decision models
 * (TypeSafe's System One family) by publishing `decisions` in
 * `architecture.output_modalities`; such a row rejects
 * `/v1/chat/completions`, and this folder registers no classifier arm, so it
 * is dropped. A row that omits `architecture` entirely (older builds) is
 * treated as chat — the host's own llama.cpp provider makes the same call.
 * @param {ListingRow} row
 * @returns {boolean}
 */
export function isChatRow(row) {
	const outputs = row?.architecture?.output_modalities;
	if (!Array.isArray(outputs)) {
		return true;
	}
	return outputs.includes("text");
}

/**
 * The context window to publish, by the order the gateway itself states it:
 * the window llama-swap starts the backend with (`meta.llamaswap.contextWindow`),
 * then the OpenAI-style `context_window`, then `context_length`, then the
 * backend's runtime `meta.n_ctx`. `undefined` when the row carries none —
 * pi's schema default takes over at the projection rather than a window being
 * invented here.
 * @param {ListingRow} row
 * @returns {number|undefined}
 */
export function contextWindowFor(row) {
	return (
		positive(row?.meta?.llamaswap?.contextWindow) ??
		positive(row?.context_window) ??
		positive(row?.context_length) ??
		positive(row?.meta?.n_ctx)
	);
}

/**
 * The output cap: the gateway's published `meta.llamaswap.maxTokens`, else the
 * context window — llama.cpp draws prompt and output from ONE window, so the
 * window is the correct ceiling when no separate cap was published (pi clamps
 * each request to the room left; the host's llama.cpp provider publishes
 * `maxTokens: contextWindow` for the same reason).
 * @param {ListingRow} row
 * @param {number|undefined} contextWindow
 * @returns {number|undefined}
 */
export function maxTokensFor(row, contextWindow) {
	return positive(row?.meta?.llamaswap?.maxTokens) ?? contextWindow;
}

/**
 * Whether the backend template reasons, as the gateway publishes it. Absent
 * means "not stated", which is not a guess: the model is registered as a
 * non-reasoning chat model, exactly what pi's defaults drive.
 * @param {ListingRow} row
 * @returns {boolean}
 */
export function isReasoningRow(row) {
	return row?.meta?.llamaswap?.reasoning === true;
}

/**
 * The row's input modalities as arrays, in the order the gateway states them:
 * its own `meta.llamaswap.input`, then `architecture.input_modalities`, and
 * only when neither is an array, the `capabilities.vision` boolean (which
 * cannot say more than "takes images").
 * @param {ListingRow} row
 * @returns {string[]|undefined}
 */
export function publishedModalities(row) {
	const fromGateway = row?.meta?.llamaswap?.input;
	if (Array.isArray(fromGateway)) {
		return fromGateway;
	}
	const fromArchitecture = row?.architecture?.input_modalities;
	if (Array.isArray(fromArchitecture)) {
		return fromArchitecture;
	}
	return row?.capabilities?.vision === true ? ["text", "image"] : undefined;
}

/**
 * What pi drives, from the published modalities: chat completions reads text
 * and image, and `audio` has no pi arm (a model that also takes audio is
 * registered as text+image and loses nothing pi can use). An empty or missing
 * list means text — the one modality every chat model here serves.
 * @param {ListingRow} row
 * @returns {("text"|"image")[]}
 */
export function toInput(row) {
	const modalities = publishedModalities(row);
	if (!modalities) {
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
 * The published display name, else the id. llama-swap publishes `name` only when
 * the model's config sets one (peer rows carry `"<peer>: <model>"`), so an
 * absent field is the common case rather than an error.
 * @param {ListingRow} row
 * @returns {string}
 */
export function nameFor(row) {
	const name = row?.name?.trim();
	return name ? name : row.id;
}

/**
 * Shape one listing row, or undefined when it carries no id.
 * @param {ListingRow} row
 * @returns {MergedModel|undefined}
 */
export function shapeRow(row) {
	const id = row?.id;
	if (typeof id !== "string" || id.length === 0) {
		return;
	}
	const contextWindow = contextWindowFor(row);
	return {
		id,
		name: nameFor(row),
		input: toInput(row),
		contextWindow,
		maxTokens: maxTokensFor(row, contextWindow),
		reasoning: isReasoningRow(row),
	};
}

/**
 * Shape the whole listing into the model list: non-chat rows (decision
 * models) dropped, canonical id order so a rerun reproduces the same list
 * (docs/d050).
 * @param {readonly ListingRow[]} rows
 * @returns {MergedModel[]}
 */
export function shapeListing(rows) {
	/** @type {MergedModel[]} */
	const models = [];
	for (const row of rows ?? []) {
		if (!isChatRow(row)) {
			continue;
		}
		const model = shapeRow(row);
		if (model) {
			models.push(model);
		}
	}
	return models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The wire-compat facts for one model: the transcribed block plus the one
 * conditional member the reasoning flag decides.
 * @param {boolean} reasoning
 * @returns {NonNullable<ProviderChatModelConfig["compat"]>}
 */
export function compatFor(reasoning) {
	return {
		...LLAMA_CPP_WIRE_COMPAT,
		...(reasoning
			? {
					thinkingFormat: /** @type {"qwen-chat-template"} */ (
						"qwen-chat-template"
					),
				}
			: {}),
	};
}

/* ------------------------------ projection --------------------------------- */

/**
 * The extension's model entry: pi's `ProviderChatModelConfig` surface.
 *
 * `cost` is MANDATORY on a registered model and `calculateCost()`
 * dereferences the block on every scored turn, so an omitted block throws
 * instead of streaming. Zeros are the correct and honest fill: the listing
 * publishes no prices, and pi already assumes zero for an absent block.
 *
 * `contextWindow` falls back to pi's schema default (128 000) only when the
 * row published nothing; `maxTokens` then defaults to the window, never to a
 * smaller invented cap.
 *
 * `thinkingLevelMap` rides every reasoning model: its absence makes pi
 * fabricate `off`…`high`, which would advertise an effort ladder llama.cpp
 * does not have.
 * @param {MergedModel} model
 * @returns {ProviderChatModelConfig}
 */
export function toExtensionModel(model) {
	const contextWindow = model.contextWindow ?? 128_000;
	/** @type {ProviderChatModelConfig} */
	const entry = {
		id: model.id,
		name: model.name,
		contextWindow,
		maxTokens: model.maxTokens ?? contextWindow,
		reasoning: model.reasoning,
		input: model.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: compatFor(model.reasoning),
	};
	if (model.reasoning) {
		entry.thinkingLevelMap = { ...LLAMA_CPP_THINKING_LEVEL_MAP };
	}
	return entry;
}
