/**
 * @fileoverview pi-synthetic.test.mjs — tests for the pi-synthetic folder: the
 * shaping rules (merge.mjs), the source fetch (sources.mjs), the committed
 * artifacts, and the extension entry.
 *
 * Everything here either works on plain records or injects its own `fetch`, so
 * the suite needs no network and no relay configuration, and it pins RULES
 * rather than today's model lineup (a lineup assertion would fail on every
 * provider rotation and teach nothing).
 *
 * Run: node --test   (discovers tests/*.test.mjs from the repo root)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
	aliasMap,
	displayNameFor,
	isAliasName,
	laysWithinPiModalities,
	piCost,
	shapeListing,
	shapeRow,
	thinkingLevelMapFor,
	toExtensionModel,
	toPiModel,
} = await import("../pi-synthetic/merge.mjs");
const {
	ALIAS_TIER_IDS,
	fetchListing,
	listingUrl,
	storeIsFresh,
	SYNTHETIC_BASE_URL,
	SYNTHETIC_PROVIDER_ID,
} = await import("../pi-synthetic/sources.mjs");
const { CLOUD_PROVIDERS } = await import("../lib/cloud-providers.mjs");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const synthetic = CLOUD_PROVIDERS.synthetic;

/**
 * One listing row; every field overridable so a test names only its own
 * concern.
 * @param {Partial<import("../pi-synthetic/sources.mjs").ListingRow>} overrides
 * @returns {import("../pi-synthetic/sources.mjs").ListingRow}
 */
const row = (overrides) => ({
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

test("the fact table is the only place the upstream and key env are spelled", () => {
	assert.equal(SYNTHETIC_BASE_URL, "https://api.synthetic.new/openai/v1");
	assert.equal(SYNTHETIC_BASE_URL, synthetic.baseUrl);
	assert.equal(SYNTHETIC_PROVIDER_ID, synthetic.id);
	assert.equal(listingUrl(), `${SYNTHETIC_BASE_URL}/models`);
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

test("a name renders the alias target, and only the exact rendering is accepted", () => {
	const name = displayNameFor("syn:large:text", "syn:large:text", "hf:a/x");
	assert.equal(name, "syn:large:text (hf:a/x)");
	assert.equal(isAliasName("syn:large:text", name, "hf:a/x"), true);
	// A name that merely LOOKS like it carries a target must not be accepted.
	// This is why there is no name parser anywhere in this folder.
	assert.equal(
		isAliasName("hf:a/x", "Nemotron 3 Super 120B (NVFP4)", "NVFP4"),
		false,
	);
	assert.equal(
		isAliasName("syn:large:text", "syn:large:text (hf:a/other)", "hf:a/x"),
		false,
	);
});

test("the alias map is built from data, and covers only contract tiers", () => {
	const models = shapeListing([
		row({ id: "syn:large:text", hugging_face_id: "a/x" }),
		row({ id: "hf:a/x" }),
		// A non-tier alias is not part of the map the extension exports.
		row({ id: "hf:a/y", hugging_face_id: "a/z" }),
	]);
	assert.deepEqual(aliasMap(models), { "syn:large:text": "hf:a/x" });
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
	assert.deepEqual(ids, [...ids].sort());
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

test("the manifest omits an unpublishable cost; the extension fills zeros", () => {
	// The two schemas genuinely differ here: pi's manifest makes the block
	// optional, a registered model's cost is MANDATORY and pi dereferences
	// model.cost.tiers on every scored turn — so an omitted block throws
	// instead of streaming. Verified against @earendil-works/pi-ai 1.4.0.
	const [unpriced] = shapeListing([row({ pricing: { prompt: "0" } })]);
	assert.equal(unpriced.cost, undefined);
	assert.equal("cost" in toPiModel(unpriced), false);
	assert.deepEqual(toExtensionModel(unpriced).cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

test("every extension key is one pi defines — no folder-specific field rides along", () => {
	const [model] = shapeListing([row({})]);
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

test("the extension and the manifest offer the SAME thinking levels per model", () => {
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
		toPiModel(tiered).thinkingLevelMap,
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

test("committed models.json carries the fact-table canonical upstream, not a route", () => {
	const doc = JSON.parse(
		readFileSync(join(repoRoot, "pi-synthetic", "models.json"), "utf-8"),
	);
	const provider = doc.providers[SYNTHETIC_PROVIDER_ID];
	assert.equal(provider.baseUrl, synthetic.baseUrl);
	assert.equal(provider.api, "openai-completions");
	assert.equal(provider.apiKey, `$${synthetic.apiKeyEnv}`);
	assert.equal(provider.authHeader, true);
	const ids = provider.models.map((/** @type {{id: string}} */ m) => m.id);
	assert.deepEqual(ids, [...ids].sort());
	assert.ok(ids.length > 0, "the committed artifact must carry models");
});

test("the committed seed's rows and alias mapping agree with each other", async () => {
	const seed = await import("../pi-synthetic/models.js");
	const byId = new Map(
		seed.SYNTHETIC_MODELS.map((/** @type {{id: string}} */ m) => [m.id, m]),
	);
	for (const [tier, target] of Object.entries(seed.SYNTHETIC_ALIASES)) {
		assert.ok(ALIAS_TIER_IDS.includes(tier), `${tier} is not a contract tier`);
		/** @type {{id: string, name?: string}|undefined} */
		const entry = byId.get(tier);
		assert.ok(entry, `the seed must carry a row for the tier ${tier}`);
		assert.equal(
			isAliasName(tier, entry.name, target),
			true,
			`the seed's row for ${tier} must name its target`,
		);
	}
	// Every committed alias must point at a row the seed itself carries, or the
	// resolution is a pointer a user cannot follow.
	for (const target of Object.values(seed.SYNTHETIC_ALIASES)) {
		assert.ok(byId.has(target), `${target} must be in the seed`);
	}
});

test("the extension loads, registers, and every row survives pi's own code paths", async () => {
	// The real entry point, imported and executed — not a textual review. Node's
	// native TypeScript stripping runs index.ts directly, and the sibling .mjs
	// modules are plain ESM, so this exercises the shipped module graph.
	const previousKey = process.env.SYNTHETIC_API_KEY;
	delete process.env.SYNTHETIC_API_KEY;
	try {
		// A computed specifier on purpose: a literal ".ts" path would pull this
		// file into the tsc program, where pi's host-provided imports report as
		// missing modules. Running it is the check that matters.
		const entrySpecifier = "../pi-synthetic/index.ts";
		const entry = await import(entrySpecifier);
		/** @type {{id: string, config: any}[]} */
		const registered = [];
		entry.default({
			registerProvider: (/** @type {string} */ id, /** @type {any} */ config) =>
				registered.push({ id, config }),
		});
		assert.equal(registered.length, 1, "exactly one provider is registered");
		const [{ id, config }] = registered;
		assert.equal(id, SYNTHETIC_PROVIDER_ID);
		assert.equal(config.baseUrl, synthetic.baseUrl);
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
		// The alias mapping reaches the registration as data.
		assert.deepEqual(config.aliasMap, config.aliasMap);
	} finally {
		if (previousKey === undefined) {
			delete process.env.SYNTHETIC_API_KEY;
		} else {
			process.env.SYNTHETIC_API_KEY = previousKey;
		}
	}
});
