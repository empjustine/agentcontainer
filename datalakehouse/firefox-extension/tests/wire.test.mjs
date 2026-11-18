/**
 * @fileoverview The wire half of docs/d204: record shapes, the batch envelope,
 * and the three transport outcomes, exercised against a real loopback server so
 * the ack/reject/retry classification is measured rather than assumed.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
	bookmarkRecord,
	bookmarkTombstone,
	buildEnvelope,
	historyRemovalRecords,
	isCapturable,
	placesTimeMs,
	postBatch,
	titleKey,
	titleRecord,
	visitKey,
	visitRecord,
} from "../wire.mjs";

/**
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void} handler
 * @param {(origin: string, seen: Record<string, unknown>[]) => Promise<void>} body
 * @returns {Promise<void>}
 */
async function withDaemon(handler, body) {
	/** @type {Record<string, unknown>[]} */
	const seen = [];
	const server = createServer((req, res) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({
				url: req.url,
				authorization: req.headers.authorization ?? null,
				payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			handler(req, res);
		});
	});
	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(undefined));
	});
	const address = /** @type {import("node:net").AddressInfo} */ (server.address());
	try {
		await body(`http://127.0.0.1:${address.port}`, seen);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => {
			server.close(resolve);
		});
	}
}

/**
 * @param {string} origin
 * @returns {Record<string, unknown>}
 */
function envelope(origin) {
	return buildEnvelope({
		stream: "visit",
		batch: { seq_low: 1, seq_high: 2 },
		acked: 0,
		checkpoint: { cursor_ms: null, acked_seq: 0 },
		records: [visitRecord({ url: `${origin}/a`, visit_time: 5, via: "live" })],
	});
}

test("only http and https are capturable", () => {
	assert.equal(isCapturable("https://example.org/a"), true);
	assert.equal(isCapturable("http://example.org/a"), true);
	assert.equal(isCapturable("about:config"), false);
	assert.equal(isCapturable("file:///etc/hosts"), false);
	assert.equal(isCapturable("moz-extension://abc/page.html"), false);
	assert.equal(isCapturable(undefined), false);
});

test("Places' two time units are normalised to milliseconds", () => {
	assert.equal(placesTimeMs(1_700_000_000_000), 1_700_000_000_000);
	assert.equal(placesTimeMs(1_700_000_000_000_000), 1_700_000_000_000);
});

test("the visit key is the URL and millisecond pair, and nothing local", () => {
	assert.equal(visitKey("https://a.example/x", 7), '["https://a.example/x",7]');
	assert.notEqual(visitKey("https://a.example/x", 7), visitKey("https://a.example/x", 8));
});

test("a live visit row omits the fields only getVisits can supply", () => {
	const row = visitRecord({ url: "https://a.example/x", visit_time: 7, via: "live" });
	assert.equal(row.src, "firefox-history");
	assert.equal(row.kind, "visit");
	assert.equal(row.key, visitKey("https://a.example/x", 7));
	assert.equal(row.via, "live");
	assert.equal("transition" in row, false);
	assert.equal("visit_id" in row, false);
	const backfilled = visitRecord({
		url: "https://a.example/x",
		visit_time: 7,
		transition: "typed",
		visit_id: "42",
		via: "backfill",
	});
	assert.equal(backfilled.transition, "typed");
	assert.equal(backfilled.visit_id, "42");
});

test("a title fact is keyed on the page, not on a visit", () => {
	const row = titleRecord({ page_id: "GUID", url: "https://a.example/x", title: "T", seen_at: 9 });
	assert.equal(row.key, titleKey("GUID"));
	assert.equal(row.kind, "title");
});

test("history removals are page-granular, and a clear is a mark", () => {
	const removed = historyRemovalRecords(
		{ allHistory: false, urls: ["https://a.example/x", "about:config"] },
		5,
	);
	assert.equal(removed.length, 1);
	assert.equal(removed[0]?.kind, "visit-removed");
	assert.equal(removed[0]?.key, "https://a.example/x");
	assert.equal(removed[0]?.source, "local");
	const cleared = historyRemovalRecords({ allHistory: true, urls: [] }, 5);
	assert.equal(cleared.length, 1);
	assert.equal(cleared[0]?.kind, "history-cleared");
	assert.equal(cleared[0]?.key, "*");
});

test("bookmark rows carry parent and position, never a path, and drop separators", () => {
	const row = bookmarkRecord(
		{ id: "b1", title: "T", index: 2, dateAdded: 1_700_000_000_000_000, type: "bookmark", url: "https://a.example/x", parentId: "f1" },
		"walk",
	);
	assert.ok(row);
	assert.equal(row.key, "b1");
	assert.equal(row.position, 2);
	assert.equal(row.parent_id, "f1");
	assert.equal(row.date_added, 1_700_000_000_000);
	assert.equal("folder_path" in row, false);
	assert.equal(bookmarkRecord({ id: "s", title: "", type: "separator", url: "data:" }, "walk"), null);
	const folder = bookmarkRecord({ id: "f1", title: "F", type: "folder", index: 0, dateAdded: 1_700_000_000_000 }, "walk");
	assert.ok(folder);
	assert.equal(folder.url, null);
});

test("a folder removal is marked cascade; a bookmark removal is not", () => {
	const base = { parent_id: "f1", url: "", title: "T" };
	const folder = bookmarkTombstone({ id: "f1", node_type: "folder", ...base }, 3);
	assert.equal(folder.cascade, true);
	assert.equal(folder.source, "bookmark");
	const bookmark = bookmarkTombstone({ id: "b1", node_type: "bookmark", ...base }, 3);
	assert.equal(bookmark.cascade, false);
});

test("the envelope carries the schema, stream sequence, checkpoint and rows", async () => {
	await withDaemon(
		(_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ accepted: 1, duplicates: 0, version: "0.1.0" }));
		},
		async (origin, seen) => {
			const result = await postBatch({
				fetchImpl: fetch,
				origin,
				key: "",
				envelope: envelope(origin),
			});
			assert.equal(result.kind, "ack");
			assert.equal(result.accepted, 1);
			assert.equal(result.version, "0.1.0");
			const posted = seen[0];
			assert.ok(posted);
			assert.equal(posted.url, "/ingest/slurp");
			assert.equal(posted.authorization, null);
			const payload = /** @type {Record<string, unknown>} */ (posted.payload);
			assert.equal(payload.schema, 1);
			assert.equal(payload.stream, "visit");
			assert.deepEqual(payload.stream_seq, { low: 1, high: 2, acked: 0 });
			assert.equal(Array.isArray(payload.records), true);
		},
	);
});

test("the static key travels as a bearer token only when set", async () => {
	await withDaemon(
		(_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		},
		async (origin, seen) => {
			await postBatch({ fetchImpl: fetch, origin, key: "s3cret", envelope: envelope(origin) });
			assert.equal(seen[0]?.authorization, "Bearer s3cret");
		},
	);
});

test("a permanent rejection is not retried, a server fault is", async () => {
	await withDaemon(
		(_req, res) => {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "unknown stream" }));
		},
		async (origin) => {
			const result = await postBatch({ fetchImpl: fetch, origin, key: "", envelope: envelope(origin) });
			assert.equal(result.kind, "reject");
			assert.equal(result.status, 400);
			assert.match(result.reason ?? "", /400/);
		},
	);
	await withDaemon(
		(_req, res) => {
			res.writeHead(503);
			res.end("busy");
		},
		async (origin) => {
			const result = await postBatch({ fetchImpl: fetch, origin, key: "", envelope: envelope(origin) });
			assert.equal(result.kind, "retry");
		},
	);
	await withDaemon(
		(_req, res) => {
			res.writeHead(429);
			res.end("slow down");
		},
		async (origin) => {
			const result = await postBatch({ fetchImpl: fetch, origin, key: "", envelope: envelope(origin) });
			assert.equal(result.kind, "retry");
		},
	);
});

test("a silent daemon is a retry, not a lost batch", async () => {
	await withDaemon(
		() => undefined,
		async (origin) => {
			const result = await postBatch({
				fetchImpl: fetch,
				origin,
				key: "",
				envelope: envelope(origin),
				timeoutMs: 50,
			});
			assert.equal(result.kind, "retry");
			assert.match(result.reason ?? "", /transport/);
		},
	);
});
