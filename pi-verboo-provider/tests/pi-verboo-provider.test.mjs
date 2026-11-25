/**
 * @fileoverview pi-verboo-provider.test.mjs — tests for the pi-verboo-provider folder: the
 * shaping rules (merge.mjs), the source fetch (sources.mjs), the committed
 * artifacts, and the extension entry.
 *
 * Everything here either works on plain records or injects its own `fetch`,
 * so the suite needs no network, and it pins RULES rather than today's model
 * lineup (a lineup assertion would fail on every provider rotation and
 * teach nothing).
 *
 * Run: node --test   (from this folder — discovers tests/*.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
	effortValues,
	shapeListing,
	shapeRow,
	thinkingLevelMapFor,
	toExtensionModel,
} = await import("../merge.mjs");
const {
	fetchListing,
	listingUrl,
	storeIsFresh,
	VERBOO_API_KEY_ENV,
	VERBOO_BASE_URL,
	VERBOO_PROVIDER_ID,
} = await import("../sources.mjs");

// The fact-table row now lives in ../sources.mjs (one row per folder, docs/d113).
// These three literals are the independent copy every consumer is pinned
// against, so a base-url or key-env edit there cannot pass silently
// (docs/d024/d070).
const VERBOO_FACT_ID = "verboo";
const VERBOO_FACT_BASE_URL = "https://code.verboo.ai/router/v1";
const VERBOO_FACT_API_KEY_ENV = "VERBOO_API_KEY";

/**
 * One listing row; every field overridable so a test names only its own
 * concern.
 * @param {{[K in keyof import("../sources.mjs").ListingRow]?: import("../sources.mjs").ListingRow[K] | undefined}} overrides
 * @returns {import("../sources.mjs").ListingRow}
 */
const row = (overrides) =>
	/** @type {import("../sources.mjs").ListingRow} */ ({
		id: "test-model",
		context_window: 1_048_576,
		vision: true,
		reasoning: {
			effort_levels: ["low", "high", "xhigh", "max"],
			default_effort: "low",
		},
		...overrides,
	});

/**
 * A fetch stub that answers with one payload. Typed through `unknown`
 * because the shape is a deliberate subset of `Response`.
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

test("the fact table is the only place the upstream and key env are spelled", () => {
	assert.equal(VERBOO_BASE_URL, VERBOO_FACT_BASE_URL);
	assert.equal(VERBOO_PROVIDER_ID, VERBOO_FACT_ID);
	assert.equal(VERBOO_API_KEY_ENV, VERBOO_FACT_API_KEY_ENV);
	assert.equal(listingUrl(), `${VERBOO_FACT_BASE_URL}/models`);
});

test("the listing is fetched from the canonical upstream, with no redirect surface", async () => {
	let seen = "";
	await fetchListing({
		fetchImpl: async (url) => {
			// Request has no own toString (base [object Request]); the pipeline
			// hands fetchImpl URL objects, so only the Request case needs the url.
			seen = String(url instanceof Request ? url.url : url);
			return /** @type {Response} */ (
				/** @type {unknown} */ ({
					ok: true,
					status: 200,
					json: async () => ({ data: [row({})] }),
				})
			);
		},
	});
	assert.equal(seen, `${VERBOO_FACT_BASE_URL}/models`);
});

test("the bearer rides when a key exists — the listing is auth-gated", async () => {
	const previousKey = process.env.VERBOO_API_KEY;
	process.env.VERBOO_API_KEY = "sk-test-key";
	try {
		let auth;
		await fetchListing({
			fetchImpl: async (_url, init) => {
				auth = /** @type {any} */ (init?.headers)?.Authorization;
				return /** @type {Response} */ (
					/** @type {unknown} */ ({
						ok: true,
						status: 200,
						json: async () => ({ data: [row({})] }),
					})
				);
			},
		});
		assert.equal(auth, "Bearer sk-test-key");
	} finally {
		if (previousKey === undefined) {
			delete process.env.VERBOO_API_KEY;
		} else {
			process.env.VERBOO_API_KEY = previousKey;
		}
	}
});

test("a fetch failure throws instead of inventing a catalog", async () => {
	await assert.rejects(
		fetchListing({ fetchImpl: fetchOnce(null, { ok: false, status: 401 }) }),
		/401/,
	);
	await assert.rejects(
		fetchListing({
			fetchImpl: fetchOnce(null, { reject: new Error("ECONNREFUSED") }),
		}),
		/ECONNREFUSED/,
	);
	await assert.rejects(
		fetchListing({ fetchImpl: fetchOnce({ data: [] }) }),
		/no usable rows/,
	);
});

test("thinking levels come from the published enum only, with NO off-state fallback", () => {
	// The fleet row's documented gap: only a published "none" disables
	// thinking, so an enum without it leaves off=null — never an invented
	// wire value (and no ON_OFF map here, unlike hyper).
	const map = thinkingLevelMapFor(["low", "high", "xhigh", "max"]);
	assert.equal(map?.off, null);
	assert.equal(map?.low, "low");
	assert.equal(map?.max, "max");
	const withNone = thinkingLevelMapFor(["none", "low"]);
	assert.equal(withNone?.off, "none");
	assert.equal(thinkingLevelMapFor(undefined), null);
});

test("the reasoning object's PRESENCE is the reasoning declaration", () => {
	const reasoning = shapeRow(row({}));
	const plain = shapeRow(row({ reasoning: undefined }));
	assert.equal(reasoning?.reasoning, true);
	assert.equal(plain?.reasoning, false);
	assert.equal(effortValues(row({ reasoning: {} })), undefined);
});

test("input modalities come from the vision flag; the id is the honest name", () => {
	const visual = shapeRow(row({}));
	const textOnly = shapeRow(row({ vision: false }));
	assert.deepEqual(visual?.input, ["text", "image"]);
	assert.deepEqual(textOnly?.input, ["text"]);
	assert.equal(visual?.name, "test-model");
});

test("NO cost is ever invented — the listing publishes no prices (docs/d057)", () => {
	const models = shapeListing([row({}), row({ id: "other" })]);
	for (const model of models) {
		assert.deepEqual(toExtensionModel(model).cost, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	}
});

test("the extension carries the schema default for an unpublished maxTokens", () => {
	const [model] = shapeListing([row({})]);
	assert.ok(model);
	assert.equal("maxTokens" in model, false, "nothing published one");
	assert.equal(toExtensionModel(model).maxTokens, 16_384);
	// The context window IS published, so it is carried rather than defaulted.
	assert.equal(toExtensionModel(model).contextWindow, 1_048_576);
});

test("models are emitted in canonical id order (docs/d050)", () => {
	const models = shapeListing([row({ id: "z-last" }), row({ id: "a-first" })]);
	const ids = models.map((m) => m.id);
	assert.deepEqual(
		ids,
		[...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
	);
});

test("the model store TTL is the refresh gate, not an absolute clock", () => {
	assert.equal(storeIsFresh(Date.now() - 60_000), true);
	assert.equal(storeIsFresh(Date.now() - 5 * 60 * 60 * 1000), false);
});

test("the extension loads and registers a provider with no remembered lineup", async () => {
	// The real entry point, imported and executed — not a textual review. the entry is part of the tsc program too
	// (the folder carries pi's types as a devDependency), so this also pins that
	// the shipped module graph type-checks.
	const previousKey = process.env.VERBOO_API_KEY;
	delete process.env.VERBOO_API_KEY;
	try {
		const entry = await import("../index.mjs");
		/** @type {{id: string, config: any}[]} */
		const registered = [];
		// The shim is the ONE member this folder uses: the host interface is an
		// overloaded registerProvider plus dozens of members, so it captures the
		// registration rather than faking the whole surface.
		entry.default(
			/** @type {any} */ ({
				registerProvider: (/** @type {string} */ id, /** @type {any} */ config) => {
					registered.push({ id, config });
				},
			}),
		);
		assert.equal(registered.length, 1, "exactly one provider is registered");
		const first = registered[0];
		assert.ok(first);
		const { id, config } = first;
		// No dedicated seed: a list on the registration outlives the provider's
		// own catalog, which is the remembered lineup docs/d190 removed.
		assert.equal(
			"models" in config,
			false,
			"the extension carries no lineup of its own",
		);
		assert.equal(typeof config.refreshModels, "function");
		// Nothing remembered and no network wanted: nothing to offer, rather
		// than a list the provider may already have retired.
		assert.equal(
			await config.refreshModels({
				allowNetwork: false,
				signal: new AbortController().signal,
			}),
			undefined,
		);
		assert.equal(id, VERBOO_PROVIDER_ID);
		assert.equal(config.baseUrl, VERBOO_FACT_BASE_URL);
	} finally {
		if (previousKey === undefined) {
			delete process.env.VERBOO_API_KEY;
		} else {
			process.env.VERBOO_API_KEY = previousKey;
		}
	}
});

test("an unreadable source is REPORTED, never a silent empty lineup (docs/d190)", async () => {
	// The provider's own source is the only lineup, so a failure must reach the
	// operator: pi renders a thrown refresh as "Could not refresh <provider>;
	// showing cached models." (ModelsRefreshResult.errors). Returning undefined
	// instead would keep the last list and say nothing.
	const realFetch = globalThis.fetch;
	globalThis.fetch = /** @type {any} */ (
		async () => ({ ok: false, status: 503, json: async () => ({}) })
	);
	try {
		const entry = await import("../index.mjs");
		/** @type {any} */
		let config;
		entry.default(
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
				assert.ok(err.message.includes(VERBOO_PROVIDER_ID));
				assert.ok(err.cause instanceof Error, "the cause is carried (d045)");
				return true;
			},
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("the request signal composes the caller's cancellation with the deadline", async () => {
	// Both, never either: `signal ?? AbortSignal.timeout(…)` dropped the 15 s
	// ceiling on every real refresh, because pi always hands a concrete signal —
	// a revoked refresh then waited on an upstream that never answers.
	const controller = new AbortController();
	/** @type {AbortSignal|undefined} */
	let seen;
	await fetchListing({
		signal: controller.signal,
		fetchImpl: async (/** @type {any} */ _url, /** @type {any} */ init) => {
			seen = init.signal;
			return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ data: [{ id: "x" }] }) });
		},
	});
	assert.ok(seen, "fetch was called with a signal");
	assert.notEqual(seen, controller.signal, "composed, so the ceiling rides along");
	assert.equal(seen.aborted, false);
	controller.abort();
	assert.equal(seen.aborted, true, "the caller's abort reaches the request");
});


// The base-url schema (coding-agent/DESIGN.md): every unit accepts
// <KEY>_BASE_URL derived from its key env.
const { baseUrlFromEnv } = await import("../sources.mjs");

test("the base-url override derives from the key env", () => {
	assert.equal(baseUrlFromEnv("VERBOO_API_KEY", "https://code.verboo.ai/router/v1", {}), "https://code.verboo.ai/router/v1");
	assert.equal(
		baseUrlFromEnv("VERBOO_API_KEY", "https://code.verboo.ai/router/v1", {
			VERBOO_BASE_URL: "https://mirror.example/v1/",
		}),
		"https://mirror.example/v1",
	);
	assert.throws(
		() =>
			baseUrlFromEnv("VERBOO_API_KEY", "https://code.verboo.ai/router/v1", {
				VERBOO_BASE_URL: "ftp://mirror.example/v1",
			}),
		/VERBOO_BASE_URL is not an absolute http\(s\) URL/,
	);
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
		globalThis.fetch = /** @type {any} */ ((async () => ({ ok: true, status: 200, json: async () => ({ data: [row({})] }) })));
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
