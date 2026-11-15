/**
 * @fileoverview pi-cline-pass.test.mjs — tests for the pi-cline-pass folder:
 * the one source read (sources.mjs), the shaping (merge.mjs), the committed
 * artifacts, and the extension entry.
 *
 * Everything here works on plain lineup entries or injects CLINE_PASS_MDX, so
 * the suite needs no network — and it pins RULES, never today's lineup (a
 * lineup assertion would fail on the next provider rotation and teach nothing).
 * The only lineup facts asserted are structural: every published id carries the
 * cline-pass/ prefix (the billing contract, docs/d040), the docs table is the
 * sole source of both the id and the name (docs/d189), and the committed
 * artifact is the freshness gate's record — nothing reads it at runtime
 * (docs/d190).
 *
 * Run: node --test   (from this folder — discovers tests/*.test.mjs)
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
	CLINE_PASS,
	CLINE_PASS_API_KEY_ENV,
	CLINE_PASS_BASE_URL,
	CLINE_PASS_ID_PREFIX,
	CLINE_PASS_NAME,
	CLINE_PASS_PROVIDER_ID,
	fetchDocsLineup,
	parseClinePassDocs,
	storeIsFresh,
} = await import("../sources.mjs");
const { CLINE_PASS_COMPAT, shapeCatalog, toExtensionModel } = await import(
	"../merge.mjs"
);

// The folder's own row: the one place the upstream and the key env are spelled
// (sources.mjs), so the exports above are only believable if they match it.
const clinePass = CLINE_PASS;

/**
 * A fetch stub that answers with one payload: the sources read ok, status,
 * json() and text() only, so a deliberate subset of Response is enough.
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

test("the folder's row is the only place the upstream and key env are spelled", () => {
	assert.equal(CLINE_PASS_BASE_URL, "https://api.cline.bot/api/v1");
	assert.equal(CLINE_PASS_BASE_URL, clinePass.baseUrl);
	assert.equal(CLINE_PASS_PROVIDER_ID, clinePass.id);
	assert.equal(CLINE_PASS_NAME, clinePass.label);
	assert.equal(CLINE_PASS_API_KEY_ENV, clinePass.apiKeyEnv);
	assert.equal(CLINE_PASS_ID_PREFIX, `${CLINE_PASS_PROVIDER_ID}/`);
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
		{ id: "cline-pass/glm-5.2", name: "GLM 5.2" },
		{ id: "cline-pass/kimi-k2.6", name: "Kimi K2.6" },
	]);
	// A section without prefixed ids is no lineup at all — null, not empty.
	assert.equal(parseClinePassDocs("## Models\n\nnothing here\n"), null);
	assert.equal(parseClinePassDocs("no table here"), null);
});

test("the docs read throws — no table is no lineup", async () => {
	// A missing or unreadable table says nothing about the lineup, so it must
	// not be papered over with a remembered one (docs/d189): the caller gets an
	// error and ClinePass is unavailable until the table answers again.
	await assert.rejects(
		fetchDocsLineup({
			fetchImpl: fetchOnce(null, { ok: false, status: 404 }),
		}),
		/404/,
	);
	await assert.rejects(
		fetchDocsLineup({
			fetchImpl: fetchOnce(null, { reject: new Error("ECONNREFUSED") }),
		}),
		/ECONNREFUSED/,
	);
	// A 200 whose body carries no ## Models table is the same answer.
	await assert.rejects(fetchDocsLineup({ fetchImpl: fetchOnce(null) }), {
		message: /no ## Models table/,
	});
	// With no local override, the read goes to the canonical raw file.
	let seen = "";
	const lineup = await fetchDocsLineup({
		fetchImpl: async (url) => {
			// Request has no own toString (base [object Request]); the pipeline
			// hands fetchImpl URL objects, so only the Request case needs the url.
			seen = String(url instanceof Request ? url.url : url);
			return fetchOnce(null, {
				text: "## Models\n\n| Model | Model ID |\n| --- | --- |\n| A | cline-pass/glm-5.2 |\n",
			})();
		},
	});
	assert.deepEqual(lineup, [{ id: "cline-pass/glm-5.2", name: "A" }]);
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
		assert.deepEqual(await fetchDocsLineup(), [
			{ id: "cline-pass/glm-5.2", name: "GLM 5.2" },
		]);
	} finally {
		if (previous === undefined) {
			delete process.env.CLINE_PASS_MDX;
		} else {
			process.env.CLINE_PASS_MDX = previous;
		}
	}
});

test("the table is the whole model: the id, the display name, nothing invented", () => {
	// The docs table names ids and display names; it publishes no limit, no
	// modality and no price, and models.dev's second read retired rather than
	// let its reference rates stand in as cost (docs/d189's amendment).
	const [row] = shapeCatalog([
		{ id: "cline-pass/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" },
	]);
	assert.ok(row);
	assert.deepEqual(row, {
		id: "cline-pass/deepseek-v4.1-flash-1017",
		name: "DeepSeek V4.1 Flash",
	});
});

const sortedLineup = [
	{ id: "cline-pass/z-last", name: "Z" },
	{ id: "cline-pass/a-first", name: "A" },
	{ id: "wrong-namespace", name: "Nope" },
];

test("models are emitted sorted, and a row outside the namespace never publishes", () => {
	assert.deepEqual(
		shapeCatalog(sortedLineup).map((m) => m.id),
		["cline-pass/a-first", "cline-pass/z-last"],
		"the prefix guard is the billing contract (docs/d040)",
	);
});

test("the extension fills what the registration schema requires", () => {
	// cost is MANDATORY on a registered model (pi dereferences model.cost on
	// every scored turn), and a subscription model is not billed per token, so
	// the honest block is zero. Verified against @earendil-works/pi-ai 1.4.0.
	const [model] = shapeCatalog([{ id: "cline-pass/glm-5.2", name: "GLM 5.2" }]);
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
	]);
	assert.deepEqual(entry.cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
	// ProviderConfig has no provider-level compat field (pi 1.4.0), and the
	// registration overwrites the models layer: the one published fact
	// (docs/d022/d033) must ride on every model or it is silently lost.
	assert.deepEqual(entry.compat, CLINE_PASS_COMPAT);
	// No source publishes an effort enum for these ids, so no thinking map is
	// invented and pi sends no thinking parameter.
	assert.equal(entry.reasoning, false);
});

test("the model store TTL is the refresh gate, not an absolute clock", () => {
	assert.equal(storeIsFresh(Date.now() - 60_000), true);
	assert.equal(storeIsFresh(Date.now() - 5 * 60 * 60 * 1000), false);
});

test("the extension loads and registers a provider with no remembered lineup", async () => {
	// The real entry point, imported and executed — not a textual review. Node's
	// native TypeScript stripping runs index.ts directly, and the sibling .mjs
	// modules are plain ESM, so this exercises the shipped module graph.
	const previousKey = process.env.CLINE_API_KEY;
	delete process.env.CLINE_API_KEY;
	try {
		// A computed specifier on purpose: a literal ".ts" path would pull this
		// file into the tsc program, where pi's host-provided imports report as
		// missing modules. Running it is the check that matters.
		const entrySpecifier = "../index.ts";
		const entry = await import(entrySpecifier);
		/** @type {{id: string, config: any}[]} */
		const registered = [];
		entry.default({
			registerProvider: (/** @type {string} */ id, /** @type {any} */ config) =>
				registered.push({ id, config }),
		});
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
		assert.equal(id, CLINE_PASS_PROVIDER_ID);
		assert.equal(config.baseUrl, clinePass.baseUrl);
		assert.equal(config.api, "openai-completions");
		assert.equal(config.apiKey, `$${clinePass.apiKeyEnv}`);
		assert.equal(config.authHeader, true);
		assert.equal(typeof config.refreshModels, "function");
		// Nothing remembered and no network wanted: nothing to offer, rather
		// than a list the provider may already have retired.
		assert.equal(
			await config.refreshModels({ allowNetwork: false }),
			undefined,
		);
	} finally {
		if (previousKey === undefined) {
			delete process.env.CLINE_API_KEY;
		} else {
			process.env.CLINE_API_KEY = previousKey;
		}
	}
});
