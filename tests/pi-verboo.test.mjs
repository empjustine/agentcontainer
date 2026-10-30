/**
 * @fileoverview pi-verboo.test.mjs — tests for the pi-verboo folder: the
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
	effortValues,
	shapeListing,
	shapeRow,
	thinkingLevelMapFor,
	toExtensionModel,
	toPiModel,
} = await import("../pi-verboo/merge.mjs");
const {
	fetchListing,
	listingUrl,
	storeIsFresh,
	VERBOO_BASE_URL,
	VERBOO_PROVIDER_ID,
} = await import("../pi-verboo/sources.mjs");
const { CLOUD_PROVIDERS } = await import("../lib/cloud-providers.mjs");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const verboo = CLOUD_PROVIDERS.verboo;

/**
 * One listing row; every field overridable so a test names only its own
 * concern.
 * @param {Partial<import("../pi-verboo/sources.mjs").ListingRow>} overrides
 * @returns {import("../pi-verboo/sources.mjs").ListingRow}
 */
const row = (overrides) => ({
	id: "test-model",
	context_window: 1048576,
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
		if (init.reject) throw init.reject;
		return /** @type {Response} */ (
			/** @type {unknown} */ ({
				ok: init.ok ?? true,
				status: init.status ?? 200,
				json: async () => payload,
			})
		);
	};

test("the fact table is the only place the upstream and key env are spelled", () => {
	assert.equal(VERBOO_BASE_URL, "https://code.verboo.ai/router/v1");
	assert.equal(VERBOO_BASE_URL, verboo.baseUrl);
	assert.equal(VERBOO_PROVIDER_ID, verboo.id);
	assert.equal(listingUrl(), `${VERBOO_BASE_URL}/models`);
});

test("the listing is fetched from the canonical upstream, with no redirect surface", async () => {
	let seen = "";
	await fetchListing({
		fetchImpl: async (url) => {
			seen = String(url);
			return /** @type {Response} */ (
				/** @type {unknown} */ ({
					ok: true,
					status: 200,
					json: async () => ({ data: [row({})] }),
				})
			);
		},
	});
	assert.equal(seen, `${verboo.baseUrl}/models`);
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
		if (previousKey === undefined) delete process.env.VERBOO_API_KEY;
		else process.env.VERBOO_API_KEY = previousKey;
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

test("NO cost is ever asserted — the listing publishes no prices (docs/d057)", () => {
	const models = shapeListing([row({}), row({ id: "other" })]);
	for (const model of models) {
		assert.equal("cost" in toPiModel(model), false);
		assert.deepEqual(toExtensionModel(model).cost, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	}
});

test("the manifest publishes no maxTokens; the extension carries the schema default", () => {
	const [model] = shapeListing([row({})]);
	assert.equal("maxTokens" in toPiModel(model), false);
	assert.equal(toExtensionModel(model).maxTokens, 16384);
	// The context window IS published and carried by both.
	assert.equal(toPiModel(model).contextWindow, 1048576);
	assert.equal(toExtensionModel(model).contextWindow, 1048576);
});

test("models are emitted in canonical id order (docs/d050)", () => {
	const models = shapeListing([row({ id: "z-last" }), row({ id: "a-first" })]);
	const ids = models.map((m) => m.id);
	assert.deepEqual(ids, [...ids].sort());
});

test("the model store TTL is the refresh gate, not an absolute clock", () => {
	assert.equal(storeIsFresh(Date.now() - 60_000), true);
	assert.equal(storeIsFresh(Date.now() - 5 * 60 * 60 * 1000), false);
});

test("committed models.json carries the fact-table canonical upstream, not a route", () => {
	const doc = JSON.parse(
		readFileSync(join(repoRoot, "pi-verboo", "models.json"), "utf-8"),
	);
	const provider = doc.providers[VERBOO_PROVIDER_ID];
	assert.equal(provider.baseUrl, verboo.baseUrl);
	assert.equal(provider.api, "openai-completions");
	assert.equal(provider.apiKey, `$${verboo.apiKeyEnv}`);
	assert.equal(provider.authHeader, true);
	for (const retired of ["compat", "headers"]) {
		assert.equal(
			retired in provider,
			false,
			`${retired} would be an invented claim`,
		);
	}
	const ids = provider.models.map((/** @type {{id: string}} */ m) => m.id);
	assert.deepEqual(ids, [...ids].sort());
	assert.ok(ids.length > 0, "the committed artifact must carry models");
});

test("the committed seed agrees with the committed manifest, model for model", async () => {
	const seed = await import("../pi-verboo/models.js");
	const manifest = JSON.parse(
		readFileSync(join(repoRoot, "pi-verboo", "models.json"), "utf-8"),
	);
	const manifestIds = manifest.providers[VERBOO_PROVIDER_ID].models.map(
		(/** @type {{id: string}} */ m) => m.id,
	);
	assert.deepEqual(
		seed.VERBOO_MODELS.map((/** @type {{id: string}} */ m) => m.id),
		manifestIds,
	);
});

test("the extension loads, registers, and every row survives pi's own required fields", async () => {
	// The real entry point, imported and executed — not a textual review. Node's
	// native TypeScript stripping runs index.ts directly, and the sibling .mjs
	// modules are plain ESM, so this exercises the shipped module graph.
	const previousKey = process.env.VERBOO_API_KEY;
	delete process.env.VERBOO_API_KEY;
	try {
		// A computed specifier on purpose: a literal ".ts" path would pull this
		// file into the tsc program, where pi's host-provided imports report as
		// missing modules. Running it is the check that matters.
		const entrySpecifier = "../pi-verboo/index.ts";
		const entry = await import(entrySpecifier);
		/** @type {{id: string, config: any}[]} */
		const registered = [];
		entry.default({
			registerProvider: (/** @type {string} */ id, /** @type {any} */ config) =>
				registered.push({ id, config }),
		});
		assert.equal(registered.length, 1, "exactly one provider is registered");
		const [{ id, config }] = registered;
		assert.equal(id, VERBOO_PROVIDER_ID);
		assert.equal(config.baseUrl, verboo.baseUrl);
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
			]) {
				assert.notEqual(
					model[field],
					undefined,
					`${model.id} must carry ${field}`,
				);
			}
		}
	} finally {
		if (previousKey === undefined) delete process.env.VERBOO_API_KEY;
		else process.env.VERBOO_API_KEY = previousKey;
	}
});
