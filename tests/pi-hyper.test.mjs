/**
 * @fileoverview pi-hyper.test.mjs — tests for the pi-hyper folder: the
 * shaping rules (merge.mjs), the source fetch (sources.mjs), the committed
 * artifacts, and the extension entry.
 *
 * Everything here either works on plain records or injects its own `fetch`,
 * so the suite needs no network, and it pins RULES rather than today's model
 * lineup (a lineup assertion would fail on every provider rotation and
 * teach nothing).
 *
 * Run: node --test   (discovers tests/*.test.mjs from the repo root)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
	compatFor,
	effortValues,
	piCost,
	shapeCatalog,
	shapeRow,
	thinkingLevelMapFor,
	toExtensionModel,
	toPiModel,
} = await import("../pi-hyper/merge.mjs");
const {
	catalogUrl,
	fetchCatalog,
	HYPER_BASE_URL,
	HYPER_PROVIDER_ID,
	storeIsFresh,
} = await import("../pi-hyper/sources.mjs");
const { CLOUD_PROVIDERS } = await import("../lib/cloud-providers.mjs");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hyper = CLOUD_PROVIDERS.hyper;

/**
 * One catalog record; every field overridable so a test names only its own
 * concern.
 * @param {{[K in keyof import("../pi-hyper/sources.mjs").CatalogRecord]?: import("../pi-hyper/sources.mjs").CatalogRecord[K] | undefined}} overrides
 * @returns {import("../pi-hyper/sources.mjs").CatalogRecord}
 */
const record = (overrides) =>
	/** @type {import("../pi-hyper/sources.mjs").CatalogRecord} */ ({
		id: "test-model",
		name: "Test Model",
		can_reason: true,
		reasoning_levels: ["low", "high", "max"],
		supports_attachments: false,
		context_window: 1_000_000,
		default_max_tokens: 16_000,
		cost_per_1m_in: 1,
		cost_per_1m_out: 4,
		cost_per_1m_in_cached: 0,
		cost_per_1m_out_cached: 0.1,
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
	assert.equal(HYPER_BASE_URL, "https://hyper.charm.land/v1");
	assert.equal(HYPER_BASE_URL, hyper.baseUrl);
	assert.equal(HYPER_PROVIDER_ID, hyper.id);
	assert.equal(catalogUrl(), `${HYPER_BASE_URL}/provider`);
});

test("the catalog is fetched from the canonical upstream, with no redirect surface", async () => {
	let seen = "";
	await fetchCatalog({
		fetchImpl: async (url) => {
			seen = String(url);
			return /** @type {Response} */ (
				/** @type {unknown} */ ({
					ok: true,
					status: 200,
					json: async () => ({ models: [record({})] }),
				})
			);
		},
	});
	assert.equal(seen, `${hyper.baseUrl}/provider`);
});

test("a fetch failure throws instead of inventing a catalog", async () => {
	// There is no second source and no stale-copy branch: the committed
	// artifact is the fallback, so a failed run must not write a worse one.
	await assert.rejects(
		fetchCatalog({ fetchImpl: fetchOnce(null, { ok: false, status: 502 }) }),
		/502/,
	);
	await assert.rejects(
		fetchCatalog({
			fetchImpl: fetchOnce(null, { reject: new Error("ECONNREFUSED") }),
		}),
		/ECONNREFUSED/,
	);
	await assert.rejects(
		fetchCatalog({ fetchImpl: fetchOnce({ models: [] }) }),
		/no usable rows/,
	);
});

test("the catalog document is read by its models member, and only that", async () => {
	// The document is a provider self-description; the identity fields
	// around the catalog are upstream's, not this folder's to interpret.
	const rows = await fetchCatalog({
		fetchImpl: fetchOnce({
			name: "Charm Hyper",
			id: "hyper",
			api_endpoint: "https://hyper.charm.land/api/v1/fantasy",
			models: [record({ id: "a" }), record({ id: "b" })],
		}),
	});
	assert.deepEqual(
		rows.map((r) => r.id),
		["a", "b"],
	);
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

test("a reasoning model with NO enum gets the ON_OFF map, a non-reasoning model gets none", () => {
	// The fleet row's onOffThinking: true — the vendor extension's map, the
	// only case where a map is rendered without a published enum.
	const onOff = shapeRow(record({ reasoning_levels: undefined }));
	assert.deepEqual(onOff?.thinkingLevelMap, {
		off: "off",
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: "max",
	});
	const quiet = shapeRow(record({ can_reason: false }));
	assert.equal(quiet?.reasoning, false);
	assert.equal(quiet?.thinkingLevelMap, null);
});

test("input modalities come from the attachment flag", () => {
	const plain = shapeRow(record({}));
	const visual = shapeRow(record({ supports_attachments: true }));
	assert.deepEqual(plain?.input, ["text"]);
	assert.deepEqual(visual?.input, ["text", "image"]);
});

test("the cached-price pairing looks crossed and is not", () => {
	// cost_per_1m_in_cached is what a cached INPUT costs to have WRITTEN
	// (cacheWrite); cost_per_1m_out_cached what a cached OUTPUT costs to
	// READ back (cacheRead) — verified against catwalk's own schema
	// (pi-synthetic/TODO.md).
	const [model] = shapeCatalog([
		record({
			cost_per_1m_in: 1,
			cost_per_1m_out: 4,
			cost_per_1m_in_cached: 0.5,
			cost_per_1m_out_cached: 0.1,
		}),
	]);
	assert.deepEqual(model.cost, {
		input: 1,
		output: 4,
		cacheRead: 0.1,
		cacheWrite: 0.5,
	});
});

test("a partial price block completes with zeros; an all-zero one is omitted (docs/d057)", () => {
	assert.deepEqual(piCost({ input: 1, output: 2, cacheRead: 0.1 }), {
		input: 1,
		output: 2,
		cacheRead: 0.1,
		cacheWrite: 0,
	});
	assert.equal(
		piCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		undefined,
	);
	assert.equal(piCost(undefined), undefined);
});

test("models are emitted in canonical id order (docs/d050)", () => {
	const models = shapeCatalog([
		record({ id: "z-last" }),
		record({ id: "a-first" }),
		record({ id: "m-middle" }),
	]);
	const ids = models.map((m) => m.id);
	assert.deepEqual(ids, [...ids].sort());
});

test("the compat mirror is the vendor transcription, with the enum deciding effort", () => {
	// The ONE behavioral copy this folder makes (charmbracelet/
	// pi-hyper-provider src/models.ts) — values pinned so a silent change
	// to the transcription is caught here, not in a user's wire traffic.
	const tiered = shapeRow(record({}));
	const quiet = shapeRow(record({ reasoning_levels: undefined }));
	assert.ok(tiered && quiet);
	assert.deepEqual(compatFor(tiered), {
		supportsStore: false,
		supportsReasoningEffort: true,
		thinkingFormat: "deepseek",
		maxTokensField: "max_tokens",
	});
	assert.deepEqual(compatFor(quiet), {
		supportsStore: false,
		supportsReasoningEffort: false,
		thinkingFormat: "deepseek",
		maxTokensField: "max_tokens",
	});
	assert.equal(effortValues(record({ reasoning_levels: ["MAX"] }))?.[0], "max");
});

test("the manifest omits an unpublishable cost; the extension fills zeros", () => {
	const [free] = shapeCatalog([
		record({
			cost_per_1m_in: 0,
			cost_per_1m_out: 0,
			cost_per_1m_in_cached: 0,
			cost_per_1m_out_cached: 0,
		}),
	]);
	assert.equal(free.cost, undefined);
	assert.equal("cost" in toPiModel(free), false);
	assert.deepEqual(toExtensionModel(free).cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

test("the extension and the manifest offer the SAME thinking levels per model", () => {
	const models = shapeCatalog([
		record({ id: "a-tiered" }),
		record({ id: "a-onoff", reasoning_levels: undefined }),
	]);
	for (const model of models) {
		assert.deepEqual(
			toExtensionModel(model).thinkingLevelMap,
			toPiModel(model).thinkingLevelMap,
		);
	}
});

test("every extension key is one pi defines — no folder-specific field rides along", () => {
	const [model] = shapeCatalog([record({})]);
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
});

test("the model store TTL is the refresh gate, not an absolute clock", () => {
	assert.equal(storeIsFresh(Date.now() - 60_000), true);
	assert.equal(storeIsFresh(Date.now() - 5 * 60 * 60 * 1000), false);
});

test("committed models.json carries the fact-table canonical upstream, not a route", () => {
	const doc = JSON.parse(
		readFileSync(join(repoRoot, "pi-hyper", "models.json"), "utf-8"),
	);
	const provider = doc.providers[HYPER_PROVIDER_ID];
	assert.equal(provider.baseUrl, hyper.baseUrl);
	assert.equal(provider.api, "openai-completions");
	assert.equal(provider.apiKey, `$${hyper.apiKeyEnv}`);
	assert.equal(provider.authHeader, true);
	assert.ok(
		provider.headers["User-Agent"],
		"the client identity rides the block",
	);
	assert.equal("compat" in provider, false, "wire facts ride per model");
	const ids = provider.models.map((/** @type {{id: string}} */ m) => m.id);
	assert.deepEqual(ids, [...ids].sort());
	assert.ok(ids.length > 0, "the committed artifact must carry models");
});

test("the committed seed agrees with the committed manifest, model for model", async () => {
	const seed = await import("../pi-hyper/models.js");
	const manifest = JSON.parse(
		readFileSync(join(repoRoot, "pi-hyper", "models.json"), "utf-8"),
	);
	const manifestIds = manifest.providers[HYPER_PROVIDER_ID].models.map(
		(/** @type {{id: string}} */ m) => m.id,
	);
	assert.deepEqual(
		seed.HYPER_MODELS.map((/** @type {{id: string}} */ m) => m.id),
		manifestIds,
	);
});

test("the extension loads, registers, and every row survives pi's own required fields", async () => {
	// The real entry point, imported and executed — not a textual review. Node's
	// native TypeScript stripping runs index.ts directly, and the sibling .mjs
	// modules are plain ESM, so this exercises the shipped module graph.
	const previousKey = process.env.HYPER_API_KEY;
	delete process.env.HYPER_API_KEY;
	try {
		// A computed specifier on purpose: a literal ".ts" path would pull this
		// file into the tsc program, where pi's host-provided imports report as
		// missing modules. Running it is the check that matters.
		const entrySpecifier = "../pi-hyper/index.ts";
		const entry = await import(entrySpecifier);
		/** @type {{id: string, config: any}[]} */
		const registered = [];
		entry.default({
			registerProvider: (/** @type {string} */ id, /** @type {any} */ config) =>
				registered.push({ id, config }),
		});
		assert.equal(registered.length, 1, "exactly one provider is registered");
		const [{ id, config }] = registered;
		assert.equal(id, HYPER_PROVIDER_ID);
		assert.equal(config.baseUrl, hyper.baseUrl);
		assert.ok(config.models.length > 0);
		for (const model of config.models) {
			for (const field of [
				"id",
				"name",
				"reasoning",
				"input",
				"cost",
				"contextWindow",
				"maxTokens",
				"compat",
			]) {
				assert.notEqual(
					model[field],
					undefined,
					`${model.id} must carry ${field}`,
				);
			}
		}
	} finally {
		if (previousKey === undefined) {
			delete process.env.HYPER_API_KEY;
		} else {
			process.env.HYPER_API_KEY = previousKey;
		}
	}
});
