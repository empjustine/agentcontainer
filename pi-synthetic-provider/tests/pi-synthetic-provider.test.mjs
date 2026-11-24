/**
 * @fileoverview pi-synthetic-provider.test.mjs — tests for the pi-synthetic-provider folder: the
 * shaping rules (merge.mjs), the source fetch (sources.mjs), the committed
 * artifacts, and the extension entry.
 *
 * Everything here either works on plain records or injects its own `fetch`, so
 * the suite needs no network and no relay configuration, and it pins RULES
 * rather than today's model lineup (a lineup assertion would fail on every
 * provider rotation and teach nothing).
 *
 * Run: node --test   (from this folder — discovers tests/*.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
	laysWithinPiModalities,
	piCost,
	shapeListing,
	shapeRow,
	thinkingLevelMapFor,
	toExtensionModel,
} = await import("../merge.mjs");
const {
	fetchListing,
	listingUrl,
	storeIsFresh,
	SYNTHETIC,
	SYNTHETIC_BASE_URL,
	SYNTHETIC_PROVIDER_ID,
} = await import("../sources.mjs");
// The folder's own row: the one place the upstream and the key env are spelled
// (sources.mjs), so the exports above are only believable if they match it.
const synthetic = SYNTHETIC;

/**
 * One listing row; every field overridable so a test names only its own
 * concern.
 * @param {{[K in keyof import("../sources.mjs").ListingRow]?: import("../sources.mjs").ListingRow[K] | undefined}} overrides
 * @returns {import("../sources.mjs").ListingRow}
 */
const row = (overrides) =>
	/** @type {import("../sources.mjs").ListingRow} */ ({
		id: "hf:test/model",
		display_name: "Test Model",
		input_modalities: ["text"],
		output_modalities: ["text"],
		context_length: 128_000,
		max_output_length: 8192,
		supported_features: ["tools", "reasoning"],
		reasoning_parameters: { efforts: ["low", "high"] },
		pricing: { prompt: "0.000001", completion: "0.000002" },
		...overrides,
	});

/**
 * A fetch stub that answers with one payload. Typed through `unknown` because
 * the shape is a deliberate subset of `Response` — `fetchListing` reads `ok`,
 * `status` and `json()` only.
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

test("the folder's row is the only place the upstream and key env are spelled", () => {
	assert.equal(SYNTHETIC_BASE_URL, "https://api.synthetic.new/openai/v1");
	assert.equal(SYNTHETIC_BASE_URL, synthetic.baseUrl);
	assert.equal(SYNTHETIC_PROVIDER_ID, synthetic.id);
	assert.equal(listingUrl(), `${SYNTHETIC_BASE_URL}/models`);
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
	assert.equal(seen, `${synthetic.baseUrl}/models`);
});

test("a fetch failure throws instead of inventing a catalog", async () => {
	// There is no second source and no stale-copy branch: the committed
	// artifact is the fallback, so a failed run must not write a worse one.
	await assert.rejects(
		fetchListing({ fetchImpl: fetchOnce(null, { ok: false, status: 502 }) }),
		/502/,
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

test("the unsupported id family is dropped, the contract tiers are kept", async () => {
	const rows = await fetchListing({
		fetchImpl: fetchOnce({
			data: [
				row({ id: "hf:test/model" }),
				row({ id: "infinite:small:vision" }),
				row({ id: "syn:large:text", hugging_face_id: "test/model" }),
			],
		}),
	});
	assert.deepEqual(
		rows.map((r) => r.id),
		["hf:test/model", "syn:large:text"],
	);
});

test("an alias row names its target from hugging_face_id, and only that", () => {
	const alias = shapeRow(
		row({
			id: "syn:large:text",
			display_name: "syn:large:text",
			// A display STRING, deliberately unread: it cannot name a catalog row,
			// so it is not part of ListingRow and nothing here reads it.
			alias_of: "DeepSeek V4.1 Flash 10/17",
			hugging_face_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
		}),
	);
	assert.ok(alias);
	assert.equal(alias.pointsAt, "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017");
	assert.equal(
		alias.name,
		"syn:large:text (hf:deepseek-ai/DeepSeek-V4.1-Flash-1017)",
	);
	// A row that names its own model is not an alias.
	const plain = shapeRow(
		row({ id: "hf:test/model", hugging_face_id: "test/model" }),
	);
	assert.equal(plain?.pointsAt, undefined);
	assert.equal(plain?.name, "Test Model");
});

test("thinking levels come from the published enum only", () => {
	const map = thinkingLevelMapFor(["none", "low", "high", "max"]);
	assert.equal(map?.off, "none", "the provider spells pi's off as none");
	assert.equal(map?.low, "low");
	assert.equal(map?.max, "max");
	assert.equal(
		map?.medium,
		null,
		"an unpublished level is hidden, never invented",
	);
	assert.equal(thinkingLevelMapFor(undefined), null);
	assert.equal(thinkingLevelMapFor([]), null);
});

test("the modality gate drops what pi cannot drive and trims what it can", () => {
	const models = shapeListing([
		row({ id: "hf:a/audio-out", output_modalities: ["audio"] }),
		row({ id: "hf:a/no-text-in", input_modalities: ["audio"] }),
		row({ id: "hf:a/rich", input_modalities: ["text", "image", "video"] }),
		row({
			id: "hf:a/id-only",
			input_modalities: undefined,
			output_modalities: undefined,
		}),
	]);
	assert.deepEqual(
		models.map((m) => m.id),
		["hf:a/id-only", "hf:a/rich"],
	);
	assert.deepEqual(models.find((m) => m.id === "hf:a/rich")?.input, [
		"text",
		"image",
	]);
	// A record with no modality metadata passes the gate and gets the core.
	assert.equal(laysWithinPiModalities({}), true);
});

test("models are emitted in canonical id order (docs/d050)", () => {
	const models = shapeListing([
		row({ id: "hf:z/last" }),
		row({ id: "hf:a/first" }),
		row({ id: "syn:middle" }),
	]);
	const ids = models.map((m) => m.id);
	assert.deepEqual(
		ids,
		[...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
	);
});

test("prices parse from the provider's mixed number/string wire form", () => {
	const [model] = shapeListing([
		row({
			pricing: {
				prompt: "$0.0000006",
				completion: 0.000_001_2,
				input_cache_reads: "$0.00000003",
				input_cache_writes: "0",
			},
		}),
	]);
	assert.ok(model);
	assert.deepEqual(model.cost, {
		input: 0.6,
		output: 1.2,
		cacheRead: 0.03,
		cacheWrite: 0,
	});
});

test("a partial or all-zero price block is refused outright (docs/d057)", () => {
	assert.equal(piCost({ input: 1, output: 2 }), undefined);
	assert.equal(
		piCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		undefined,
	);
	const complete = { input: 0.6, output: 1.2, cacheRead: 0.03, cacheWrite: 0 };
	assert.deepEqual(piCost(complete), complete);
});

test("an unpublishable cost is omitted from the record; the extension fills zeros", () => {
	// A registered model's cost is MANDATORY and pi dereferences
	// model.cost.tiers on every scored turn — so an omitted block throws
	// instead of streaming. Verified against @earendil-works/pi-ai 1.4.0.
	const [unpriced] = shapeListing([row({ pricing: { prompt: "0" } })]);
	assert.ok(unpriced);
	assert.equal(unpriced.cost, undefined);
	assert.deepEqual(toExtensionModel(unpriced).cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

test("every extension key is one pi defines — no folder-specific field rides along", () => {
	const [model] = shapeListing([row({})]);
	assert.ok(model);
	const entry = toExtensionModel(model);
	assert.deepEqual(Object.keys(entry).sort(), [
		"compat",
		"contextWindow",
		"cost",
		"id",
		"input",
		"maxTokens",
		"name",
		"reasoning",
		"thinkingLevelMap",
	]);
	assert.deepEqual(entry.compat, { supportsReasoningEffort: true });
});

test("a published effort enum becomes the map; no enum means no parameter", () => {
	// `getSupportedThinkingLevels` derives the advertised set from
	// thinkingLevelMap, and fabricates off..high when the map is absent — so a
	// difference here would offer one model two different level pickers.
	const models = shapeListing([
		row({
			id: "hf:a/tiered",
			reasoning_parameters: { efforts: ["none", "low", "high", "max"] },
		}),
		row({
			id: "hf:a/quiet",
			supported_features: ["tools"],
			reasoning_parameters: { efforts: [] },
		}),
	]);
	const tiered = models.find((m) => m.id === "hf:a/tiered");
	const quiet = models.find((m) => m.id === "hf:a/quiet");
	assert.ok(tiered && quiet);
	assert.deepEqual(
		toExtensionModel(tiered).thinkingLevelMap,
		tiered.thinkingLevelMap,
	);
	assert.equal(tiered.thinkingLevelMap?.medium, null);
	assert.equal(tiered.thinkingLevelMap?.max, "max");
	assert.equal(quiet.reasoning, false);
	assert.equal("thinkingLevelMap" in toExtensionModel(quiet), false);
});

test("the model store TTL is the refresh gate, not an absolute clock", () => {
	assert.equal(storeIsFresh(Date.now() - 60_000), true);
	assert.equal(storeIsFresh(Date.now() - 5 * 60 * 60 * 1000), false);
});

test("the extension loads and registers a provider with no remembered lineup", async () => {
	// The real entry point, imported and executed — not a textual review. the entry is part of the tsc program too
	// (the folder carries pi's types as a devDependency), so this also pins that
	// the shipped module graph type-checks.
	const previousKey = process.env.SYNTHETIC_API_KEY;
	delete process.env.SYNTHETIC_API_KEY;
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
		assert.equal(id, SYNTHETIC_PROVIDER_ID);
		assert.equal(config.baseUrl, synthetic.baseUrl);
	} finally {
		if (previousKey === undefined) {
			delete process.env.SYNTHETIC_API_KEY;
		} else {
			process.env.SYNTHETIC_API_KEY = previousKey;
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
				assert.ok(err.message.includes(SYNTHETIC_PROVIDER_ID));
				assert.ok(err.cause instanceof Error, "the cause is carried (d045)");
				return true;
			},
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a listing that omits a contract tier fails the refresh (docs/d190)", async () => {
	// The `syn:*` tiers are the provider's API contract: a listing without one
	// is an endpoint fault, so the refresh THROWS and pi reports a normal error
	// — it never publishes a lineup with a hole.
	const realFetch = globalThis.fetch;
	globalThis.fetch = /** @type {any} */ (
		async () => ({ ok: true, status: 200, json: async () => ({ data: [row({})] }) })
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
			/contract tier/,
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
	assert.equal(baseUrlFromEnv("SYNTHETIC_API_KEY", "https://api.synthetic.new/openai/v1", {}), "https://api.synthetic.new/openai/v1");
	assert.equal(
		baseUrlFromEnv("SYNTHETIC_API_KEY", "https://api.synthetic.new/openai/v1", {
			SYNTHETIC_BASE_URL: "https://mirror.example/v1/",
		}),
		"https://mirror.example/v1",
	);
	assert.throws(
		() =>
			baseUrlFromEnv("SYNTHETIC_API_KEY", "https://api.synthetic.new/openai/v1", {
				SYNTHETIC_BASE_URL: "ftp://mirror.example/v1",
			}),
		/SYNTHETIC_BASE_URL is not an absolute http\(s\) URL/,
	);
});
