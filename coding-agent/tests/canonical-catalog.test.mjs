/**
 * @fileoverview canonical-catalog.test.mjs — the ordering rule the fetched
 * models.dev payload goes through before it is written into a run's output dir
 * (coding-agent/refresh-models-dev.mjs, docs/d191): provider keys ascend, each
 * provider's `models` collection is canonical, and nothing is wrapped.
 *
 * A layer's model order follows the catalog's order, so this is what keeps two
 * runs against the same upstream facts producing the same artifact (docs/d050)
 * even though models.dev emits its own iteration order per fetch.
 *
 * No network, no repo writes.
 *
 * Run: ../node-run.sh --test tests/*.test.mjs   (this folder)
 */
import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeProviderCatalog } from "../lib/canonical-json.mjs";

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
