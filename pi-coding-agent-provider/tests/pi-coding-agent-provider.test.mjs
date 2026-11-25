/**
 * @fileoverview pi-coding-agent-provider.test.mjs — pins the one contract this
 * extension has: a provider is registered only when its key env is present and
 * its base-URL override is valid, and the config carries only that URL. Bad
 * overrides are reported through pi's UI without stopping other providers.
 *
 * The expected env names are literals from this folder's own copy of the fact
 * table (docs/d113/d118), so a renamed key env fails here and in the generator.
 * Each load uses a fresh copy of the entry, which also pins that a reload reads
 * the environment as it stands. No network: no fetch left to stub.
 */

import assert from "node:assert/strict";
import test from "node:test";

/** @type {Readonly<Record<string, string>>} */
const FACT_ROWS = Object.freeze({
	google: "GEMINI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	nvidia: "NVIDIA_API_KEY",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
});

const KEYS = Object.freeze([
	"GEMINI_API_KEY",
	"MISTRAL_API_KEY",
	"NVIDIA_API_KEY",
	"OPENCODE_API_KEY",
	"OPENROUTER_API_KEY",
]);
const OVERRIDES = Object.freeze([
	"GEMINI_BASE_URL",
	"MISTRAL_BASE_URL",
	"NVIDIA_BASE_URL",
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
 * Load a fresh copy of the entry against capturing registerProvider and notify.
 * @param {boolean} [hasUI]
 * @returns {Promise<{ configs: Record<string, Record<string, unknown>>, notifications: Array<{ message: string, type: string|undefined }> }>}
 */
async function load(hasUI = true) {
	const id = ++caseNumber;
	const { default: extension } = await import(`../index.mjs?case=${id}`);
	/** @type {Record<string, Record<string, unknown>>} */
	const configs = {};
	/** @type {Array<{ message: string, type: string|undefined }>} */
	const notifications = [];
	/** @type {Record<string, (event: unknown, ctx: unknown) => void>} */
	const handlers = {};
	/** @type {{ registerProvider: (name: string, config: Record<string, unknown>) => void, on: (event: string, handler: (event: unknown, ctx: unknown) => void) => void }} */
	const pi = {
		registerProvider(name, config) {
			configs[name] = /** @type {Record<string, unknown>} */ (config);
		},
		on(event, handler) {
			handlers[event] = handler;
		},
	};
	extension(/** @type {import("@earendil-works/pi-coding-agent").ExtensionAPI} */ (
		/** @type {unknown} */ (pi)
	));
	const start = handlers.session_start;
	if (start) {
		start({ type: "session_start", reason: "reload" }, {
			hasUI,
			ui: {
				/** @param {string} message @param {"info"|"warning"|"error"|undefined} type */
				notify(message, type) {
					notifications.push({ message, type });
				},
			},
		});
	}
	return { configs, notifications };
}

test("no override registers nothing", async () => {
	await withEnv(cleanEnv, async () => {
		const { configs, notifications } = await load();
		assert.deepEqual(configs, {});
		assert.deepEqual(notifications, []);
	});
});

test("a keyed provider with an override registers only baseUrl", async () => {
	await withEnv(
		{ ...cleanEnv, ...keyed, OPENCODE_BASE_URL: "https://gateway.example/zen/v1///" },
		async () => {
			const { configs } = await load();
			assert.deepEqual(configs, {
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
			assert.deepEqual((await load()).configs, {});
		},
	);
});

test("every override name follows its key env", async () => {
	const values = Object.fromEntries(
		OVERRIDES.map((name) => [name, `https://${name.toLowerCase()}.example/v1`]),
	);
	await withEnv({ ...cleanEnv, ...keyed, ...values }, async () => {
		const { configs } = await load();
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
			assert.deepEqual((await load()).configs.mistral, {
				baseUrl: "https://one.example/v1",
			});
		},
	);
	await withEnv(
		{ ...cleanEnv, ...keyed, MISTRAL_BASE_URL: "https://two.example/v1" },
		async () => {
			assert.deepEqual((await load()).configs.mistral, {
				baseUrl: "https://two.example/v1",
			});
		},
	);
});

test("no UI reports nothing", async () => {
	await withEnv(
		{ ...cleanEnv, ...keyed, MISTRAL_BASE_URL: "not-a-url" },
		async () => {
			const { configs, notifications } = await load(false);
			assert.deepEqual(configs, {});
			assert.deepEqual(notifications, []);
		},
	);
});

test("malformed overrides notify once and do not stop the others", async () => {
	await withEnv(
		{
			...cleanEnv,
			...keyed,
			MISTRAL_BASE_URL: "not-a-url",
			OPENROUTER_BASE_URL: "ftp://gateway.example",
			OPENCODE_BASE_URL: "https://gateway.example/zen/v1",
		},
		async () => {
			const { configs, notifications } = await load();
			assert.deepEqual(configs, {
				opencode: { baseUrl: "https://gateway.example/zen/v1" },
				"opencode-go": { baseUrl: "https://gateway.example/zen/v1" },
			});
			assert.equal(notifications.length, 1);
			assert.equal(notifications[0]?.type, "error");
			const message = notifications[0]?.message ?? "";
			assert.match(message, /invalid provider base-URL overrides/);
			assert.match(message, /mistral: base URL is not an absolute http/);
			assert.match(message, /openrouter: base URL is not an absolute http/);
		},
	);
});
