/**
 * @fileoverview cloud-providers.test.mjs — the fact table is a VALUE, so these
 * facts are checkable without a checkout of the real table: parsing validates
 * and freezes rows, a missing row refuses loudly, and the host set derives from
 * whatever table the caller passes (docs/d024, d070). The module reads no file
 * of its own — that is the property this file exists to hold.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	factHosts,
	parseCloudProviders,
	providerFacts,
} from "../lib/cloud-providers.mjs";

const ROWS = [
	{
		id: "alpha",
		label: "Alpha",
		apiKeyEnv: "ALPHA_API_KEY",
		baseUrl: "https://alpha.example/v1",
		support: "first-class",
	},
	{
		id: "beta",
		label: "Beta",
		apiKeyEnv: "BETA_API_KEY",
		baseUrl: "https://beta.example/sub",
		support: "superficial",
	},
];

test("parses and freezes rows, keyed by id", () => {
	const table = parseCloudProviders(JSON.stringify(ROWS));
	assert.deepEqual(Object.keys(table), ["alpha", "beta"]);
	assert.equal(Object.isFrozen(table), true);
	assert.equal(Object.isFrozen(table.alpha), true);
	assert.equal(table.beta.baseUrl, "https://beta.example/sub");
});

test("a malformed row refuses the whole table", () => {
	assert.throws(
		() => parseCloudProviders(JSON.stringify([{ ...ROWS[0], support: "nope" }])),
		/unknown support tier/,
	);
	assert.throws(
		() => parseCloudProviders(JSON.stringify([{ ...ROWS[0], baseUrl: 7 }])),
		/baseUrl/,
	);
	assert.throws(() => parseCloudProviders('{"alpha": {}}'), /JSON array/);
});

test("providerFacts answers from the table it was given", () => {
	const table = parseCloudProviders(JSON.stringify(ROWS));
	assert.equal(providerFacts(table, "alpha").label, "Alpha");
	assert.throws(() => providerFacts(table, "gamma"), /lost the gamma row/);
});

test("factHosts is the table's own host set", () => {
	const table = parseCloudProviders(JSON.stringify(ROWS));
	assert.deepEqual(
		[...factHosts(table)].sort(),
		["alpha.example", "beta.example"],
	);
});
