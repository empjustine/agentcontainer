/**
 * @fileoverview pi-neuralwatt.test.mjs — the folder's rules, pinned.
 *
 * Everything here works on plain records or injects its own fetch, so the suite
 * needs no network and no key. The assertions pin RULES (which rows survive,
 * what a null limit becomes, how an alias resolves, what the body carries),
 * never today's lineup: a lineup assertion would fail on every provider rotation
 * and teach nothing.
 *
 * Run: node --test   (from this folder — discovers tests/*.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
	isChatRow,
	isFlexRow,
	resolveMaxTokens,
	shapeListing,
	thinkingLevelMapFor,
	toInput,
} = await import("../merge.mjs");
const {
	baseUrlFromEnv,
	fetchListing,
	listingUrl,
	NEURALWATT_API_KEY_ENV,
	NEURALWATT_BASE_URL,
	PROVIDER_IDS,
	storeIsFresh,
} = await import("../sources.mjs");
const { CHAT_COMPAT, THINKING_KWARGS, thinkingKwargsFor } = await import(
	"../compat.mjs"
);

// The fact-table row lives in ../sources.mjs (one row per folder, docs/d113).
// These literals are the independent copy every consumer is pinned against, so a
// base-url, key-env or provider-id edit there cannot pass silently
// (docs/d024/d070).
/**
 * The two shaping entry points, typed loosely on purpose: the assertions below
 * read through the host's model/compat union, and the project is about
 * behaviour, not about re-proving pi's schema inside every test.
 * @type {any}
 */
const lineups = (/** @type {any} */ rows) => shapeListing(rows);
/** @type {any} */
const levels = (/** @type {any} */ block) => thinkingLevelMapFor(block);

const FACT_BASE_URL = "https://api.neuralwatt.com/v1";
const FACT_API_KEY_ENV = "NEURALWATT_API_KEY";
const FACT_PROVIDER_IDS = {
	flex: "neuralwatt-flex",
	standard: "neuralwatt-standard",
};

/**
 * One listing row with the shapes the provider actually publishes, every field
 * overridable so a test names only its own concern.
 * @param {string} id
 * @param {any} [over]
 * @returns {any}
 */
const row = (id, over = {}) => {
	const maxModelLen = over.max_model_len ?? 262_128;
	return {
		id,
		max_model_len: maxModelLen,
		architecture: {
			input_modalities: over.input_modalities ?? ["text"],
		},
		metadata: {
			display_name: over.display_name ?? id,
			huggingface_id: over.huggingface_id ?? null,
			deprecated: over.deprecated ?? false,
			pricing: {
				input_per_million: 1,
				output_per_million: 2,
				cached_input_per_million: 0.1,
				...over.pricing,
			},
			capabilities: {
				vision: false,
				reasoning: false,
				reasoning_effort: false,
				developer_role: false,
				...over.capabilities,
			},
			reasoning: over.reasoning ?? null,
			limits: {
				max_context_length: maxModelLen,
				max_output_tokens: null,
				max_images: null,
				max_images_total: null,
				...over.limits,
			},
		},
	};
};

/**
 * The Flex twin of a row: same model, service_tier "flex", discounted prices.
 * Overrides land on the standard row, so a pair is one call.
 * @param {string} id
 * @param {any} [over]
 * @returns {any}
 */
const flexTwin = (id, over = {}) =>
	row(id + "-flex", {
		...over,
		display_name: over.display_name ?? id,
		pricing: {
			input_per_million: 0.65,
			output_per_million: 1.3,
			cached_input_per_million: 0.065,
			service_tier: "flex",
			flex_discount_multiplier: 0.65,
			...over.pricing,
		},
	});

/** A reasoning block with the provider's shape. */
const reasoning = (over = {}) => ({
	mandatory: false,
	supported_efforts: ["max", "high", "low", "none"],
	accepted_efforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
	effort_aliases: { xhigh: "max", medium: "high", minimal: "low" },
	...over,
});

test("the fact-table row is pinned: one upstream, one key env, two provider ids", () => {
	assert.equal(NEURALWATT_BASE_URL, FACT_BASE_URL);
	assert.equal(NEURALWATT_API_KEY_ENV, FACT_API_KEY_ENV);
	assert.deepEqual({ ...PROVIDER_IDS }, FACT_PROVIDER_IDS);
	assert.equal(listingUrl(), FACT_BASE_URL + "/models");
});

test("a base-url override is absolute-http(s), trailing-slash-trimmed, loud when malformed", () => {
	assert.equal(
		baseUrlFromEnv(FACT_API_KEY_ENV, FACT_BASE_URL, {
			NEURALWATT_BASE_URL: "https://gateway.example/v1/",
		}),
		"https://gateway.example/v1",
	);
	assert.equal(baseUrlFromEnv(FACT_API_KEY_ENV, FACT_BASE_URL, {}), FACT_BASE_URL);
	assert.throws(
		() =>
			baseUrlFromEnv(FACT_API_KEY_ENV, FACT_BASE_URL, {
				NEURALWATT_BASE_URL: "gateway.example",
			}),
		/NEURALWATT_BASE_URL is not an absolute http\(s\) URL/,
	);
});

test("non-chat rows are dropped: decision/embedding task, deprecated, placeholder pricing", () => {
	assert.equal(isChatRow(row("chat")), true);
	assert.equal(
		isChatRow(row("decision", { capabilities: { task: "decision" } })),
		false,
	);
	assert.equal(
		isChatRow(row("embed", { capabilities: { task: "embed" } })),
		false,
	);
	assert.equal(isChatRow(row("retired", { deprecated: true })), false);
	assert.equal(
		isChatRow(row("tbd", { pricing: { pricing_tbd: true } })),
		false,
	);
	assert.equal(isChatRow(/** @type {any} */ ({ id: "bare" })), false);
});

test("tier-suffix rows are dropped and a flex twin is recognised by its own price marker", () => {
	const rows = [row("m"), flexTwin("m"), row("m-fast"), row("m-speed")];
	const { standard, flex } = lineups(rows);
	assert.deepEqual(
		standard.map((/** @type {any} */ model) => model.id),
		["m"],
		"the suffix rows never reach a lineup",
	);
	assert.deepEqual(
		flex.map((/** @type {any} */ model) => model.id),
		["m"],
	);
	assert.equal(isFlexRow(rows[1]), true);
	assert.equal(isFlexRow(rows[0]), false);
});

test("the two lineups share the model ids; a row without a twin is standard-only", () => {
	const rows = [
		row("twin"),
		flexTwin("twin"),
		row("loner", { display_name: "The Loner" }),
	];
	const { standard, flex } = lineups(rows);
	assert.deepEqual(
		standard.map((/** @type {any} */ model) => model.id),
		["loner", "twin"],
	);
	assert.deepEqual(
		flex.map((/** @type {any} */ model) => model.id),
		["twin"],
		"no twin means no Flex capability, never a guess",
	);
});

test("the flex lineup publishes the STANDARD id and name at the twin's prices, with service_tier in the body", () => {
	const rows = [
		row("m", {
			display_name: "Model M",
			pricing: { input_per_million: 1, output_per_million: 2 },
		}),
		flexTwin("m", {
			pricing: { input_per_million: 0.65, output_per_million: 1.3 },
		}),
	];
	const { standard, flex } = lineups(rows);
	const standardModel = standard[0];
	const flexModel = flex[0];
	assert.equal(flexModel.id, "m");
	assert.equal(flexModel.name, "Model M");
	assert.deepEqual(flexModel.cost, {
		input: 0.65,
		output: 1.3,
		cacheRead: 0.065,
		cacheWrite: 0,
	});
	assert.deepEqual(standardModel.cost, {
		input: 1,
		output: 2,
		cacheRead: 0.1,
		cacheWrite: 0,
	});
	assert.equal(flexModel.samplingParams.service_tier, "flex");
	assert.equal(
		"samplingParams" in standardModel,
		false,
		"absence of the field IS the standard tier",
	);
});

test("maxTokens: a published cap is kept, null and 0 fall back to the context window", () => {
	assert.equal(resolveMaxTokens(16_384, 262_128), 16_384);
	assert.equal(resolveMaxTokens(null, 262_128), 262_128);
	assert.equal(resolveMaxTokens(0, 262_128), 262_128);
	assert.equal(resolveMaxTokens(undefined, 262_128), 262_128);
	const capped = lineups([
		row("capped", { limits: { max_output_tokens: 16_384 } }),
	]).standard[0];
	assert.equal(capped.maxTokens, 16_384);
	const shared = lineups([row("shared")]).standard[0];
	assert.equal(shared.maxTokens, 262_128, "prompt and output share the window");
});

test("cost is the published price or zero, and cacheWrite is always zero", () => {
	const model = lineups([
		row("free", {
			pricing: {
				input_per_million: null,
				output_per_million: null,
				cached_input_per_million: null,
			},
		}),
	]).standard[0];
	assert.deepEqual(model.cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

test("input is the published modalities intersected with what chat completions reads", () => {
	assert.deepEqual(toInput(row("text")), ["text"]);
	assert.deepEqual(
		toInput(row("vision", { input_modalities: ["text", "image"] })),
		["text", "image"],
	);
	assert.deepEqual(
		toInput(row("audio", { input_modalities: ["text", "image", "audio"] })),
		["text", "image"],
		"audio has no pi arm and is not invented",
	);
	assert.deepEqual(toInput(row("weird", { input_modalities: [] })), ["text"]);
});

test("image limits come from the published numbers, and are absent when none are published", () => {
	const withLimits = lineups([
		row("img", {
			input_modalities: ["text", "image"],
			limits: { max_images: 4, max_images_total: 200 },
		}),
	]).standard[0];
	assert.deepEqual(withLimits.inputLimits, {
		images: { maxPerMessage: 4, maxPerRequest: 200 },
	});
	const textOnly = lineups([
		row("txt", { limits: { max_images: null, max_images_total: null } }),
	]).standard[0];
	assert.equal("inputLimits" in textOnly, false);
});

test("thinking levels are alias-expanded so a legacy pick keeps working", () => {
	// qwen-3.8-27b's shape: four distinct levels, seven accepted, aliases for
	// the rest. A user's :high pick must resolve to the served xhigh.
	const map = levels(
		reasoning({
			supported_efforts: ["xhigh", "medium", "low", "none"],
			effort_aliases: { max: "xhigh", high: "xhigh", minimal: "low" },
		}),
	);
	assert.deepEqual(map, {
		off: "none",
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "xhigh",
		xhigh: "xhigh",
		max: "xhigh",
	});
	// glm-5.3's shape: reasoning cannot be turned off.
	const mandatory = levels(
		reasoning({
			mandatory: true,
			supported_efforts: ["max", "high", "low"],
			accepted_efforts: ["max", "xhigh", "high", "medium", "low", "minimal"],
			effort_aliases: { xhigh: "max", medium: "high", minimal: "low" },
		}),
	);
	assert.equal(mandatory.off, null);
	assert.equal(mandatory.medium, "high");
	assert.equal(levels(null), null);
});

test("an alias whose target the provider does not publish falls back to the identity the gateway accepts", () => {
	const aliased = levels(
		reasoning({
			supported_efforts: ["high", "none"],
			effort_aliases: { max: "not-a-published-level" },
		}),
	);
	assert.equal(aliased.max, "max", "accepted_efforts still admits the literal");
	assert.equal(aliased.high, "high");
	const rejected = levels(
		reasoning({
			supported_efforts: ["high", "none"],
			accepted_efforts: ["high", "none"],
			effort_aliases: {},
		}),
	);
	assert.equal(rejected.max, null, "neither accepted nor aliased: hidden");
});

test("a non-reasoning model carries no thinking map, and a missing block invents nothing", () => {
	const plain = lineups([row("plain")]).standard[0];
	assert.equal("thinkingLevelMap" in plain, false);
	const declared = lineups([
		row("declared", { capabilities: { reasoning: true }, reasoning: null }),
	]).standard[0];
	assert.equal(declared.reasoning, true);
	assert.equal("thinkingLevelMap" in declared, false);
});

test("compat is the documented four, and supportsReasoningEffort follows the per-model flag", () => {
	assert.equal(CHAT_COMPAT.supportsDeveloperRole, false);
	assert.equal(
		CHAT_COMPAT.requiresReasoningContentOnAssistantMessages,
		false,
	);
	assert.equal(CHAT_COMPAT.maxTokensField, "max_completion_tokens");
	const model = lineups([
		row("m", { capabilities: { reasoning: true, reasoning_effort: true } }),
	]).standard[0];
	assert.equal(model.compat.supportsDeveloperRole, false);
	assert.equal(model.compat.supportsReasoningEffort, true);
	assert.equal(model.compat.maxTokensField, "max_completion_tokens");
});

test("the thinking-preservation kwarg is keyed by huggingface_id, so a tracking alias follows its model", () => {
	assert.ok(THINKING_KWARGS["Qwen/Qwen3.6-35B-A3B-FP8"]);
	assert.deepEqual(thinkingKwargsFor("deepseek-ai/DeepSeek-V4.1-Flash-1017"), {
		drop_thinking: false,
	});
	assert.equal(thinkingKwargsFor("zai-org/GLM-5.3"), undefined);
	assert.equal(thinkingKwargsFor(null), undefined);
	// The alias nw-flash points at the DeepSeek model, so it gets its kwarg; the
	// same row under another family would not.
	const rows = [
		row("nw-flash", {
			huggingface_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
		}),
		flexTwin("nw-flash", {
			huggingface_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
		}),
	];
	const { standard, flex } = lineups(rows);
	assert.deepEqual(standard[0].samplingParams, {
		chat_template_kwargs: { drop_thinking: false },
	});
	assert.deepEqual(flex[0].samplingParams, {
		service_tier: "flex",
		chat_template_kwargs: { drop_thinking: false },
	});
});

test("the store TTL is the refresh gate, not an absolute clock", () => {
	assert.equal(storeIsFresh(Date.now() - 60_000), true);
	assert.equal(storeIsFresh(Date.now() - 5 * 60 * 60 * 1000), false);
});

test("fetchListing composes the caller signal and throws on a bad answer", async () => {
	/** @type {any} */
	let seen;
	await fetchListing({
		fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
			seen = { url, init };
			return {
				ok: true,
				status: 200,
				json: async () => ({ data: [{ id: "x" }] }),
			};
		}),
	});
	assert.equal(seen.url, listingUrl());
	assert.ok(seen.init.signal, "fetch was called with a signal");
	await assert.rejects(
		() =>
			fetchListing({
				fetchImpl: /** @type {any} */ (
					async () => ({ ok: false, status: 503, json: async () => ({}) })
				),
			}),
		/answered 503/,
	);
	await assert.rejects(
		() =>
			fetchListing({
				fetchImpl: /** @type {any} */ (
					async () => ({
						ok: true,
						status: 200,
						json: async () => ({ data: [] }),
					})
				),
			}),
		/no usable rows/,
	);
});

test("the extension registers two providers, one per tier, with no remembered lineup", async () => {
	const entry = await import("../index.mjs");
	/** @type {any[]} */
	const registered = [];
	entry.default(
		/** @type {any} */ ({
			registerProvider: (/** @type {string} */ id, /** @type {any} */ config) => {
				registered.push({ id, config });
			},
		}),
	);
	assert.equal(registered.length, 2, "two tiers, two registrations");
	assert.deepEqual(
		registered.map((registration) => registration.id),
		[PROVIDER_IDS.flex, PROVIDER_IDS.standard],
	);
	assert.deepEqual(
		registered.map((registration) => registration.config.name),
		["Neuralwatt Flex", "Neuralwatt Standard"],
	);
	for (const { config } of registered) {
		// A list on the registration outlives the provider's own catalog, which
		// is the remembered lineup docs/d190 removed.
		assert.equal("models" in config, false);
		assert.equal(typeof config.refreshModels, "function");
		assert.equal(config.baseUrl, FACT_BASE_URL);
		assert.equal(config.api, "openai-completions");
		assert.equal(config.apiKey, "$" + FACT_API_KEY_ENV);
		assert.equal(config.authHeader, true);
		assert.equal(
			await config.refreshModels({
				allowNetwork: false,
				signal: new AbortController().signal,
			}),
			undefined,
			"nothing remembered and no network wanted: nothing to offer",
		);
	}
});

test("a failed refresh throws with the provider id and the cause carried", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = /** @type {any} */ (
		async () => ({ ok: false, status: 503, json: async () => ({}) })
	);
	try {
		const entry = await import("../index.mjs");
		/** @type {any[]} */
		const registered = [];
		entry.default(
			/** @type {any} */ ({
				registerProvider: (/** @type {string} */ id, /** @type {any} */ config) => {
					registered.push({ id, config });
				},
			}),
		);
		for (const { id, config } of registered) {
			await assert.rejects(
				() =>
					config.refreshModels({
						allowNetwork: true,
						signal: new AbortController().signal,
					}),
				(/** @type {any} */ err) => {
					assert.ok(err.message.includes(id), "the failing provider is named");
					assert.ok(err.cause instanceof Error, "the cause is carried (d045)");
					return true;
				},
			);
		}
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a successful refresh serves each tier from the SAME listing", async () => {
	const payload = {
		data: [
			row("m", { display_name: "Model M" }),
			flexTwin("m", { display_name: "Model M" }),
			row("loner", { display_name: "Loner" }),
		],
	};
	const realFetch = globalThis.fetch;
	globalThis.fetch = /** @type {any} */ (
		async () => ({ ok: true, status: 200, json: async () => payload })
	);
	try {
		const entry = await import("../index.mjs");
		/** @type {any[]} */
		const registered = [];
		entry.default(
			/** @type {any} */ ({
				registerProvider: (/** @type {string} */ id, /** @type {any} */ config) => {
					registered.push({ id, config });
				},
			}),
		);
		const byId = new Map(
			registered.map((registration) => [registration.id, registration.config]),
		);
		const context = () => ({
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		const flexModels = await byId.get(PROVIDER_IDS.flex).refreshModels(context());
		const standardModels = await byId
			.get(PROVIDER_IDS.standard)
			.refreshModels(context());
		assert.deepEqual(
			flexModels.map((/** @type {any} */ model) => model.id),
			["m"],
			"only the row with a twin is Flex-capable",
		);
		assert.deepEqual(
			standardModels.map((/** @type {any} */ model) => model.id),
			["loner", "m"],
		);
		assert.equal(flexModels[0].samplingParams.service_tier, "flex");
		assert.equal(flexModels[0].cost.input, 0.65, "the flex price, from the twin");
		assert.equal(standardModels[1].cost.input, 1, "the list price");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a fresh store short-circuits the fetch, and a stale one does not", async () => {
	const entry = await import("../index.mjs");
	/** @type {any[]} */
	const registered = [];
	entry.default(
		/** @type {any} */ ({
			registerProvider: (/** @type {string} */ id, /** @type {any} */ config) => {
				registered.push({ id, config });
			},
		}),
	);
	// The flex provider has no twin in this payload, so its lineup is empty by
	// rule; the standard provider is the one that must refetch and serve.
	const config = registered[1].config;
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = /** @type {any} */ (
		async () => {
			calls += 1;
			return {
				ok: true,
				status: 200,
				json: async () => ({ data: [row("m")] }),
			};
		}
	);
	try {
		assert.equal(
			await config.refreshModels({
				allowNetwork: true,
				stored: { models: [], checkedAt: Date.now() },
				signal: new AbortController().signal,
			}),
			undefined,
		);
		assert.equal(calls, 0, "a fresh store means no request");
		const stale = await config.refreshModels({
			allowNetwork: true,
			stored: { models: [], checkedAt: Date.now() - 5 * 60 * 60 * 1000 },
			signal: new AbortController().signal,
		});
		assert.equal(calls, 1, "a stale store is refetched");
		assert.deepEqual(
			stale.map((/** @type {any} */ model) => model.id),
			["m"],
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});
