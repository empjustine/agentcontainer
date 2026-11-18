/**
 * @fileoverview history.mjs — the visit and page-title producer: the live event
 * rows, the page-level removal tombstones, and the oldest-first backfill sweep
 * (docs/d204's R1, R2, R7, SLURP-R9 and "Adaptive batching").
 *
 * WHY the live row is not the authoritative one: onVisited hands the extension
 * a page item — guid, url, title, last visit time, counts — and NO visit id,
 * transition or referring visit (verified against ext-history.js). Those two
 * fields exist only on getVisits, which is the backfill path's call. So the live
 * stream is the accelerator and the backfill is the repair: every row is
 * re-derivable, which is what lets a queue overflow drop a visit without
 * losing it (docs/d204 R8).
 *
 * WHY the backfill window can be re-read: history.search sorts newest-first and
 * caps at maxResults, so a window holding more pages than the cap would return
 * its NEWEST rows and silently hide its oldest — the exact rows a retention
 * rule prunes first. A window that fills the page is therefore halved and never
 * advanced, and a trailing repair window is re-read after the cursor is caught
 * up so a suspended background page's missed events are recovered.
 */

import { enqueue } from "./queue.mjs";
import { tuneAfterCall } from "./state.mjs";
import {
	historyRemovalRecords,
	isCapturable,
	titleRecord,
	visitRecord,
} from "./wire.mjs";

/**
 * @typedef {object} HistoryItem
 * @property {string} id page guid
 * @property {string} url
 * @property {string} title
 * @property {number} lastVisitTime milliseconds
 * @property {number} visitCount
 * @typedef {object} VisitItem
 * @property {string} id page guid
 * @property {string} visitId local visit row number as a string
 * @property {number} visitTime milliseconds
 * @property {string} referringVisitId local visit row number as a string
 * @property {string} transition
 * @typedef {object} HistoryApi
 * @property {(query: { text: string, startTime: number, endTime: number, maxResults: number }) => Promise<HistoryItem[]>} search
 * @property {(query: { url: string }) => Promise<VisitItem[]>} getVisits
 */

/**
 * @param {HistoryItem} item
 * @returns {Record<string, unknown> | null}
 */
export function liveVisitRecord(item) {
	if (!isCapturable(item.url) || !Number.isFinite(item.lastVisitTime)) {
		return null;
	}
	return visitRecord({
		url: item.url,
		visit_time: item.lastVisitTime,
		title: item.title,
		page_id: item.id,
		via: "live",
	});
}

/**
 * @param {{ id: string, url: string, title: string }} item
 * @param {number} now
 * @returns {Record<string, unknown> | null}
 */
export function liveTitleRecord(item, now) {
	if (!isCapturable(item.url) || typeof item.id !== "string") {
		return null;
	}
	return titleRecord({
		page_id: item.id,
		url: item.url,
		title: item.title,
		seen_at: now,
	});
}

/**
 * @param {{ allHistory: boolean, urls: string[] }} event
 * @param {number} now
 * @returns {Record<string, unknown>[]}
 */
export function liveRemovalRecords(event, now) {
	return historyRemovalRecords(event, now);
}

/**
 * @typedef {object} BackfillResult
 * @property {"pending" | "saturated" | "empty" | "enqueued" | "idle"} status
 * @property {number} records
 * @property {number} elapsed_ms
 * @property {number} window_end
 * @property {number} [evicted] rows dropped by the queue's ceiling
 */

/**
 * One backfill pass: one window, expanded and queued, or a decision to wait.
 * @param {object} args
 * @param {HistoryApi} args.history
 * @param {import("./queue.mjs").StorageArea} args.storage
 * @param {import("./state.mjs").Tune} args.tune
 * @param {import("./state.mjs").Streams} args.streams
 * @param {import("./settings.mjs").Settings} args.settings
 * @param {number} args.queue_bytes
 * @param {() => number} args.clock
 * @returns {Promise<BackfillResult>}
 */
export async function backfillPass(args) {
	const { history, tune, streams, settings, clock } = args;
	const pending = streams.visit.pending;
	if (pending !== null) {
		return { status: "pending", records: 0, elapsed_ms: 0, window_end: pending.window_end };
	}
	const now = clock();
	const cursor = Math.min(streams.visit.cursor_ms ?? 0, now);
	const repair_ms = settings.repair_hours * 3_600_000;
	const caught_up = cursor >= now;
	const repairing =
		caught_up && repair_ms > 0 && now - (streams.visit.repaired_at ?? 0) > repair_ms / 2;
	const start = repairing ? Math.max(0, now - repair_ms) : cursor;
	const window_end = repairing ? cursor : Math.min(now, start + tune.window_ms);
	const began = clock();
	const page = await history.search({
		text: "",
		startTime: start,
		endTime: window_end,
		maxResults: tune.page_size,
	});
	const searched_at = clock();
	const saturated = page.length >= tune.page_size;
	if (saturated) {
		tune.window_ms = Math.max(60_000, Math.floor(tune.window_ms / 2));
		return {
			status: "saturated",
			records: 0,
			elapsed_ms: searched_at - began,
			window_end,
		};
	}
	if (page.length === 0) {
		if (repairing) {
			streams.visit.repaired_at = now;
		} else {
			// Nothing in the window: move the cursor and fast-forward, so a profile's
			// empty early years cost a handful of searches rather than one per hour.
			streams.visit.cursor_ms = window_end;
			tune.window_ms = Math.min(604_800_000, tune.window_ms * 8);
		}
		return { status: "empty", records: 0, elapsed_ms: searched_at - began, window_end };
	}
	/** @type {Record<string, unknown>[]} */
	const rows = [];
	for (const item of page) {
		if (!isCapturable(item.url)) {
			continue;
		}
		if (item.visitCount > tune.visit_cap) {
			// getVisits has no time filter, so a URL visited thousands of times returns
			// all of them for one window. Past the cap the page's own last visit is sent
			// and the rest of that URL's timeline stays with the live stream.
			if (item.lastVisitTime >= start && item.lastVisitTime <= window_end) {
				rows.push(
					visitRecord({
						url: item.url,
						visit_time: item.lastVisitTime,
						title: item.title,
						page_id: item.id,
						via: "backfill-coarse",
					}),
				);
			}
			continue;
		}
		const visits = await history.getVisits({ url: item.url });
		for (const visit of visits) {
			// No lower bound on purpose: search selects PAGES by their LAST visit, so a
			// page whose last visit lands in this window is expanded here for the first
			// time, and its earlier visits would be filtered out of the window they
			// belong to (that window is already behind the cursor). Sending them under
			// the same key is idempotent — the daemon absorbs the repeat.
			if (visit.visitTime > window_end) {
				continue;
			}
			rows.push(
				visitRecord({
					url: item.url,
					visit_time: visit.visitTime,
					title: item.title,
					transition: visit.transition,
					page_id: item.id,
					visit_id: visit.visitId,
					via: "backfill",
				}),
			);
		}
	}
	const elapsed = clock() - began;
	const rowBudget = Math.max(tune.batch_rows * 10, 500);
	if (rows.length > rowBudget && tune.page_size > 25) {
		// A very old, dense profile can put more visits in one page than a pass
		// should carry (a long-lived URL sends its whole timeline at once). The
		// window is not advanced and the next pass searches a smaller page; at the
		// floor the pass enqueues what it has rather than shrinking forever.
		tune.page_size = Math.max(25, Math.floor(tune.page_size / 2));
		return { status: "saturated", records: 0, elapsed_ms: elapsed, window_end };
	}
	rows.sort(byVisitTime);
	const tuned = tuneAfterCall(tune, elapsed, {});
	Object.assign(tune, tuned.tune);
	if (rows.length === 0) {
		streams.visit.cursor_ms = window_end;
		return { status: "empty", records: 0, elapsed_ms: elapsed, window_end };
	}
	const { seqs, evicted } = await enqueue(
		args.storage,
		rows.map((body) => ({ stream: /** @type {const} */ ("visit"), body })),
		args.queue_bytes,
	);
	if ((evicted.visit ?? 0) > 0) {
		// A dropped row inside the window means the window must be re-read, not
		// advanced: the eviction happened after the queue accepted it.
		streams.visit.pending = null;
		return {
			status: "enqueued",
			records: rows.length,
			elapsed_ms: elapsed,
			window_end: streams.visit.cursor_ms ?? 0,
			evicted: evicted.visit ?? 0,
		};
	}
	const seqHigh = seqs.at(-1);
	if (seqHigh !== undefined) {
		streams.visit.pending = { window_end, seq_high: seqHigh };
	}
	if (repairing) {
		streams.visit.repaired_at = now;
	}
	return {
		status: "enqueued",
		records: rows.length,
		elapsed_ms: elapsed,
		window_end,
		evicted: 0,
	};
}

/**
 * Moves the visit cursor once the window in flight is fully acknowledged. The
 * cursor names "everything at or before this instant is in the daemon", so it
 * moves on an ack and never on a send (docs/d204 SLURP-R9).
 * @param {import("./queue.mjs").QueueMeta} meta
 * @param {import("./state.mjs").Streams} streams
 * @returns {boolean} whether the cursor moved
 */
export function advanceVisitCheckpoint(meta, streams) {
	const pending = streams.visit.pending;
	if (pending === null || meta.visit.acked < pending.seq_high) {
		return false;
	}
	streams.visit.cursor_ms = pending.window_end;
	streams.visit.pending = null;
	return true;
}

/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {number}
 */
function byVisitTime(left, right) {
	const a = typeof left.visit_time === "number" ? left.visit_time : 0;
	const b = typeof right.visit_time === "number" ? right.visit_time : 0;
	return a - b;
}
