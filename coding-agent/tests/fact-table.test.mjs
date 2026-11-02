/**
 * @fileoverview fact-table.test.mjs — the docs/d086 churn recipe
 * (lib/fact-table.mjs) and the ordering rules it depends on
 * (lib/canonical-json.mjs): canonical form, hash short-circuit, `_meta`
 * provenance.
 *
 * The committed-cache guard at the bottom is the recipe's verification teeth:
 * a cache whose bytes are not exactly what a refresh would write means
 * someone bypassed the publisher (or hand-edited records without refreshing),
 * and it names the file instead of leaving the next reviewer to spot an
 * ordering churn in a 27k-line diff. Same idea as the d050 committed-manifest
 * guard in canonical-json.test.mjs, for the fact tables.
 *
 * Everything runs on plain records in temp dirs — no network, no repo writes.
 *
 * Run: . ./lib/node-run.sh && node_run --test tests/*.test.mjs   (this folder)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	canonicalizeFactsCache,
	canonicalizeProviderCatalog,
} from "../lib/canonical-json.mjs";
import {
	publishFactCache,
	publishProviderMirror,
} from "../lib/fact-table.mjs";

const unitRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(join(tmpdir(), "fact-table-"));
let caseNo = 0;

/** A fresh path per case, so no test can read another's leftovers. */
const tempPath = (/** @type {string} */ name) =>
	join(workDir, `${caseNo++}-${name}`);

/** @type {Record<string, {listKey: string, regen: string}>} */
const PROVENANCE = {
	catwalk: {
		listKey: "providers",
		regen: "node coding-agent/catalog-facts.mjs catwalk",
	},
	hyper: { listKey: "models", regen: "node coding-agent/generate-pi-coding-agent.mjs" },
	verboo: {
		listKey: "models",
		regen: "node coding-agent/generate-pi-coding-agent.mjs",
	},
};

/**
 * The provenance the real refresh passes, per cache source; mirrors
 * coding-agent/catalog-facts.mjs so the committed-cache guard asks exactly
 * what a refresh would ask.
 * @param {string} source cache source ID
 * @param {unknown[]} records
 * @returns {import("../lib/fact-table.mjs").FactCacheProvenance}
 */
function publisherFor(source, records) {
	const provenance = PROVENANCE[source];
	assert.ok(provenance, `unknown cache source in this test: ${source}`);
	return {
		source,
		listKey: provenance.listKey,
		records,
		generator: "coding-agent/catalog-facts.mjs",
		regen: provenance.regen,
	};
}

/**
 * The record-list member a source's cache holds.
 * @param {string} source
 * @returns {string}
 */
function listKeyOf(source) {
	const provenance = PROVENANCE[source];
	assert.ok(provenance, `unknown cache source in this test: ${source}`);
	return provenance.listKey;
}

test("provider catalog: document keys and each provider's models sort", () => {
	const catalog = {
		zeta: { name: "Z", models: { "m-b": { id: "m-b" }, "m-a": { id: "m-a" } } },
		Alpha: { models: {} },
	};
	const out = /** @type {any} */ (canonicalizeProviderCatalog(catalog));
	assert.deepEqual(Object.keys(out), ["Alpha", "zeta"]);
	assert.deepEqual(Object.keys(out.zeta.models), ["m-a", "m-b"]);
	// the vendor document IS the provider map: no wrapper, no added member
	assert.deepEqual(Object.keys(out), Object.keys(catalog).sort());
	assert.deepEqual(Object.keys(catalog), ["zeta", "Alpha"], "input untouched");
});

test("provider catalog: semantically ordered arrays stay as sent", () => {
	const catalog = {
		p: { models: { m: { modalities: { input: ["text", "image"] } } } },
	};
	const out = /** @type {any} */ (canonicalizeProviderCatalog(catalog));
	assert.deepEqual(out.p.models.m.modalities.input, ["text", "image"]);
});

test("facts cache: record list sorts by id, each record's models canonical", () => {
	const doc = {
		_meta: { schema: "fact-cache/1" },
		fetchedAt: "2026-01-01T00:00:00.000Z",
		providers: [
			{ id: "zulu", models: [{ id: "m2" }, { id: "m1" }] },
			{ id: "alpha", models: [] },
		],
	};
	const out = /** @type {any} */ (canonicalizeFactsCache(doc, "providers"));
	assert.deepEqual(
		out.providers.map((/** @type {{id: string}} */ p) => p.id),
		["alpha", "zulu"],
	);
	assert.deepEqual(
		out.providers[1].models.map((/** @type {{id: string}} */ m) => m.id),
		["m1", "m2"],
	);
	// provenance and anything provider-specific is carried through as given
	assert.deepEqual(out._meta, { schema: "fact-cache/1" });
	assert.equal(out.fetchedAt, "2026-01-01T00:00:00.000Z");
	assert.deepEqual(
		doc.providers.map((p) => p.id),
		["zulu", "alpha"],
		"input untouched",
	);
});

test("first publish writes _meta first, with URL-free provenance", () => {
	const path = tempPath("first.json");
	const result = publishFactCache(
		path,
		publisherFor("catwalk", [{ id: "b" }, { id: "a" }]),
	);
	assert.equal(result.changed, true);
	assert.equal(result.written, true);

	const doc = JSON.parse(readFileSync(path, "utf-8"));
	assert.deepEqual(Object.keys(doc).slice(0, 2), ["_meta", "fetchedAt"]);
	assert.deepEqual(Object.keys(doc._meta), [
		"schema",
		"source",
		"contentSha256",
		"generator",
		"regen",
		"decision",
	]);
	assert.equal(doc._meta.schema, "fact-cache/1");
	assert.equal(doc._meta.source, "catwalk");
	assert.equal(doc._meta.decision, "docs/d086");
	assert.equal(doc._meta.contentSha256, result.contentSha256);
	assert.equal(doc.fetchedAt, result.fetchedAt);
	// d086/d070: the funnel mount is the mode A credential — no URL, ever
	for (const value of Object.values(doc._meta)) {
		assert.ok(
			!String(value).includes("http"),
			`_meta entry carries a URL: ${value}`,
		);
	}
});

test("same facts in a different arrival order: no write, timestamp kept", () => {
	const path = tempPath("stable.json");
	const records = [
		{ id: "zulu", models: [{ id: "m2" }, { id: "m1" }] },
		{ id: "alpha", models: [] },
	];
	const first = publishFactCache(path, publisherFor("catwalk", records));
	const before = readFileSync(path, "utf-8");

	const second = publishFactCache(
		path,
		publisherFor("catwalk", [
			{ id: "alpha", models: [] },
			{ id: "zulu", models: [{ id: "m1" }, { id: "m2" }] },
		]),
	);
	assert.equal(second.changed, false);
	assert.equal(second.written, false, "an unchanged refresh must not touch the file");
	assert.equal(second.contentSha256, first.contentSha256);
	assert.equal(second.fetchedAt, first.fetchedAt);
	assert.equal(readFileSync(path, "utf-8"), before);
});

test("moved facts rewrite the cache and advance fetchedAt", () => {
	const path = tempPath("moved.json");
	const first = publishFactCache(
		path,
		publisherFor("catwalk", [{ id: "a", models: [{ id: "m1" }] }]),
	);
	const second = publishFactCache(
		path,
		publisherFor("catwalk", [{ id: "a", models: [{ id: "m2" }] }]),
	);
	assert.equal(second.changed, true);
	assert.equal(second.written, true);
	assert.notEqual(second.contentSha256, first.contentSha256);
	const doc = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(doc._meta.contentSha256, second.contentSha256);
});

test("pre-_meta cache adopts the shape without claiming a data change", () => {
	const path = tempPath("legacy.json");
	const legacy = {
		fetchedAt: "2025-06-01T12:00:00.000Z",
		models: [{ id: "m1" }, { id: "m2" }],
	};
	writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");

	const result = publishFactCache(
		path,
		publisherFor("hyper", [{ id: "m2" }, { id: "m1" }]),
	);
	assert.equal(result.changed, false, "reordering the same facts is not a data change");
	assert.equal(result.written, true, "the shape migration still has to land");
	assert.equal(result.fetchedAt, "2025-06-01T12:00:00.000Z");
	assert.equal(
		JSON.parse(readFileSync(path, "utf-8"))._meta.source,
		"hyper",
	);
});

test("mirror: canonical, tab-indented, no _meta, not rewritten when identical", () => {
	const path = tempPath("mirror.json");
	const catalog = {
		zeta: { models: { b: {}, a: {} } },
		alpha: { models: {} },
	};
	const first = publishProviderMirror(path, catalog);
	assert.equal(first.written, true);

	const text = readFileSync(path, "utf-8");
	assert.ok(text.endsWith("}\n"));
	assert.ok(text.includes('\n\t"alpha"'), "mirror keeps its tab indentation");
	const doc = JSON.parse(text);
	assert.deepEqual(Object.keys(doc), ["alpha", "zeta"]);
	assert.deepEqual(Object.keys(doc.zeta.models), ["a", "b"]);
	assert.equal(doc._meta, undefined, "the raw mirror carries no _meta block");

	const second = publishProviderMirror(path, {
		alpha: { models: {} },
		zeta: { models: { a: {}, b: {} } },
	});
	assert.equal(second.written, false);
	assert.equal(second.contentSha256, first.contentSha256);
	assert.equal(readFileSync(path, "utf-8"), text);
});

// --- committed-cache canonicity guard (docs/d086) ---------------------------
// A cache that is not byte-identical to what a refresh would write means the
// write path was bypassed or records were hand-edited: the fix is to rerun
// the recorded `_meta.regen` command, never to reformat by hand.
const COMMITTED_CACHES = [
	{ path: "lib/catwalk-facts.json", source: "catwalk" },
	{ path: "hyper-facts.json", source: "hyper" },
	{ path: "verboo-facts.json", source: "verboo" },
];

for (const { path: rel, source } of COMMITTED_CACHES) {
	test(`committed cache is canonical: ${rel}`, () => {
		const text = readFileSync(join(unitRoot, rel), "utf-8");
		const doc = JSON.parse(text);
		assert.equal(doc._meta?.decision, "docs/d086", `${rel} has no d086 provenance`);
		const copy = tempPath("committed.json");
		writeFileSync(copy, text, "utf-8");

		const result = publishFactCache(
			copy,
			publisherFor(source, doc[listKeyOf(source)]),
		);		assert.equal(
			result.written,
			false,
			`${rel} is not what a refresh would write — rerun \`${doc._meta?.regen}\` (docs/d086)`,
		);
		assert.equal(
			doc._meta.contentSha256,
			result.contentSha256,
			`${rel} records do not match its recorded contentSha256`,
		);
	});
}

test("committed mirror is canonical: lib/models.dev.api.json", () => {
	const rel = "lib/models.dev.api.json";
	const text = readFileSync(join(unitRoot, rel), "utf-8");
	const copy = tempPath("committed-mirror.json");
	writeFileSync(copy, text, "utf-8");
	const result = publishProviderMirror(copy, JSON.parse(text));
	assert.equal(
		result.written,
		false,
		`${rel} is not in canonical order — rerun coding-agent/refresh-models-dev.mjs (docs/d086)`,
	);
});
