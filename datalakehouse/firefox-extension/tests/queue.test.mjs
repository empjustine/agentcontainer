/**
 * @fileoverview The durable queue's contract: FIFO per stream, bounded by rows
 * and bytes, acked by delete, trimmed oldest-first with tombstones last
 * (docs/d204 R8/R9).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ack as ackBatch, enqueue, snapshot, take } from "../queue.mjs";
import { createStorage } from "./fake-webext.mjs";

/**
 * @param {number} n
 * @returns {{ stream: "visit", body: Record<string, unknown> }}
 */
const visit = (n) => ({
	stream: "visit",
	body: { kind: "visit", key: `k${n}`, url: `https://e.example/${n}` },
});

/**
 * @param {number} n
 * @returns {{ stream: "tombstone", body: Record<string, unknown> }}
 */
const tombstone = (n) => ({
	stream: "tombstone",
	body: { kind: "bookmark-removed", key: `t${n}` },
});

test("take yields the oldest rows first and ack advances the stream", async () => {
	const storage = createStorage();
	const { seqs } = await enqueue(storage, [visit(1), visit(2), visit(3)], 1_000_000);
	assert.deepEqual(seqs, [1, 2, 3]);
	const batch = await take(storage, "visit", { rows: 2, bytes: 1_000_000 });
	assert.ok(batch);
	assert.deepEqual(
		batch.records.map((record) => record.body.key),
		["k1", "k2"],
	);
	assert.equal(batch.seq_low, 1);
	assert.equal(batch.seq_high, 2);
	const meta = await ackBatch(storage, batch);
	assert.equal(meta.visit.acked, 2);
	assert.equal(meta.visit.count, 1);
	const rest = await take(storage, "visit", { rows: 10, bytes: 1_000_000 });
	assert.ok(rest);
	assert.deepEqual(
		rest.records.map((record) => record.body.key),
		["k3"],
	);
	assert.equal(rest.seq_low, 3);
});

test("the byte cap ends the batch but never starves a single row", async () => {
	const storage = createStorage();
	const fat = (/** @type {number} */ n) => ({
		stream: /** @type {const} */ ("visit"),
		body: { kind: "visit", key: `k${n}`, pad: "x".repeat(400) },
	});
	await enqueue(storage, [fat(1), fat(2)], 1_000_000);
	const first = await take(storage, "visit", { rows: 10, bytes: 500 });
	assert.ok(first);
	assert.equal(first.records.length, 1);
	const single = await take(storage, "visit", { rows: 10, bytes: 10 });
	assert.ok(single);
	assert.equal(single.records.length, 1);
});

test("a batch never mixes streams", async () => {
	const storage = createStorage();
	await enqueue(storage, [visit(1), tombstone(1), visit(2)], 1_000_000);
	const batch = await take(storage, "visit", { rows: 10, bytes: 1_000_000 });
	assert.ok(batch);
	assert.deepEqual(
		batch.records.map((record) => record.body.kind),
		["visit", "visit"],
	);
	const tombstones = await take(storage, "tombstone", { rows: 10, bytes: 1_000_000 });
	assert.ok(tombstones);
	assert.equal(tombstones.records.length, 1);
});

test("the ceiling trims visits before tombstones", async () => {
	const storage = createStorage();
	for (let n = 1; n <= 5; n += 1) {
		await enqueue(storage, [visit(n)], 300);
	}
	await enqueue(storage, [tombstone(1)], 300);
	const state = await snapshot(storage);
	assert.ok(state.total_bytes <= 300);
	assert.equal(state.meta.tombstone.count, 1, "the removal survives the trim");
	assert.ok(state.meta.visit.count < 5, "visits were dropped");
});

test("a quota error trims and retries the write", async () => {
	const storage = createStorage({}, { quota: 900 });
	for (let n = 1; n <= 3; n += 1) {
		await enqueue(storage, [visit(n)], 1_000_000);
	}
	const big = {
		stream: /** @type {const} */ ("visit"),
		body: { kind: "visit", key: "big", pad: "y".repeat(500) },
	};
	await enqueue(storage, [big], 1_000_000);
	const state = await snapshot(storage);
	assert.ok(state.meta.visit.count >= 1, "the new row is stored");
	assert.ok(state.total_bytes <= 900);
});

test("garbage metadata reads as an empty queue", async () => {
	const storage = createStorage({ qmeta: "not an object" });
	assert.equal((await take(storage, "visit", { rows: 1, bytes: 1000 })), null);
	const state = await snapshot(storage);
	assert.equal(state.meta.visit.head, 1);
	assert.equal(state.total_bytes, 0);
});
