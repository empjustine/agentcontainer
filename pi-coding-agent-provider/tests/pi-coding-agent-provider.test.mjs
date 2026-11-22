/**
 * @fileoverview pi-coding-agent-provider.test.mjs — pins the one contract this
 * extension has: a provider is registered only when its key env is present and
 * its base-URL override is set, and the config carries only that URL.
 *
 * The expected env names are literals from this folder's own copy of the fact
 * table (docs/d113/d118), so a renamed key env fails here and in the generator.
 * Each registration loads a fresh copy of the entry, which also pins that a
 * reload reads the environment as it stands. No network: no fetch left to stub.
 */

import assert from "node:assert/strict";
import test from "node:test";

/** @type {Readonly<Record<string, string>>} */
const FACT_ROWS = Object.freeze({
	mistral: "MISTRAL_API_KEY",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
});

const KEYS = Object.freeze([
	"MISTRAL_API_KEY",
	"OPENCODE_API_KEY",
	"OPENROUTER_API_KEY",
]);
const OVERRIDES = Object.freeze([
	"MISTRAL_BASE_URL",
	"OPENCODE_BASE_URL",
	"OPENROUTER_BASE_URL",
]);
const cleanEnv = Object.fromEntries(
	[...KEYS, ...OVERRIDES].map((name) => [name, undefined]),
);
const keyed = Object.fromEntries(KEYS.map((name) => [name, "dummy-key"]));

let caseNumber = 0;

/**
 * Run with only the given env vars set, then restore the process environment.
 * @param {Record<string, string|undefined>} values
 * @param {() => Promise<void>} fn
 */
async function withEnv(values, fn) {
	/** @type {[string, string|undefined][]} */
	const previous = Object.keys(values).map((key) => [key, process.env[key]]);
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

/**
 * Load a fresh copy of the entry against a capturing registerProvider. The
 * query makes each case a distinct module, so the env for that case is read at
 * load time.
 * @returns {Promise<Record<string, Record<string, unknown>>>}
 */
async function registrations() {
	const id = ++caseNumber;
	const { default: extension } = await import(`../index.mjs?case=${id}`);
	/** @type {Record<string, Record<string, unknown>>} */
	const configs = {};
	/** @type {{ registerProvider: (name: string, config: Record<string, unknown>) => void }} */
	const pi = {
		registerProvider(name, config) {
			configs[name] = /** @type {Record<string, unknown>} */ (config);
		},
	};
	extension(/** @type {import("@earendil-works/pi-coding-agent").ExtensionAPI} */ (
		/** @type {unknown} */ (pi)
	));
	return configs;
}

test("no override registers nothing", async () => {
	await withEnv(cleanEnv, async () => {
		assert.deepEqual(await registrations(), {});
	});
});

test("a keyed provider with an override registers only baseUrl", async () => {
	await withEnv(
		{ ...cleanEnv, ...keyed, OPENCODE_BASE_URL: "https://gateway.example/zen/v1///" },
		async () => {
			assert.deepEqual(await registrations(), {
				opencode: { baseUrl: "https://gateway.example/zen/v1" },
				"opencode-go": { baseUrl: "https://gateway.example/zen/v1" },
			});
		},
	);
});

test("a provider without a key is not registered", async () => {
	await withEnv(
		{ ...cleanEnv, MISTRAL_BASE_URL: "https://gateway.example/v1" },
		async () => {
			assert.deepEqual(await registrations(), {});
		},
	);
});

test("every override name follows its key env", async () => {
	const values = Object.fromEntries(
		OVERRIDES.map((name) => [name, `https://${name.toLowerCase()}.example/v1`]),
	);
	await withEnv({ ...cleanEnv, ...keyed, ...values }, async () => {
		const configs = await registrations();
		assert.deepEqual(Object.keys(configs).sort(), Object.keys(FACT_ROWS).sort());
		for (const [id, keyEnv] of Object.entries(FACT_ROWS)) {
			const name = `${keyEnv.slice(0, -"_API_KEY".length)}_BASE_URL`;
			assert.ok(OVERRIDES.includes(name));
			assert.deepEqual(configs[id], {
				baseUrl: `https://${name.toLowerCase()}.example/v1`,
			});
		}
	});
});

test("a reload reads the environment as it stands", async () => {
	await withEnv(
		{ ...cleanEnv, ...keyed, MISTRAL_BASE_URL: "https://one.example/v1" },
		async () => {
			assert.deepEqual((await registrations()).mistral, {
				baseUrl: "https://one.example/v1",
			});
		},
	);
	await withEnv(
		{ ...cleanEnv, ...keyed, MISTRAL_BASE_URL: "https://two.example/v1" },
		async () => {
			assert.deepEqual((await registrations()).mistral, {
				baseUrl: "https://two.example/v1",
			});
		},
	);
});

test("a malformed override throws at load", async () => {
	await withEnv(
		{ ...cleanEnv, ...keyed, MISTRAL_BASE_URL: "not-a-url" },
		async () => {
			await assert.rejects(
				registrations(),
				/base URL is not an absolute http\(s\) URL/,
			);
		},
	);
});
