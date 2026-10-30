/**
 * @fileoverview pi-cline-pass.test.mjs — tests for the pi-cline-pass folder:
 * the shaping rules (merge.mjs), the two source reads and the reconciliation
 * floor (sources.mjs), the committed artifacts, and the extension entry.
 *
 * Everything here works on plain records or injects fetchImpl/CLINE_PASS_MDX,
 * so the suite needs no network — and it pins RULES, never today's lineup (a
 * lineup assertion would fail on the next provider rotation and teach nothing).
 * The only lineup facts asserted are structural: every published id carries
 * the cline-pass/ prefix (the billing contract, docs/d040) and the committed
 * seed and artifact agree with each other.
 *
 * Run: node --test   (discovers tests/*.test.mjs from the repo root)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
	CLINE_PASS_API_KEY_ENV,
	CLINE_PASS_BASE_URL,
	CLINE_PASS_ID_PREFIX,
	CLINE_PASS_LINEUP,
	CLINE_PASS_MATCH_FLOOR,
	CLINE_PASS_NAME,
	CLINE_PASS_PROVIDER_ID,
	fetchCatalogSlice,
	fetchDocsIds,
	parseClinePassDocs,
	resolveAllowlist,
	storeIsFresh,
} = await import("../pi-cline-pass/sources.mjs");
const {
	CLINE_PASS_COMPAT,
	laysWithinPiModalities,
	piCost,
	shapeCatalog,
	shapeRow,
	thinkingLevelMapFor,
	toExtensionModel,
	toPiModel,
} = await import("../pi-cline-pass/merge.mjs");
const { CLOUD_PROVIDERS } = await import("../lib/cloud-providers.mjs");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const clinePass = CLOUD_PROVIDERS["cline-pass"];

/**
 * One models.dev catalog record (the models.dev wire field names); every
 * field overridable so a test names only its own concern.
 * @param {{[K in keyof import("../pi-cline-pass/sources.mjs").CatalogRecord]?: import("../pi-cline-pass/sources.mjs").CatalogRecord[K] | undefined}} overrides
 * @returns {import("../pi-cline-pass/sources.mjs").CatalogRecord}
 */
const record = (overrides = {}) =>
	/** @type {import("../pi-cline-pass/sources.mjs").CatalogRecord} */ (
		/** @type {unknown} */ ({
			name: "Test Model",
			modalities: { input: ["text"], output: ["text"] },
			reasoning: true,
			cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
			limit: { context: 200_000, output: 64_000 },
			reasoning_options: [
				{ type: "effort", values: ["none", "low", "medium", "xhigh"] },
			],
			...overrides,
		})
	);

/**
 * The models.dev payload shape around the slice: the whole catalog, keyed
 * by provider id, models underneath — and every model key already carries
 * the catalog's own cline-pass/ namespace.
 * @param {Record<string, import("../pi-cline-pass/sources.mjs").CatalogRecord>} models
 * @returns {Record<string, unknown>}
 */
const catalogPayload = (models) => ({ [CLINE_PASS_PROVIDER_ID]: { models } });

/**
 * A fetch stub that answers with one payload. Typed through unknown because
 * the shape is a deliberate subset of Response — the sources read ok, status,
 * json() and text() only.
 * @param {unknown} payload
 * @param {{ok?: boolean, status?: number, reject?: Error, text?: string}} [init]
 * @returns {(input?: unknown, init?: unknown) => Promise<Response>}
 */
const fetchOnce =
	(payload, init = {}) =>
	async (/** @type {unknown} */ _input, /** @type {unknown} */ _init) => {
		if (init.reject) {
			throw init.reject;
		}
		return /** @type {Response} */ (
			/** @type {unknown} */ ({
				ok: init.ok ?? true,
				status: init.status ?? 200,
				json: async () => payload,
				text: async () => init.text ?? "",
			})
		);
	};

test("the fact table is the only place the upstream and key env are spelled", () => {
	assert.equal(CLINE_PASS_BASE_URL, "https://api.cline.bot/api/v1");
	assert.equal(CLINE_PASS_BASE_URL, clinePass.baseUrl);
	assert.equal(CLINE_PASS_PROVIDER_ID, clinePass.id);
	assert.equal(CLINE_PASS_NAME, clinePass.label);
	assert.equal(CLINE_PASS_API_KEY_ENV, clinePass.apiKeyEnv);
	assert.equal(CLINE_PASS_ID_PREFIX, `${CLINE_PASS_PROVIDER_ID}/`);
});

test("the catalog read is one canonical https fetch, whatever else is overridden", async () => {
	// The models.dev URL is deliberately NOT env-overridable (docs/d086): a
	// redirected metadata source is an invented metadata source. Only the
	// docs READ takes a local override (CLINE_PASS_MDX, below).
	/** @type {string[]} */
	const seen = [];
	await fetchCatalogSlice({
		fetchImpl: async (url) => {
			seen.push(String(url));
			return fetchOnce(catalogPayload({ "cline-pass/glm-5.2": record() }))();
		},
	});
	assert.deepEqual(seen, ["https://models.dev/api.json"]);
});

test("a failed catalog fetch throws instead of inventing a catalog", async () => {
	// No metadata source means nothing publishable: the committed artifact is
	// the offline fallback, so a broken run must never write a worse one.
	await assert.rejects(
		fetchCatalogSlice({
			fetchImpl: fetchOnce(null, { ok: false, status: 502 }),
		}),
		/502/,
	);
	await assert.rejects(
		fetchCatalogSlice({
			fetchImpl: fetchOnce(null, { reject: new Error("ECONNREFUSED") }),
		}),
		/ECONNREFUSED/,
	);
	await assert.rejects(fetchCatalogSlice({ fetchImpl: fetchOnce([]) }), {
		message: /no cline-pass models/,
	});
	await assert.rejects(
		fetchCatalogSlice({ fetchImpl: fetchOnce(catalogPayload({})) }),
		{ message: /no cline-pass models/ },
	);
});

test("the catalog slice comes back keyed in the prefixed namespace", async () => {
	const slice = await fetchCatalogSlice({
		fetchImpl: fetchOnce(
			catalogPayload({
				"cline-pass/glm-5.2": record(),
				"cline-pass/kimi-k3": record(),
			}),
		),
	});
	assert.deepEqual(Object.keys(slice).sort(), [
		"cline-pass/glm-5.2",
		"cline-pass/kimi-k3",
	]);
});

test("the docs parser reads backticked ids from the second column of ## Models", () => {
	const mdx = [
		"## Overview",
		"",
		"| Plan | Limit |",
		"| --- | --- |",
		"| Pro | 12h |",
		"",
		"## Models",
		"",
		"| Model | Model ID |",
		"| --- | --- |",
		"| GLM 5.2 | `cline-pass/glm-5.2` |",
		"| Kimi K2.6 | cline-pass/kimi-k2.6 |",
		"| Unprefixed | not-a-cline-id |",
		"",
		"## FAQ",
		"",
		"cline-pass/glm-5.3 is not in a table and must not count.",
	].join("\n");
	assert.deepEqual(parseClinePassDocs(mdx), [
		"cline-pass/glm-5.2",
		"cline-pass/kimi-k2.6",
	]);
	// A section without prefixed ids is no lineup at all — null, not empty.
	assert.equal(parseClinePassDocs("## Models\n\nnothing here\n"), null);
	assert.equal(parseClinePassDocs("no table here"), null);
});

test("the docs fetch degrades to null — it never throws", async () => {
	// A missing or unreadable markdown file says nothing about whether the
	// subscription still serves its models, so it must not abort a refresh:
	// resolveAllowlist then falls back to the committed lineup.
	assert.equal(
		await fetchDocsIds({
			fetchImpl: fetchOnce(null, { ok: false, status: 404 }),
		}),
		null,
	);
	assert.equal(
		await fetchDocsIds({
			fetchImpl: fetchOnce(null, { reject: new Error("ECONNREFUSED") }),
		}),
		null,
	);
	// With no local override, the read goes to the canonical raw file.
	let seen = "";
	await fetchDocsIds({
		fetchImpl: async (url) => {
			seen = String(url);
			return fetchOnce(null, {
				text: "## Models\n\n| Model | Model ID |\n| --- | --- |\n| A | cline-pass/glm-5.2 |\n",
			})();
		},
	});
	assert.ok(
		seen.startsWith("https://raw.githubusercontent.com/cline/cline/"),
		`${seen} must be the canonical raw file, not a redirectable surface`,
	);
});

test("CLINE_PASS_MDX overrides the docs read with a local file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cline-pass-test-"));
	const file = join(dir, "clinepass.mdx");
	writeFileSync(
		file,
		"## Models\n\n| Model | Model ID |\n| --- | --- |\n| GLM 5.2 | " +
			"cline-pass/glm-5.2" +
			" |\n",
	);
	const previous = process.env.CLINE_PASS_MDX;
	process.env.CLINE_PASS_MDX = file;
	try {
		assert.deepEqual(await fetchDocsIds(), ["cline-pass/glm-5.2"]);
	} finally {
		if (previous === undefined) {
			delete process.env.CLINE_PASS_MDX;
		} else {
			process.env.CLINE_PASS_MDX = previous;
		}
	}
});

test("a healthy ratio adopts docs ∪ catalog; a rotten one falls back", () => {
	const docs = ["a", "b", "c", "d", "e"].map((id) => CLINE_PASS_ID_PREFIX + id);
	const records = Object.fromEntries(
		["a", "b", "c", "d", "f"].map((id) => [
			CLINE_PASS_ID_PREFIX + id,
			record(),
		]),
	);
	// 4 of 5 docs rows found in the catalog is exactly the floor: adoption.
	assert.deepEqual(resolveAllowlist(docs, records), [
		"cline-pass/a",
		"cline-pass/b",
		"cline-pass/c",
		"cline-pass/d",
		"cline-pass/e",
		"cline-pass/f",
	]);
	// One more docs row the catalog cannot confirm drops below the floor:
	// the committed lineup wins, as the same committed value.
	const sparse = resolveAllowlist(
		[...docs, "cline-pass/g", "cline-pass/h"],
		records,
	);
	assert.equal(sparse, CLINE_PASS_LINEUP);
	// An unreadable table (null docs) is the same fallback.
	assert.equal(resolveAllowlist(null, records), CLINE_PASS_LINEUP);
	assert.equal(CLINE_PASS_MATCH_FLOOR, 0.8);
});

test("the shape guard drops every row that would bill wrong or not at all", () => {
	// The prefix is a BILLING contract: shapeCatalog owns the guard, over the
	// map key — shapeRow itself only demands an id. The smuggle test below
	// pins that a record body's own unprefixed id cannot replace the
	// prefix-guarded key.
	assert.equal(shapeRow({ ...record() }), undefined, "no id, no model");
	assert.deepEqual(
		shapeCatalog(
			{ "cline-pass/glm-5.2": record({ id: "glm-5.2" }) },
			undefined,
		).map((m) => m.id),
		["cline-pass/glm-5.2"],
	);
	assert.equal(
		shapeRow({
			...record(),
			id: "cline-pass/text-embedding-3",
			family: "text-embedding",
		}),
		undefined,
		"an embedding model has no chat surface",
	);
	assert.equal(
		shapeRow({
			...record(),
			id: "cline-pass/audio-only",
			modalities: { input: ["audio"], output: ["text"] },
		}),
		undefined,
		"no text input means pi cannot drive the model",
	);
	assert.equal(
		shapeRow({
			...record(),
			id: "cline-pass/audio-out",
			modalities: { input: ["text"], output: ["audio"] },
		}),
		undefined,
		"an audio output pi cannot consume",
	);
	const ok = shapeRow({ ...record(), id: "cline-pass/glm-5.2" });
	assert.equal(ok?.id, "cline-pass/glm-5.2");
	assert.equal(ok?.name, "Test Model");
});

test("rich input trims to what pi originates, and id-only records survive", () => {
	const models = shapeCatalog(
		{
			"cline-pass/rich": record({
				modalities: {
					input: ["text", "image", "video", "pdf"],
					output: ["text"],
				},
			}),
			"cline-pass/no-metadata": record({ modalities: undefined }),
		},
		undefined,
	);
	assert.deepEqual(
		models.map((m) => m.id),
		["cline-pass/no-metadata", "cline-pass/rich"],
	);
	assert.deepEqual(models.find((m) => m.id === "cline-pass/rich")?.input, [
		"text",
		"image",
	]);
	// A record with no modality metadata passes the gate and gets the core.
	assert.deepEqual(
		models.find((m) => m.id === "cline-pass/no-metadata")?.input,
		["text"],
	);
	assert.equal(laysWithinPiModalities({}), true);
});

test("thinking levels come from the published enum only", () => {
	const map = thinkingLevelMapFor(["none", "low", "medium", "xhigh"]);
	assert.equal(map?.off, "none", "the provider spells pi's off as none");
	assert.equal(map?.low, "low");
	assert.equal(map?.xhigh, "xhigh");
	assert.equal(
		map?.high,
		null,
		"an unpublished level is hidden, never invented",
	);
	assert.equal(map?.max, null);
	// No published enum is not "no reasoning" — it is "the source did not say",
	// and nothing may be invented from it (the fleet's onOffThinking: false).
	assert.equal(thinkingLevelMapFor(undefined), null);
	assert.equal(thinkingLevelMapFor([]), null);
	// The enum flows through the record shape, too.
	const [quiet] = shapeCatalog(
		{
			"cline-pass/quiet": record({
				reasoning: false,
				reasoning_options: undefined,
			}),
		},
		undefined,
	);
	assert.equal(quiet.thinkingLevelMap, null);
	assert.equal("thinkingLevelMap" in toExtensionModel(quiet), false);
});

test("a partial price block completes with zeros; an all-zero block is absent", () => {
	assert.deepEqual(piCost({ input: 1, output: 2 }), {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
	});
	assert.equal(piCost({ input: 0, output: 0 }), undefined);
	assert.equal(piCost(undefined), undefined);
	// A record with no published prices at all shapes to no cost.
	const [unpriced] = shapeCatalog(
		{ "cline-pass/glm-5.2": record({ cost: null }) },
		undefined,
	);
	assert.equal(unpriced.cost, undefined);
});

test("the manifest omits an unpublishable cost; the extension fills zeros", () => {
	// The two schemas genuinely differ here: pi's manifest makes the block
	// optional, a registered model's cost is MANDATORY and pi dereferences
	// model.cost on every scored turn — so an omitted block throws instead of
	// streaming. Verified against @earendil-works/pi-ai 1.4.0, the same way
	// pi-synthetic verified its own.
	const [unpriced] = shapeCatalog(
		{ "cline-pass/glm-5.2": record({ cost: { input: 0, output: 0 } }) },
		[`${CLINE_PASS_ID_PREFIX}glm-5.2`],
	);
	assert.equal("cost" in toPiModel(unpriced), false);
	assert.deepEqual(toExtensionModel(unpriced).cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

test("every extension key is one pi defines — and the compat fact rides per model", () => {
	// ProviderConfig has no provider-level compat field (pi 1.4.0), and the
	// registration overwrites the models layer: the one published fact
	// (docs/d022/d033) must live on every model or it is silently lost.
	const [model] = shapeCatalog({ "cline-pass/glm-5.2": record() }, [
		`${CLINE_PASS_ID_PREFIX}glm-5.2`,
	]);
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
	assert.deepEqual(entry.compat, { supportsDeveloperRole: false });
	assert.deepEqual(entry.compat, CLINE_PASS_COMPAT);
	// The manifest keeps the fleet's provider-level block instead: no
	// per-model compat there.
	const manifest = toPiModel(model);
	assert.deepEqual(Object.keys(manifest).sort(), [
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

test("models are emitted sorted, allowlist-filtered, prefix-carrying", () => {
	const models = shapeCatalog(
		{
			"cline-pass/z-last": record(),
			"cline-pass/a-first": record(),
			"cline-pass/not-listed": record(),
			"wrong-namespace": record(),
		},
		[`${CLINE_PASS_ID_PREFIX}z-last`, `${CLINE_PASS_ID_PREFIX}a-first`],
	);
	assert.deepEqual(
		models.map((m) => m.id),
		["cline-pass/a-first", "cline-pass/z-last"],
	);
});

test("the model store TTL is the refresh gate, not an absolute clock", () => {
	assert.equal(storeIsFresh(Date.now() - 60_000), true);
	assert.equal(storeIsFresh(Date.now() - 5 * 60 * 60 * 1000), false);
});

test("committed models.json carries the fact-table upstream and provider compat", () => {
	const doc = JSON.parse(
		readFileSync(join(repoRoot, "pi-cline-pass", "models.json"), "utf-8"),
	);
	const provider = doc.providers[CLINE_PASS_PROVIDER_ID];
	assert.equal(provider.name, CLINE_PASS_NAME);
	assert.equal(provider.baseUrl, clinePass.baseUrl);
	assert.equal(provider.api, "openai-completions");
	assert.equal(provider.apiKey, `$${clinePass.apiKeyEnv}`);
	assert.equal(provider.authHeader, true);
	// The fleet's shape: the compat fact at the provider level (modelCompat
	// is null there — nothing per-model in this artifact).
	assert.deepEqual(provider.compat, { supportsDeveloperRole: false });
	const ids = provider.models.map((/** @type {{id: string}} */ m) => m.id);
	assert.ok(ids.length > 0, "the committed artifact must carry models");
	assert.deepEqual(ids, [...ids].sort());
	for (const id of ids) {
		assert.ok(
			id.startsWith(CLINE_PASS_ID_PREFIX),
			`${id} must carry the billing prefix (docs/d040)`,
		);
	}
});

test("the committed seed and the committed artifact publish the same lineup", async () => {
	const seed = await import("../pi-cline-pass/models.js");
	const doc = JSON.parse(
		readFileSync(join(repoRoot, "pi-cline-pass", "models.json"), "utf-8"),
	);
	const seedIds = seed.CLINE_PASS_MODELS.map(
		(/** @type {{id: string}} */ m) => m.id,
	);
	const artifactIds = doc.providers[CLINE_PASS_PROVIDER_ID].models.map(
		(/** @type {{id: string}} */ m) => m.id,
	);
	assert.deepEqual(seedIds, artifactIds);
	// The seed's rows must satisfy the same mandatory shape pi dereferences.
	for (const model of seed.CLINE_PASS_MODELS) {
		assert.notEqual(model.cost, undefined, `${model.id} needs a cost block`);
		assert.deepEqual(model.compat, { supportsDeveloperRole: false });
	}
});

test("the extension loads, registers, and every row carries the compat fact", async () => {
	// The real entry point, imported and executed — not a textual review. Node's
	// native TypeScript stripping runs index.ts directly, and the sibling .mjs
	// modules are plain ESM, so this exercises the shipped module graph.
	const previousKey = process.env.CLINE_API_KEY;
	delete process.env.CLINE_API_KEY;
	try {
		// A computed specifier on purpose: a literal ".ts" path would pull this
		// file into the tsc program, where pi's host-provided imports report as
		// missing modules. Running it is the check that matters.
		const entrySpecifier = "../pi-cline-pass/index.ts";
		const entry = await import(entrySpecifier);
		/** @type {{id: string, config: any}[]} */
		const registered = [];
		entry.default({
			registerProvider: (/** @type {string} */ id, /** @type {any} */ config) =>
				registered.push({ id, config }),
		});
		assert.equal(registered.length, 1, "exactly one provider is registered");
		const [{ id, config }] = registered;
		assert.equal(id, CLINE_PASS_PROVIDER_ID);
		assert.equal(config.baseUrl, clinePass.baseUrl);
		assert.equal(config.api, "openai-completions");
		assert.equal(config.apiKey, `$${clinePass.apiKeyEnv}`);
		assert.equal(config.authHeader, true);
		assert.ok(config.models.length > 0);
		assert.equal(typeof config.refreshModels, "function");
		for (const model of config.models) {
			assert.ok(model.id.startsWith(CLINE_PASS_ID_PREFIX), model.id);
			assert.notEqual(model.cost, undefined, `${model.id} needs a cost block`);
			assert.deepEqual(
				model.compat,
				{ supportsDeveloperRole: false },
				`${model.id} must carry the published compat fact`,
			);
		}
		// With no network wanted and no store to fall back on, the refresh
		// returns undefined — pi keeps the seed the extension registered.
		const refreshed = await config.refreshModels({ allowNetwork: false });
		assert.equal(refreshed, undefined);
	} finally {
		if (previousKey === undefined) {
			delete process.env.CLINE_API_KEY;
		} else {
			process.env.CLINE_API_KEY = previousKey;
		}
	}
});
