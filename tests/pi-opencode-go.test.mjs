/**
 * tests/pi-opencode-go.test.mjs — pins the pi-opencode-go folder's rules
 * (docs/d097):
 *
 *   1. NO model data of its own. opencode-go is built into pi-coding-agent,
 *      so the folder carries no committed catalog, no seed, no generator —
 *      a "backup" copy could only be staler than the host's own data, and
 *      pi's composer REPLACES the whole provider catalog when an extension
 *      returns a model list.
 *   2. The extension is a catalog freshness watchdog: a failed listing fetch
 *      THROWS (pi's refresh pipeline turns that into the "Could not refresh
 *      opencode-go; showing cached models." warning) and every other path
 *      returns undefined, leaving pi's built-in catalog in place.
 *
 * No network: every fetch is injected via globalThis.fetch.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test, { after, before, describe } from "node:test";

import { CLOUD_PROVIDERS } from "../lib/cloud-providers.mjs";

// A computed specifier on purpose: a literal ".ts" path would pull the
// extension entry into the tsc program, where pi's host-provided imports
// report as missing modules — the very reason tsconfig.json leaves the
// entry out. Importing and running it is the check that matters (same
// idiom as the sibling suites).
const entrySpecifier = "../pi-opencode-go/index.ts";
const { OPENCODE_GO_LISTING_URL, OPENCODE_GO_PROVIDER_ID } = await import(
	entrySpecifier
);

const OPENCODE_GO = CLOUD_PROVIDERS["opencode-go"];
const FOLDER = new URL("../pi-opencode-go/", import.meta.url);

/**
 * Swap one env var for the duration of one test.
 * @param {string} name
 * @param {string | undefined} value
 * @param {() => void | Promise<void>} fn
 */
function withEnv(name, value, fn) {
	const previousKey = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return fn();
	} finally {
		if (previousKey === undefined) delete process.env[name];
		else process.env[name] = previousKey;
	}
}

/**
 * Load the extension against a capturing registerProvider.
 * @returns {Promise<{ config: any, registeredIds: string[] }>}
 */
async function loadExtension() {
	const module = await import(entrySpecifier);
	/** @type {string[]} */
	const registeredIds = [];
	/** @type {any} */
	let config;
	module.default({
		registerProvider(/** @type {string} */ id, /** @type {any} */ providerConfig) {
			registeredIds.push(id);
			config = providerConfig;
		},
	});
	return { config, registeredIds };
}

describe("the built-in-provider rule (docs/d097)", () => {
	test("the folder carries no committed model data", () => {
		const entries = readdirSync(FOLDER);
		for (const retired of [
			"models.json",
			"models.js",
			"sources.mjs",
			"merge.mjs",
			"generate.mjs",
			"generate.sh",
		]) {
			assert.ok(
				!entries.includes(retired),
				`${retired} is a model-data copy — pi builds this provider in`,
			);
		}
		assert.ok(entries.includes("index.ts"));
		assert.ok(entries.includes("package.json"));
	});

	test("registers ONLY refreshModels — nothing to replace", async () => {
		const { config, registeredIds } = await loadExtension();
		assert.deepEqual(registeredIds, [OPENCODE_GO_PROVIDER_ID]);
		assert.deepEqual(Object.keys(config), ["refreshModels"]);
		for (const field of [
			"models",
			"api",
			"baseUrl",
			"apiKey",
			"authHeader",
			"headers",
		]) {
			assert.ok(!(field in config), `${field} would override pi's built-in`);
		}
	});
});

describe("fact-table parity (lib/cloud-providers.mjs)", () => {
	test("provider id and listing URL come from the fact table only", () => {
		assert.equal(OPENCODE_GO_PROVIDER_ID, OPENCODE_GO.id);
		assert.equal(OPENCODE_GO_LISTING_URL, `${OPENCODE_GO.baseUrl}/models`);
	});
});

describe("the catalog freshness watchdog", () => {
	const realFetch = globalThis.fetch;
	/** @type {any} */
	let config;

	before(async () => {
		({ config } = await loadExtension());
	});

	after(() => {
		globalThis.fetch = realFetch;
	});

	/**
	 * Count fetch attempts and answer with the given payload shape.
	 * @param {() => unknown} answer
	 * @returns {{ url: unknown, init: any }[]}
	 */
	function stubFetch(answer) {
		/** @type {{ url: unknown, init: any }[]} */
		const calls = [];
		globalThis.fetch = /** @type {typeof fetch} */ (
			/** @type {unknown} */ (
				async (/** @type {unknown} */ url, /** @type {any} */ init) => {
					calls.push({ url, init });
					return answer();
				}
			)
		);
		return calls;
	}

	test("healthy listing: undefined, no catalog replacement", async () => {
		const calls = stubFetch(() => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [{ id: "glm-5.2" }] }),
		}));
		const result = await config.refreshModels({ allowNetwork: true, force: true });
		assert.equal(result, undefined, "a list would REPLACE the built-in catalog");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, OPENCODE_GO_LISTING_URL);
	});

	test("sends the key when the env holds one, never logging it", async () => {
		const calls = stubFetch(() => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [{ id: "glm-5.2" }] }),
		}));
		await withEnv("OPENCODE_API_KEY", "sk-test-key", async () => {
			await config.refreshModels({ allowNetwork: true, force: true });
		});
		assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-key");
	});

	for (const [label, answer] of /** @type {[string, () => unknown][]} */ ([
		[
			"a non-2xx answer",
			() => ({ ok: false, status: 503, json: async () => ({}) }),
		],
		[
			"an unrecognizable payload",
			() => ({ ok: true, status: 200, json: async () => ({ html: "hello" }) }),
		],
		[
			"a payload with no usable rows",
			() => ({ ok: true, status: 200, json: async () => ({ data: [{}] }) }),
		],
	])) {
		test(`failure (${label}): throws the catalog warning`, async () => {
			stubFetch(answer);
			await assert.rejects(
				() => config.refreshModels({ allowNetwork: true, force: true }),
				(/** @type {any} */ err) => {
					assert.ok(err.message.includes(OPENCODE_GO_PROVIDER_ID));
					assert.ok(err.message.includes("keeping pi's built-in catalog"));
					return true;
				},
			);
		});
	}

	test("offline init (allowNetwork=false) stays silent", async () => {
		const calls = stubFetch(() => {
			throw new Error("must not fetch");
		});
		const result = await config.refreshModels({ allowNetwork: false });
		assert.equal(result, undefined);
		assert.equal(calls.length, 0);
	});

	test("one warning per interval: TTL gates, force bypasses", async () => {
		let calls = 0;
		globalThis.fetch = /** @type {typeof fetch} */ (
			/** @type {unknown} */ (
				async () => {
					calls++;
					throw new Error("offline");
				}
			)
		);
		const forced = () =>
			config.refreshModels({ allowNetwork: true, force: true });
		await assert.rejects(forced);
		const afterFirst = calls;
		// within the interval: silent, no second attempt, no second warning
		await assert.doesNotReject(() =>
			config.refreshModels({ allowNetwork: true }),
		);
		assert.equal(calls, afterFirst);
		// force bypasses the interval
		await assert.rejects(forced);
		assert.equal(calls, afterFirst + 1);
	});

	test("an abort is rethrown untouched, never wrapped", async () => {
		const controller = new AbortController();
		stubFetch(() => {
			controller.abort();
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		});
		await assert.rejects(
			() =>
				config.refreshModels({
					allowNetwork: true,
					force: true,
					signal: controller.signal,
				}),
			(/** @type {any} */ err) => err.name === "AbortError",
		);
	});
});
