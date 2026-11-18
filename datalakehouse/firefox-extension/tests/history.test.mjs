/**
 * @fileoverview The backfill sweep's contract (docs/d204 R2/R9 and "Adaptive
 * batching"): oldest-first, never advancing past an unfinished window, halving
 * a saturated one, and reading back the trailing window after a suspend.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	advanceVisitCheckpoint,
	backfillPass,
	liveRemovalRecords,
	liveTitleRecord,
	liveVisitRecord,
} from "../history.mjs";
import { ack, snapshot, take } from "../queue.mjs";
import { emptyStreams, TUNE_DEFAULTS } from "../state.mjs";
import { createHistory, createStorage, queuedRecords } from "./fake-webext.mjs";

const DAY = 86_400_000;

const settings = {
	enabled: true,
	daemon_url: "http://127.0.0.1:8788",
	key: "",
	queue_bytes: 1_000_000,
	repair_hours: 0,
};

/** @returns {import("../state.mjs").Tune} */
const tune = () => ({ ...TUNE_DEFAULTS, window_ms: DAY, page_size: 10 });

/**
 * @param {import("./fake-webext.mjs").FakeStorage} storage
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function drainVisits(storage) {
	const batch = await take(storage, "visit", { rows: 100, bytes: 1_000_000 });
	assert.ok(batch);
	await ack(storage, batch);
	return batch.records.map((record) => record.body);
}

test("the sweep walks oldest-first and only advances on the ack", async () => {
	const history = createHistory([
		{
			url: "https://a.example/1",
			title: "A",
			page_id: "GA",
			visits: [{ visit_time: 3 * DAY + 1000 }, { visit_time: 3 * DAY + 2000, transition: "typed" }],
		},
		{ url: "https://b.example/2", title: "B", page_id: "GB", visits: [{ visit_time: 5 * DAY }] },
	]);
	const storage = createStorage();
	const knobs = tune();
	const streams = emptyStreams();
	const clock = () => 6 * DAY;
	const args = { history, storage, tune: knobs, streams, settings, queue_bytes: 1_000_000, clock };

	const first = await backfillPass(args);
	assert.equal(first.status, "empty", "a window before the first visit costs one search");
	assert.equal(streams.visit.cursor_ms, DAY);
	assert.equal(knobs.window_ms, 604_800_000, "an empty window fast-forwards, up to the cap");

	const second = await backfillPass(args);
	assert.equal(second.status, "enqueued");
	assert.equal(second.records, 3);
	assert.equal(streams.visit.cursor_ms, DAY, "the cursor waits for the ack");
	assert.deepEqual(streams.visit.pending, { window_end: 6 * DAY, seq_high: 3 });

	const rows = queuedRecords(storage);
	assert.deepEqual(
		rows.map((row) => row.visit_time),
		[3 * DAY + 1000, 3 * DAY + 2000, 5 * DAY],
	);
	assert.equal(rows[1]?.transition, "typed");
	assert.equal(rows[1]?.visit_id, "2");
	assert.equal(rows[0]?.via, "backfill");

	const blocked = await backfillPass(args);
	assert.equal(blocked.status, "pending", "one window in flight at a time");

	await drainVisits(storage);
	const state = await snapshot(storage);
	assert.equal(advanceVisitCheckpoint(state.meta, streams), true);
	assert.equal(streams.visit.cursor_ms, 6 * DAY);
	assert.equal(streams.visit.pending, null);
});

test("a page reached late still yields the visits from windows already passed", async () => {
	const history = createHistory([
		{
			url: "https://a.example/spread",
			visits: [{ visit_time: DAY + 5000 }, { visit_time: 10 * DAY }],
		},
	]);
	const storage = createStorage();
	const knobs = { ...tune(), window_ms: 10 * DAY };
	const streams = emptyStreams();
	const result = await backfillPass({
		history,
		storage,
		tune: knobs,
		streams,
		settings,
		queue_bytes: 1_000_000,
		clock: () => 12 * DAY,
	});
	assert.equal(result.status, "enqueued");
	assert.equal(result.records, 2, "the day-1 visit was not dropped with its window");
	assert.deepEqual(
		queuedRecords(storage).map((row) => row.visit_time),
		[DAY + 5000, 10 * DAY],
	);
});

test("a window that fills the page is halved and never advanced", async () => {
	const history = createHistory([
		{ url: "https://a.example/1", visits: [{ visit_time: 2 * DAY + 1 }] },
		{ url: "https://a.example/2", visits: [{ visit_time: 2 * DAY + 2 }] },
		{ url: "https://a.example/3", visits: [{ visit_time: 2 * DAY + 3 }] },
	]);
	const storage = createStorage();
	const knobs = { ...tune(), page_size: 2 };
	const streams = emptyStreams();
	streams.visit.cursor_ms = 2 * DAY;
	const result = await backfillPass({
		history,
		storage,
		tune: knobs,
		streams,
		settings,
		queue_bytes: 1_000_000,
		clock: () => 6 * DAY,
	});
	assert.equal(result.status, "saturated");
	assert.equal(result.records, 0);
	assert.equal(knobs.window_ms, DAY / 2);
	assert.equal(streams.visit.cursor_ms, 2 * DAY, "the window is never advanced past unread rows");
	assert.equal(streams.visit.pending, null);
});

test("a URL past the expansion cap sends its page visit, not a getVisits storm", async () => {
	const visits = Array.from({ length: 600 }, (_unused, index) => ({
		visit_time: DAY + index,
	}));
	const history = createHistory([{ url: "https://hot.example/", visits }]);
	const storage = createStorage();
	const streams = emptyStreams();
	const result = await backfillPass({
		history,
		storage,
		tune: { ...tune(), window_ms: 10 * DAY, visit_cap: 500 },
		streams,
		settings,
		queue_bytes: 1_000_000,
		clock: () => 6 * DAY,
	});
	assert.equal(result.status, "enqueued");
	assert.equal(result.records, 1);
	assert.equal(history.calls.getVisits.length, 0);
	const rows = queuedRecords(storage);
	assert.equal(rows[0]?.via, "backfill-coarse");
	assert.equal(rows[0]?.visit_time, DAY + 599);
});

test("a dense page shrinks the next pass instead of flooding the queue", async () => {
	const visits = Array.from({ length: 600 }, (_unused, index) => ({
		visit_time: DAY + index,
	}));
	const history = createHistory([{ url: "https://dense.example/", visits }]);
	const storage = createStorage();
	const streams = emptyStreams();
	const knobs = {
		...tune(),
		window_ms: 10 * DAY,
		page_size: 100,
		visit_cap: 5000,
		batch_rows: 50,
	};
	const args = {
		history,
		storage,
		tune: knobs,
		streams,
		settings,
		queue_bytes: 4_000_000,
		clock: () => 6 * DAY,
	};
	const first = await backfillPass(args);
	assert.equal(first.status, "saturated");
	assert.equal(queuedRecords(storage).length, 0, "nothing is queued at the smaller page");
	assert.equal(knobs.page_size, 50);

	knobs.page_size = 25;
	const atFloor = await backfillPass(args);
	assert.equal(atFloor.status, "enqueued", "at the floor the pass takes what it has");
	assert.equal(atFloor.records, 600);
});

test("internal pages are skipped and still let the cursor move", async () => {
	const history = createHistory([{ url: "about:config", visits: [{ visit_time: 1000 }] }]);
	const storage = createStorage();
	const streams = emptyStreams();
	const result = await backfillPass({
		history,
		storage,
		tune: tune(),
		streams,
		settings,
		queue_bytes: 1_000_000,
		clock: () => 2 * DAY,
	});
	assert.equal(result.status, "empty");
	assert.equal(queuedRecords(storage).length, 0);
	assert.equal(streams.visit.cursor_ms, DAY, "the window_end, not the visit");
});

test("the trailing repair window is re-read after a suspend", async () => {
	const history = createHistory([
		{ url: "https://a.example/late", visits: [{ visit_time: 6 * DAY - 3_600_000 }] },
	]);
	const storage = createStorage();
	const streams = emptyStreams();
	streams.visit.cursor_ms = 6 * DAY;
	const result = await backfillPass({
		history,
		storage,
		tune: tune(),
		streams,
		settings: { ...settings, repair_hours: 6 },
		queue_bytes: 1_000_000,
		clock: () => 6 * DAY,
	});
	assert.equal(result.status, "enqueued");
	assert.equal(result.records, 1);
	assert.deepEqual(streams.visit.pending, { window_end: 6 * DAY, seq_high: 1 });
	assert.equal(streams.visit.repaired_at, 6 * DAY);
	await drainVisits(storage);
	const state = await snapshot(storage);
	advanceVisitCheckpoint(state.meta, streams);
	assert.equal(streams.visit.cursor_ms, 6 * DAY, "a repair never moves the cursor");
});

test("live rows and removals obey the same capture rules", () => {
	assert.equal(liveVisitRecord({ id: "G", url: "about:newtab", title: "", lastVisitTime: 1, visitCount: 1 }), null);
	const live = liveVisitRecord({
		id: "G",
		url: "https://a.example/",
		title: "A",
		lastVisitTime: 11,
		visitCount: 1,
	});
	assert.ok(live);
	assert.equal(live.via, "live");
	assert.equal(live.page_id, "G");
	assert.equal("transition" in live, false);
	assert.equal(liveTitleRecord({ id: "G", url: "about:blank", title: "" }, 1), null);
	assert.ok(liveTitleRecord({ id: "G", url: "https://a.example/", title: "A" }, 1));
	assert.deepEqual(
		liveRemovalRecords({ allHistory: false, urls: ["https://a.example/"] }, 1).map(
			(record) => record.kind,
		),
		["visit-removed"],
	);
});
