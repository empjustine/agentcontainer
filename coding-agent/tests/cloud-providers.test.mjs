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
	baseUrlEnvName,
	factHosts,
	parseCloudProviders,
	providerBaseUrl,
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
	const table = /** @type {any} */ (parseCloudProviders(JSON.stringify(ROWS)));
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

test("the base-url env name derives from the key env (Azure shape)", () => {
	assert.equal(baseUrlEnvName("OPENROUTER_API_KEY"), "OPENROUTER_BASE_URL");
	assert.equal(baseUrlEnvName("AZURE_OPENAI_API_KEY"), "AZURE_OPENAI_BASE_URL");
	assert.equal(baseUrlEnvName("TLALOCAYOTL_API_KEY"), "TLALOCAYOTL_BASE_URL");
	// No `_API_KEY` suffix: no guessed name, because a wrong guess retargets a
	// provider.
	assert.equal(baseUrlEnvName("OPENROUTER_KEY"), null);
	assert.equal(baseUrlEnvName("X_API_KEY_EXTRA"), null);
});

test("providerBaseUrl prefers a valid override and trims it", () => {
	const table = parseCloudProviders(JSON.stringify(ROWS));
	const alpha = providerFacts(table, "alpha");
	assert.equal(providerBaseUrl(alpha, {}), "https://alpha.example/v1");
	assert.equal(providerBaseUrl(alpha, { ALPHA_BASE_URL: "  " }), "https://alpha.example/v1");
	assert.equal(
		providerBaseUrl(alpha, { ALPHA_BASE_URL: "https://alt.example/v1/" }),
		"https://alt.example/v1",
	);
});

test("a malformed override refuses instead of falling back", () => {
	const table = parseCloudProviders(JSON.stringify(ROWS));
	const alpha = providerFacts(table, "alpha");
	assert.throws(
		() => providerBaseUrl(alpha, { ALPHA_BASE_URL: "ftp://alt.example/v1" }),
		/ALPHA_BASE_URL is not an absolute http\(s\) URL/,
	);
	assert.throws(
		() => providerBaseUrl(alpha, { ALPHA_BASE_URL: "not a url" }),
		/absolute http\(s\) URL/,
	);
});

test("factHosts is the table's own host set", () => {
	const table = parseCloudProviders(JSON.stringify(ROWS));
	assert.deepEqual(
		[...factHosts(table)].sort(),
		["alpha.example", "beta.example"],
	);
});
