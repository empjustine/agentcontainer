/**
 * @fileoverview slurp-contract.mjs — the two halves of the slurp contract under
 * one call: the extension's own record builders and poster, and the daemon they
 * post to.
 *
 * WHY a live daemon rather than a stubbed one: the risk this checks is not
 * either half's logic but their agreement — the endpoint path, the envelope
 * field names, the record kinds, the ack fields and the effect on the read
 * faces. A unit test on each side passes with a drifted contract.
 *
 * Usage: node-run.sh slurp-contract.mjs <hister-origin> <promnesia-origin> <key>
 */
import assert from "node:assert/strict";
import { createStorage } from "../firefox-extension/tests/fake-webext.mjs";
import { enqueue, take } from "../firefox-extension/queue.mjs";
import {
	bookmarkRecord,
	buildEnvelope,
	historyRemovalRecords,
	postBatch,
	titleRecord,
	visitRecord,
} from "../firefox-extension/wire.mjs";

const [originArg, promnesiaOriginArg, keyArg] = process.argv.slice(2);
if (originArg === undefined || promnesiaOriginArg === undefined) {
	throw new Error("usage: slurp-contract.mjs <hister-origin> <promnesia-origin> <key>");
}
const origin = originArg;
const promnesiaOrigin = promnesiaOriginArg;
const key = keyArg ?? "";

const base = 1_700_000_000_000;
// A zero byte ceiling would evict every row on enqueue, so the fixture states a
// ceiling far above what the rows below weigh.
const QUEUE_BYTES = 100 * 1024 * 1024;
const storage = createStorage();

/**
 * Post one stream's queued rows through the extension's own transport.
 * @param {"visit" | "bookmark" | "tombstone"} stream
 */
async function post(stream) {
	const batch = await take(storage, stream, { rows: 100, bytes: 1_000_000 });
	assert.ok(batch !== null, `nothing queued for ${stream}`);
	const envelope = buildEnvelope({
		stream,
		batch,
		acked: 0,
		checkpoint: null,
		records: batch.records.map((record) => record.body),
	});
	const result = await postBatch({ fetchImpl: fetch, origin, key, envelope });
	assert.equal(result.kind, "ack", `stream ${stream}: ${result.reason ?? ""}`);
	return result;
}

const visit = visitRecord({
	url: "https://mobile.twitter.com/contract/status/1?s=20",
	visit_time: base + 1000,
	title: "Contract Visit",
	via: "backfill",
	transition: "link",
	page_id: "p1",
});
const title = titleRecord({
	page_id: "p2",
	url: "https://contract.example/untitled",
	title: "Later Title",
	seen_at: base + 2000,
});
const root = bookmarkRecord(
	{
		id: "contract-b1",
		type: "bookmark",
		url: "https://github.com/giraffe-fsharp/Giraffe",
		title: "Giraffe",
		parentId: "contract-f1",
		index: 3,
		dateAdded: base * 1000,
	},
	"walk",
);
const folder = bookmarkRecord(
	{ id: "contract-f1", type: "folder", title: "Reading", parentId: "root________", index: 0 },
	"walk",
);
const removals = historyRemovalRecords(
	{ allHistory: false, urls: ["https://contract.example/untitled"] },
	base + 3000,
);

assert.ok(root, "the GitHub repository root is a bookmark row");
assert.ok(folder, "the folder is a bookmark row");
for (const record of [visit, title]) {
	await enqueue(storage, [{ stream: "visit", body: record }], QUEUE_BYTES);
}
for (const record of [root, folder]) {
	await enqueue(storage, [{ stream: "bookmark", body: record }], QUEUE_BYTES);
}
for (const record of removals) {
	await enqueue(storage, [{ stream: "tombstone", body: record }], QUEUE_BYTES);
}

const visitAck = await post("visit");
assert.equal(visitAck.accepted, 2, "visit + title records are both accepted");
assert.equal(visitAck.duplicates, 0);
assert.ok(
	typeof visitAck.version === "string" && visitAck.version.length > 0,
	"the ack names the daemon version",
);

const bookmarkAck = await post("bookmark");
// The fixture ids carry a prefix of their own: this check runs inside the
// daemon's own shell test, where another fixture already posted f1/b1.
assert.equal(bookmarkAck.accepted, 2);

const tombstoneAck = await post("tombstone");
assert.equal(tombstoneAck.accepted, 1);

/**
 * @param {string} path
 * @param {unknown} body
 * @returns {Promise<any>}
 */
async function promnesia(path, body) {
	const response = await fetch(promnesiaOrigin + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	assert.equal(response.status, 200, `${path} answered ${response.status}`);
	return response.json();
}

// The canonicaliser is the daemon's: the raw mobile.twitter URL must answer the
// desktop spelling, and the Promnesia envelope must carry the canonical one.
const visited = await promnesia("/visited", {
	urls: ["https://twitter.com/contract/status/1"],
});
assert.equal(visited.length, 1);
assert.notEqual(visited[0], null, "the desktop URL is seen");
assert.equal(visited[0].normalised_url, "twitter.com/contract/status/1");
assert.equal(visited[0].locator.title, "Contract Visit");

// A title fact filled a locator but must never invent a visit.
const untitled = await promnesia("/visited", {
	urls: ["https://contract.example/untitled"],
});
assert.equal(untitled[0], null, "a title fact is not a visit");

// The bookmark stream is stored but never creates a visited mark (docs/d204):
// the GitHub root came through the same bookmark batch as the folder.
const bookmarked = await promnesia("/visited", {
	urls: ["https://github.com/giraffe-fsharp/Giraffe"],
});
assert.equal(bookmarked[0], null, "a bookmark is not a visit");

const visitsResponse = await promnesia("/visits", {
	url: "https://mobile.twitter.com/contract/status/1",
});
assert.equal(visitsResponse.normalised_url, "twitter.com/contract/status/1");
assert.equal(visitsResponse.visits.length, 1);
assert.equal(visitsResponse.visits[0].locator.title, "Contract Visit");

// The removal was page-granular: the visit list is empty, the visited check
// still answers (docs/d205's mark, not an erase).
const afterRemoval = await promnesia("/visits", {
	url: "https://contract.example/untitled",
});
assert.deepEqual(afterRemoval.visits, []);

// A replay of the same window is answered as duplicates, not as new rows.
const replay = await post("visit");
assert.equal(replay.accepted, 0);

process.stdout.write("slurp contract ok\n");
