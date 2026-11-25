/**
 * @fileoverview pi-tlalocayotl-provider.test.mjs — the folder's rules, pinned.
 *
 * Everything here either works on plain records or injects its own `fetch`, so
 * the suite needs no network and no key. The assertions pin RULES (which rows
 * survive, what a missing window becomes, which compat block the wire carries,
 * what the entry registers), never today's lineup: a lineup assertion would
 * fail on every GGUF rotation and teach nothing.
 *
 * Run: node --test   (from this folder — discovers tests/*.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
	compatFor,
	contextWindowFor,
	isChatRow,
	isReasoningRow,
	maxTokensFor,
	nameFor,
	publishedModalities,
	shapeListing,
	shapeRow,
	toExtensionModel,
	toInput,
} = await import("../merge.mjs");
const {
	baseUrlFromEnv,
	fetchListing,
	listingUrl,
	storeIsFresh,
	TLALOCAYOTL_API_KEY_ENV,
	TLALOCAYOTL_BASE_URL,
	TLALOCAYOTL_PROVIDER_ID,
} = await import("../sources.mjs");

// The fact-table row lives in ../sources.mjs (one row per folder, docs/d113).
// These literals are the independent copy every consumer is pinned against, so a
// base-url, key-env or provider-id edit there cannot pass silently (docs/d024).
const FACT_PROVIDER_ID = "tlalocayotl";
const FACT_API_KEY_ENV = "TLALOCAYOTL_API_KEY";
const FACT_BASE_URL = "https://tlalocayotl.coelacanth-barb.ts.net/v1";

/**
 * The row fields a test may want to say something else about. Everything
 * llama-swap publishes is filled with a consistent default so a test names only
 * its own concern.
 * @typedef {object} RowOverrides
 * @property {string} [id]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {string[]} [input]
 * @property {string[]} [outputModalities]
 * @property {boolean} [reasoning]
 * @property {string} [status]
 */

/**
 * One listing row in the shape llama-swap serves it under `/v1/models`.
 * @param {RowOverrides} [over]
 * @returns {import("../sources.mjs").ListingRow}
 */
const row = (over = {}) => {
	const id = over.id ?? "unsloth/Qwen3.8-27B-GGUF:Q8_0";
	const input = over.input ?? ["text", "image"];
	const contextWindow = over.contextWindow ?? 262_144;
	return {
		id,
		architecture: {
			input_modalities: input,
			output_modalities: over.outputModalities ?? ["text"],
		},
		capabilities: { vision: input.includes("image") },
		context_length: contextWindow,
		context_window: contextWindow,
		meta: {
			llamaswap: {
				contextWindow,
				id,
				input,
				maxTokens: over.maxTokens ?? contextWindow,
				reasoning: over.reasoning ?? true,
				type: "model",
			},
			n_ctx: contextWindow,
		},
		status: { value: over.status ?? "unloaded" },
	};
};

/**
 * A fetch stub that answers with one payload. Typed through `unknown` because
 * the shape is a deliberate subset of `Response`.
 * @param {unknown} payload
 * @param {{ok?: boolean, status?: number, reject?: Error}} [init]
 * @returns {typeof fetch}
 */
const fetchOnce =
	(payload, init = {}) =>
	async () => {
		if (init.reject) {
			throw init.reject;
		}
		return /** @type {Response} */ (
			/** @type {unknown} */ ({
				ok: init.ok ?? true,
				status: init.status ?? 200,
				json: async () => payload,
			})
		);
	};

/** The one row's shaped record, for the field-level rules. */
const shaped = (/** @type {RowOverrides} */ over = {}) => {
	const [model] = shapeListing([row(over)]);
	assert.ok(model);
	return model;
};

/** The one row's registered entry. */
const entry = (/** @type {RowOverrides} */ over = {}) =>
	toExtensionModel(shaped(over));

test("the fact-table row is pinned: one upstream, one key env, one provider id", () => {
	assert.equal(TLALOCAYOTL_BASE_URL, FACT_BASE_URL);
	assert.equal(TLALOCAYOTL_API_KEY_ENV, FACT_API_KEY_ENV);
	assert.equal(TLALOCAYOTL_PROVIDER_ID, FACT_PROVIDER_ID);
	assert.equal(listingUrl(), `${FACT_BASE_URL}/models`);
});

test("a base-url override is absolute-http(s), trailing-slash-trimmed, loud when malformed", () => {
	assert.equal(
		baseUrlFromEnv(FACT_API_KEY_ENV, FACT_BASE_URL, {
			TLALOCAYOTL_BASE_URL: "http://127.0.0.1:9292/v1/",
		}),
		"http://127.0.0.1:9292/v1",
	);
	assert.equal(
		baseUrlFromEnv(FACT_API_KEY_ENV, FACT_BASE_URL, {}),
		FACT_BASE_URL,
		"unset keeps the row's canonical upstream",
	);
	assert.equal(
		baseUrlFromEnv(FACT_API_KEY_ENV, FACT_BASE_URL, {
			TLALOCAYOTL_BASE_URL: "   ",
		}),
		FACT_BASE_URL,
	);
	assert.throws(
		() =>
			baseUrlFromEnv(FACT_API_KEY_ENV, FACT_BASE_URL, {
				TLALOCAYOTL_BASE_URL: "tlalocayotl.local/v1",
			}),
		/TLALOCAYOTL_BASE_URL is not an absolute http\(s\) URL/,
	);
});

test("the listing is fetched from the effective upstream, with no other redirect surface", async () => {
	/** @type {string|undefined} */
	let seen;
	await fetchListing({
		fetchImpl: async (url) => {
			// The pipeline hands fetchImpl URL objects; only the Request case needs
			// unwrapping.
			seen = String(url instanceof Request ? url.url : url);
			return /** @type {Response} */ (
				/** @type {unknown} */ ({
					ok: true,
					status: 200,
					json: async () => ({ data: [row()] }),
				})
			);
		},
	});
	assert.equal(seen, `${FACT_BASE_URL}/models`);
});

test("the bearer rides when a key exists — the listing is auth-gated", async () => {
	const previousKey = process.env.TLALOCAYOTL_API_KEY;
	process.env.TLALOCAYOTL_API_KEY = "sk-test-key";
	try {
		/** @type {string|undefined} */
		let auth;
		await fetchListing({
			fetchImpl: async (_url, init) => {
				auth = /** @type {any} */ (init?.headers)?.Authorization;
				return /** @type {Response} */ (
					/** @type {unknown} */ ({
						ok: true,
						status: 200,
						json: async () => ({ data: [row()] }),
					})
				);
			},
		});
		assert.equal(auth, "Bearer sk-test-key");
	} finally {
		if (previousKey === undefined) {
			delete process.env.TLALOCAYOTL_API_KEY;
		} else {
			process.env.TLALOCAYOTL_API_KEY = previousKey;
		}
	}
});

test("the request signal composes the caller's cancellation with the deadline", async () => {
	// Both, never either: `signal ?? AbortSignal.timeout(…)` drops the 15 s
	// ceiling on every real refresh, because pi always hands a concrete signal.
	const controller = new AbortController();
	/** @type {AbortSignal|undefined} */
	let seen;
	await fetchListing({
		signal: controller.signal,
		fetchImpl: async (_url, init) => {
			seen = init?.signal ?? undefined;
			return /** @type {Response} */ (
				/** @type {unknown} */ ({
					ok: true,
					status: 200,
					json: async () => ({ data: [row()] }),
				})
			);
		},
	});
	assert.ok(seen, "fetch was called with a signal");
	assert.notEqual(
		seen,
		controller.signal,
		"composed, so the ceiling rides along",
	);
	assert.equal(seen.aborted, false);
	controller.abort();
	assert.equal(seen.aborted, true, "the caller's abort reaches the request");
});

test("a fetch failure throws instead of inventing a catalog", async () => {
	await assert.rejects(
		fetchListing({ fetchImpl: fetchOnce(null, { ok: false, status: 401 }) }),
		/answered 401/,
	);
	await assert.rejects(
		fetchListing({
			fetchImpl: fetchOnce(null, { reject: new Error("ECONNREFUSED") }),
		}),
		/ECONNREFUSED/,
	);
	await assert.rejects(
		fetchListing({ fetchImpl: fetchOnce({ data: [{ object: "model" }] }) }),
		/no usable rows/,
	);
});

test("the OpenAI envelope is read, and a bare array is tolerated", async () => {
	const wrapped = await fetchListing({
		fetchImpl: fetchOnce({ data: [row({ id: "a" }), { object: "model" }] }),
	});
	assert.deepEqual(
		wrapped.map((r) => r.id),
		["a"],
		"a row without an id is not a model",
	);
	const bare = await fetchListing({ fetchImpl: fetchOnce([row({ id: "b" })]) });
	assert.deepEqual(
		bare.map((r) => r.id),
		["b"],
	);
});

test("the model store TTL is the refresh gate, not an absolute clock", () => {
	assert.equal(storeIsFresh(Date.now() - 60_000), true);
	assert.equal(storeIsFresh(Date.now() - 5 * 60 * 60 * 1000), false);
});

test("the context window follows the gateway's own statement order", () => {
	const full = row();
	assert.equal(contextWindowFor(full), 262_144, "meta.llamaswap.contextWindow");
	/** @type {any} */
	const gatewayless = row();
	delete gatewayless.meta.llamaswap.contextWindow;
	assert.equal(
		contextWindowFor(gatewayless),
		262_144,
		"top-level context_window",
	);
	/** @type {any} */
	const openaiOnly = row();
	delete openaiOnly.meta.llamaswap.contextWindow;
	delete openaiOnly.context_window;
	assert.equal(contextWindowFor(openaiOnly), 262_144, "context_length");
	/** @type {any} */
	const runtimeOnly = row();
	delete runtimeOnly.meta.llamaswap.contextWindow;
	delete runtimeOnly.context_window;
	delete runtimeOnly.context_length;
	assert.equal(contextWindowFor(runtimeOnly), 262_144, "meta.n_ctx");
	/** @type {any} */
	const bare = { id: "bare" };
	assert.equal(
		contextWindowFor(bare),
		undefined,
		"nothing published, nothing invented",
	);
});

test("the output cap is the published maxTokens, else the shared window", () => {
	assert.equal(maxTokensFor(row({ maxTokens: 16_384 }), 262_144), 16_384);
	assert.equal(maxTokensFor(row({ contextWindow: 65_536 }), 65_536), 65_536);
	/** @type {any} */
	const noCap = row();
	delete noCap.meta.llamaswap.maxTokens;
	assert.equal(maxTokensFor(noCap, 262_144), 262_144);
	assert.equal(maxTokensFor(noCap, undefined), undefined);
	// The projection never invents a smaller cap, and defaults the window to
	// pi's own schema value when the row published none.
	assert.equal(entry({ maxTokens: 16_384 }).maxTokens, 16_384);
	assert.equal(entry().maxTokens, 262_144);
	const bareModel = shapeRow({ id: "bare" });
	assert.ok(bareModel);
	const bareEntry = toExtensionModel(bareModel);
	assert.equal(bareEntry.contextWindow, 128_000, "pi's schema default");
	assert.equal(bareEntry.maxTokens, 128_000, "and the cap is that window");
});

test("reasoning is the gateway's published flag, never inferred from the id", () => {
	assert.equal(isReasoningRow(row({ reasoning: true })), true);
	assert.equal(isReasoningRow(row({ reasoning: false })), false);
	/** @type {any} */
	const silent = row();
	delete silent.meta.llamaswap.reasoning;
	assert.equal(isReasoningRow(silent), false, "unstated is not a guess");
});

test("input modalities come from the gateway's list, then architecture, then the vision flag", () => {
	assert.deepEqual(toInput(row({ input: ["text", "image"] })), [
		"text",
		"image",
	]);
	assert.deepEqual(toInput(row({ input: ["text"] })), ["text"]);
	assert.deepEqual(
		toInput(row({ input: ["text", "image", "audio"] })),
		["text", "image"],
		"audio has no pi arm and is not invented",
	);
	assert.deepEqual(toInput(row({ input: [] })), ["text"]);
	/** @type {any} */
	const gatewayless = row();
	delete gatewayless.meta.llamaswap.input;
	assert.deepEqual(
		publishedModalities(gatewayless),
		["text", "image"],
		"architecture.input_modalities",
	);
	/** @type {any} */
	const flagOnly = {
		id: "flag-only",
		capabilities: { vision: true },
	};
	assert.deepEqual(publishedModalities(flagOnly), ["text", "image"]);
	assert.deepEqual(toInput(/** @type {any} */ ({ id: "bare" })), ["text"]);
});

test("decision models are dropped, and a row without output modalities is chat", () => {
	assert.equal(isChatRow(row()), true);
	assert.equal(
		isChatRow(row({ outputModalities: ["decisions"] })),
		false,
		"a decision model rejects /v1/chat/completions",
	);
	assert.equal(
		isChatRow(row({ outputModalities: ["text", "decisions"] })),
		true,
		"it also generates text, so it stays",
	);
	assert.equal(isChatRow(/** @type {any} */ ({ id: "older-build" })), true);
	assert.deepEqual(
		shapeListing([
			row({ id: "chat" }),
			row({ id: "decide", outputModalities: ["decisions"] }),
		]).map((model) => model.id),
		["chat"],
	);
});

test("an unloaded model is still published — llama-swap loads on demand", () => {
	// status.value is unread on purpose: filtering on residency would hide the
	// catalog the gateway exists to serve.
	assert.equal(
		entry({ status: "unloaded" }).id,
		"unsloth/Qwen3.8-27B-GGUF:Q8_0",
	);
	assert.equal(entry({ status: "loaded" }).id, "unsloth/Qwen3.8-27B-GGUF:Q8_0");
	assert.equal(
		entry({ status: "sleeping" }).id,
		"unsloth/Qwen3.8-27B-GGUF:Q8_0",
	);
});

test("the config's name is the display name when published, else the id", () => {
	assert.equal(nameFor(row()), "unsloth/Qwen3.8-27B-GGUF:Q8_0");
	assert.equal(
		nameFor(/** @type {any} */ ({ ...row(), name: "  DeepSeek V4.1 Flash  " })),
		"DeepSeek V4.1 Flash",
		"llama-swap copies the model's configured name through",
	);
	assert.equal(
		nameFor(/** @type {any} */ ({ ...row(), name: "   " })),
		"unsloth/Qwen3.8-27B-GGUF:Q8_0",
		"a blank name is no name",
	);
	const named = shapeRow(/** @type {any} */ ({ ...row(), name: "Model M" }));
	assert.ok(named);
	assert.equal(named.name, "Model M");
	assert.equal(
		named.id,
		"unsloth/Qwen3.8-27B-GGUF:Q8_0",
		"the id stays the routing key",
	);
});

test("NO cost is invented and the id is the honest name", () => {
	const model = entry();
	assert.deepEqual(model.cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
	assert.equal(model.name, "unsloth/Qwen3.8-27B-GGUF:Q8_0");
	assert.equal(model.id, "unsloth/Qwen3.8-27B-GGUF:Q8_0");
});

test("the compat block is the host's llama.cpp transcription, thinkingFormat conditional", () => {
	// Transcribed from @earendil-works/pi-coding-agent@1.5.2
	// dist/extensions/llama/provider.js (toPiModel) — llama-swap fronts
	// llama-server, so this table is pi's own for the same OpenAI surface.
	const reasoning = entry({ reasoning: true });
	assert.deepEqual(reasoning.compat, {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
		thinkingFormat: "qwen-chat-template",
	});
	const plain = entry({ reasoning: false });
	assert.deepEqual(plain.compat, {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
	});
	assert.deepEqual(compatFor(false), plain.compat);
});

test("a reasoning model carries the template switch, not an invented effort ladder", () => {
	assert.deepEqual(entry({ reasoning: true }).thinkingLevelMap, {
		off: "off",
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: null,
	});
	assert.equal(
		"thinkingLevelMap" in entry({ reasoning: false }),
		false,
		"a non-reasoning model advertises no level at all",
	);
});

test("models are emitted in canonical id order (docs/d050)", () => {
	const ids = shapeListing([row({ id: "z-last" }), row({ id: "a-first" })]).map(
		(model) => model.id,
	);
	assert.deepEqual(
		ids,
		[...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
	);
});

test("the entry registers one provider with no remembered lineup", async () => {
	const previousKey = process.env.TLALOCAYOTL_API_KEY;
	delete process.env.TLALOCAYOTL_API_KEY;
	try {
		const entryModule = await import("../index.mjs");
		/** @type {{id: string, config: any}[]} */
		const registered = [];
		// The shim is the ONE member this folder uses: the host interface is an
		// overloaded registerProvider plus dozens of members.
		entryModule.default(
			/** @type {any} */ ({
				registerProvider: (
					/** @type {string} */ id,
					/** @type {any} */ config,
				) => {
					registered.push({ id, config });
				},
			}),
		);
		assert.equal(registered.length, 1, "exactly one provider is registered");
		const first = registered[0];
		assert.ok(first);
		const { id, config } = first;
		assert.equal(id, FACT_PROVIDER_ID);
		assert.equal(config.name, "Tlalocayotl");
		assert.equal(config.baseUrl, FACT_BASE_URL);
		assert.equal(config.api, "openai-completions");
		assert.equal(config.apiKey, `$${FACT_API_KEY_ENV}`);
		assert.equal(config.authHeader, true);
		// A list on the registration outlives the gateway's own catalog, which is
		// the remembered lineup docs/d190 removed.
		assert.equal("models" in config, false);
		assert.equal(typeof config.refreshModels, "function");
		assert.equal(
			await config.refreshModels({
				allowNetwork: false,
				signal: new AbortController().signal,
			}),
			undefined,
			"nothing remembered and no network wanted: nothing to offer",
		);
	} finally {
		if (previousKey === undefined) {
			delete process.env.TLALOCAYOTL_API_KEY;
		} else {
			process.env.TLALOCAYOTL_API_KEY = previousKey;
		}
	}
});

test("a successful refresh serves the shaped listing", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = /** @type {any} */ (
		fetchOnce({
			data: [
				row({ id: "b-model", maxTokens: 8192 }),
				row({ id: "a-model", reasoning: false }),
			],
		})
	);
	try {
		const entryModule = await import("../index.mjs");
		/** @type {any} */
		let config;
		entryModule.default(
			/** @type {any} */ ({
				registerProvider: (/** @type {string} */ _id, /** @type {any} */ c) => {
					config = c;
				},
			}),
		);
		const models = await config.refreshModels({
			allowNetwork: true,
			signal: new AbortController().signal,
			// pi hands every refresh a publication channel; what this folder
			// persists through it is asserted on its own below.
			publish: async () => true,
		});
		assert.deepEqual(
			models.map((/** @type {any} */ model) => model.id),
			["a-model", "b-model"],
		);
		assert.equal(models[1].maxTokens, 8192);
		assert.equal(models[0].reasoning, false);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("an unreadable source is REPORTED, never a silent empty lineup (docs/d190)", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = /** @type {any} */ (
		async () => ({ ok: false, status: 503, json: async () => ({}) })
	);
	try {
		const entryModule = await import("../index.mjs");
		/** @type {any} */
		let config;
		entryModule.default(
			/** @type {any} */ ({
				registerProvider: (/** @type {string} */ _id, /** @type {any} */ c) => {
					config = c;
				},
			}),
		);
		await assert.rejects(
			() =>
				config.refreshModels({
					allowNetwork: true,
					signal: new AbortController().signal,
				}),
			(/** @type {any} */ err) => {
				assert.ok(err.message.includes(FACT_PROVIDER_ID));
				assert.ok(err.cause instanceof Error, "the cause is carried (d045)");
				return true;
			},
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a fresh store short-circuits the fetch, and a stale one does not", async () => {
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = /** @type {any} */ (
		async () => {
			calls += 1;
			return {
				ok: true,
				status: 200,
				json: async () => ({ data: [row()] }),
			};
		}
	);
	try {
		const entryModule = await import("../index.mjs");
		/** @type {any} */
		let config;
		entryModule.default(
			/** @type {any} */ ({
				registerProvider: (/** @type {string} */ _id, /** @type {any} */ c) => {
					config = c;
				},
			}),
		);
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
			publish: async () => true,
		});
		assert.equal(calls, 1, "a stale store is refetched");
		assert.deepEqual(
			stale.map((/** @type {any} */ model) => model.id),
			["unsloth/Qwen3.8-27B-GGUF:Q8_0"],
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("pi's cache-only phase restores the catalog the last verified read stored", async () => {
	const { default: entry } = await import("../index.mjs");
	/** @type {any} */
	let config;
	entry(
		/** @type {any} */ ({
			registerProvider: (/** @type {string} */ _id, /** @type {any} */ c) => {
				config = c;
			},
		}),
	);
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = /** @type {any} */ (async () => {
		calls += 1;
		throw new Error("the cache-only phase must not reach the network");
	});
	try {
		const storedModel = {
			id: "restored",
			name: "Restored",
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const restored = await config.refreshModels({
			allowNetwork: false,
			// Older than the TTL on purpose: pi asked for cache-only init, and a
			// week-old snapshot still beats an empty picker.
			stored: {
				models: [storedModel],
				checkedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
			},
			signal: new AbortController().signal,
		});
		assert.deepEqual(restored, [storedModel]);
		assert.equal(calls, 0, "no network in the cache-only phase");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a stored row pi could not render is dropped, not published", async () => {
	const { default: entry } = await import("../index.mjs");
	/** @type {any} */
	let config;
	entry(
		/** @type {any} */ ({
			registerProvider: (/** @type {string} */ _id, /** @type {any} */ c) => {
				config = c;
			},
		}),
	);
	assert.equal(
		await config.refreshModels({
			allowNetwork: false,
			// pi's model list formatter reads `input` unconditionally, and a row
			// without an id names nothing: neither may reach the picker.
			stored: { models: [{ name: "no id" }, { id: "no-input" }], checkedAt: 1 },
			signal: new AbortController().signal,
		}),
		undefined,
	);
});

test("a verified read is persisted, and a failed one publishes nothing (docs/d190)", async () => {
	const realFetch = globalThis.fetch;
	/** @type {any[]} */
	const published = [];
	/** @type {any} */
	const publish = async (/** @type {any} */ publication) => {
		published.push(publication);
		return true;
	};
	try {
		const { default: entry } = await import("../index.mjs");
		/** @type {any} */
		let config;
		entry(
			/** @type {any} */ ({
				registerProvider: (/** @type {string} */ _id, /** @type {any} */ c) => {
					config = c;
				},
			}),
		);
		globalThis.fetch = /** @type {any} */ (fetchOnce({ data: [row({ id: "a-model" })] }));
		const before = Date.now();
		const models = await config.refreshModels({
			allowNetwork: true,
			signal: new AbortController().signal,
			publish,
		});
		assert.ok(models.length > 0, "the payload serves a lineup");
		assert.equal(published.length, 1, "one publication per verified read");
		assert.deepEqual(
			published[0].persist.models,
			models,
			"what was served is what is stored",
		);
		assert.ok(
			published[0].persist.checkedAt >= before,
			"checkedAt is the read's clock, which is the TTL's input",
		);

		published.length = 0;
		globalThis.fetch = /** @type {any} */ (
			async () => ({ ok: false, status: 503, json: async () => ({}) })
		);
		await assert.rejects(() =>
			config.refreshModels({
				allowNetwork: true,
				signal: new AbortController().signal,
				publish,
			}),
		);
		assert.equal(published.length, 0);
	} finally {
		globalThis.fetch = realFetch;
	}
});
