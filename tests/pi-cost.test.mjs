/**
 * @fileoverview pi-cost.test.mjs — pi's "a price is complete or absent"
 * contract (pi's ModelCost schema: `cost` is optional, but present ⇒ all four
 * of input/output/cacheRead/cacheWrite; docs/d057: prices are absent, not
 * zero). Two halves: the projection rule itself (piCost, as piModel applies
 * it to llama-swap metadata) and the committed artifacts it must keep clean —
 * an empty `cost: {}` block reached the installed models.json once and pi
 * dropped the WHOLE file for it, local lineup and all.
 *
 * Run: node --test   (discovers tests/*.test.mjs from the repo root)
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { piCost, piModel } from "../coding-agent/gen-lib.mjs";

const CODING_AGENT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"coding-agent",
);

/** @type {readonly string[]} */
const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

test("no price publishes no block (empty, all-zero and absent are all 'no price')", () => {
	assert.equal(piCost(undefined), undefined);
	assert.equal(piCost({}), undefined);
	// A free local GGUF priced at nothing is published the same way as an
	// unpublished one — pi zeroes the cost itself.
	assert.equal(
		piCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		undefined,
	);
	assert.equal(piCost({ input: 0 }), undefined);
});

test("a partial block is completed, never published as-is", () => {
	// pi's schema requires all four fields whenever the key is present, so a
	// block carrying only some prices is completed with zeros — not dropped
	// (the model IS priced) and not forwarded half-built.
	assert.deepEqual(piCost({ input: 3 }), {
		input: 3,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
	assert.deepEqual(
		piCost({ input: 10, output: 50, cacheRead: 1, cacheWrite: 20 }),
		{ input: 10, output: 50, cacheRead: 1, cacheWrite: 20 },
	);
});

test("piModel judges the served block instead of copying it", () => {
	// llama-swap mirrors its config metadata verbatim — this is the shape
	// that reached the artifact untouched and invalidated it.
	const unpriced = piModel({
		id: "01b-ctx128-org/repo-GGUF:Q8_0",
		meta: { llamaswap: { cost: {} } },
	});
	assert.equal("cost" in unpriced, false);

	const free = piModel({
		id: "01b-ctx128-org/repo-GGUF:Q8_0",
		meta: {
			llamaswap: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		},
	});
	assert.equal("cost" in free, false);

	const priced = piModel({
		id: "01b-ctx128-org/repo-GGUF:Q8_0",
		meta: { llamaswap: { cost: { input: 0.5 } } },
	});
	assert.deepEqual(priced.cost, {
		input: 0.5,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});

	// No metadata at all: same answer as "no price" — the key is absent,
	// never null.
	assert.equal("cost" in piModel({ id: "org/repo-GGUF:Q8_0" }), false);
});

/**
 * A committed cost block is publishable exactly when it is complete (all four
 * prices numeric — pi's ModelCost `required`) AND carries a price.
 * @param {Record<string, unknown>} cost
 * @returns {boolean}
 */
function isPublishable(cost) {
	const prices = PRICE_FIELDS.map((field) => cost[field]);
	if (!prices.every((price) => typeof price === "number")) {
		return false;
	}
	return prices.some((price) => Number(price) !== 0);
}

test("committed artifacts carry no unpriced or incomplete cost block", () => {
	const artifacts = [
		join(CODING_AGENT_DIR, "models.json"),
		...readdirSync(CODING_AGENT_DIR)
			.filter((name) => /^model-.*\.json$/.test(name))
			.map((name) => join(CODING_AGENT_DIR, name)),
	];
	/** @type {string[]} */
	const violations = [];
	for (const path of artifacts) {
		for (const model of modelsOf(path)) {
			if (!("cost" in model) || model.cost === undefined) {
				continue;
			}
			if (!isPublishable(model.cost)) {
				violations.push(
					`${basename(path)} ${model.id}: ${JSON.stringify(model.cost)}`,
				);
			}
		}
	}
	assert.deepEqual(violations, []);
});

/**
 * The `providers.*.models[]` entries of one committed pi artifact (the
 * model-*.json layers plus their models.json merge).
 * @param {string} path
 * @returns {Array<{ id?: string, cost?: Record<string, unknown> }>}
 */
function modelsOf(path) {
	const doc =
		/** @type {{ providers?: Record<string, { models?: unknown }> }} */ (
			JSON.parse(readFileSync(path, "utf-8"))
		);
	const models = /** @type {unknown[]} */ ([]);
	for (const provider of Object.values(doc.providers ?? {})) {
		if (Array.isArray(provider.models)) {
			models.push(...provider.models);
		}
	}
	return /** @type {Array<{ id?: string, cost?: Record<string, unknown> }>} */ (
		models
	);
}
