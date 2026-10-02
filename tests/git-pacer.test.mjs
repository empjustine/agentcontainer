/**
 * @fileoverview git-pacer.test.mjs — guards createMinIntervalGate's two
 * load-bearing properties, both invisible in a normal single-job run:
 *
 * 1. gated calls are SERIALIZED, not merely spaced. The software-forge (VBS)
 *    tenant rate-limits concurrent requests, so `--jobs 2` must not put two
 *    forge fetches in flight at once even though they are a minute apart
 *    (docs/d044).
 * 2. a rejecting gated call does not poison the chain. A failed mirror must
 *    not make every later caller skip its turn and burst, and the caller still
 *    sees the rejection.
 *
 * Run: node --test
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMinIntervalGate } from "../git/git-lib.mjs";

/** @param {number} ms @returns {Promise<void>} */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("interval 0 is a pass-through, so public-forge sweeps are not serialized", async () => {
	const gate = createMinIntervalGate(0);
	let inFlight = 0;
	let peak = 0;
	const op = async () => {
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		await delay(30);
		inFlight -= 1;
	};
	await Promise.all([gate(op), gate(op), gate(op)]);
	assert.equal(peak, 3, "ungated calls must be able to overlap");
});

test("concurrent gated calls never overlap and are spaced by the interval", async () => {
	const intervalMs = 50;
	const gate = createMinIntervalGate(intervalMs);
	let inFlight = 0;
	/** @type {number[]} */
	const starts = [];
	const op = async () => {
		inFlight += 1;
		assert.equal(inFlight, 1, "gated calls must not overlap");
		starts.push(Date.now());
		await delay(5);
		inFlight -= 1;
	};
	await Promise.all([gate(op), gate(op), gate(op)]);
	assert.equal(starts.length, 3);
	for (let i = 1; i < starts.length; i += 1) {
		const gap = starts[i] - starts[i - 1];
		assert.ok(
			gap >= intervalMs - 5,
			`gap ${gap}ms should be at least ~${intervalMs}ms`,
		);
	}
});

test("a rejecting call does not poison the gate for later callers", async () => {
	const intervalMs = 30;
	const gate = createMinIntervalGate(intervalMs);
	/** @type {Record<string, number>} */
	const at = {};
	const results = await Promise.allSettled([
		gate(async () => {
			at.a = Date.now();
		}),
		gate(async () => {
			at.b = Date.now();
			throw new Error("boom");
		}),
		gate(async () => {
			at.c = Date.now();
		}),
	]);
	assert.deepEqual(
		results.map((r) => r.status),
		["fulfilled", "rejected", "fulfilled"],
	);
	const a = at.a;
	const b = at.b;
	const c = at.c;
	assert.ok(a <= b && b <= c, "later callers must still run, in order");
	assert.ok(
		c - b >= intervalMs - 5,
		"the failed call must not let the next one start early",
	);
});
