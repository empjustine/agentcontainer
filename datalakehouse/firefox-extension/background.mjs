/**
 * @fileoverview background.mjs — the extension's event page: it registers the
 * listeners, runs the three streams, and owns the flush/ack loop.
 *
 * WHY the listeners are registered synchronously at module load: a Manifest V3
 * background context is an event page, so an event that arrives while the page
 * is unloaded wakes it only to replay listeners that were registered in a
 * previous run. Registering after an await would lose the event that woke the
 * page (docs/d204's "5-second budget" section states the alarm/retry rule this
 * file implements).
 *
 * WHY the alarm is the retry path and setTimeout is the accelerator: a timer
 * does not survive an event page being suspended, an alarm does. The debounce
 * keeps a burst of visits from costing one post each; the minute alarm drains
 * whatever the timer never got to.
 */

import {
	changedRecord,
	createdRecord,
	removedRecord,
	walkBookmarks,
} from "./bookmarks.mjs";
import {
	advanceVisitCheckpoint,
	backfillPass,
	liveRemovalRecords,
	liveTitleRecord,
	liveVisitRecord,
} from "./history.mjs";
import { ack, enqueue, snapshot, take } from "./queue.mjs";
import {
	SCRUB_MIN_MS,
	loadScrub,
	consumeOwnBookmarkRemoval,
	retentionPass,
	saveScrub,
	stripOwnRemovals,
} from "./retention.mjs";
import { loadSettings } from "./settings.mjs";
import {
	loadStatus,
	loadStreams,
	loadTune,
	mergeStatus,
	saveStreams,
	saveTune,
	tuneAfterCall,
} from "./state.mjs";
import { buildEnvelope, describe, postBatch } from "./wire.mjs";

const SWEEP_ALARM = "slurp-sweep";
const SCRUB_ALARM = "slurp-scrub";
const FLUSH_DEBOUNCE_MS = 2000;
const MAX_BATCHES_PER_WAKE = 5;
const WALK_INTERVAL_MS = 24 * 3_600_000;

/**
 * Removals first because they are the only non-re-derivable rows; titles last
 * because a visit re-read carries the page's title anyway (docs/d204 R15).
 * @type {readonly import("./queue.mjs").StreamName[]}
 */
const FLUSH_ORDER = ["tombstone", "visit", "bookmark", "title"];

/**
 * @typedef {object} StorageArea
 * @property {(keys: string | string[]) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 * @typedef {{ addListener: (listener: (...args: never[]) => void) => void }} EventOf
 * @typedef {import("./history.mjs").HistoryItem} HistoryItem
 * @typedef {import("./bookmarks.mjs").BookmarkNode} BookmarkNode
 * @typedef {object} WebExtApi
 * @property {{ local: StorageArea }} storage
 * @property {{
 *   search: import("./history.mjs").HistoryApi["search"],
 *   getVisits: import("./history.mjs").HistoryApi["getVisits"],
 *   onVisited: EventOf,
 *   onVisitRemoved: EventOf,
 *   onTitleChanged: EventOf,
 *   deleteRange: (range: { startTime: number, endTime: number }) => Promise<void>
 * }} history
 * @property {{
 *   getTree: import("./bookmarks.mjs").BookmarksApi["getTree"],
 *   get: import("./bookmarks.mjs").BookmarksApi["get"],
 *   onCreated: EventOf,
 *   onRemoved: EventOf,
 *   onChanged: EventOf,
 *   onMoved: EventOf,
 *   remove: (id: string) => Promise<void>
 * }} bookmarks
 * @property {{
 *   create: (name: string, info: { periodInMinutes?: number, delayInMinutes?: number }) => void,
 *   clear: (name: string) => Promise<boolean>,
 *   onAlarm: EventOf
 * }} alarms
 * @property {{ openOptionsPage: () => Promise<void>, onInstalled: EventOf, onStartup: EventOf }} runtime
 */

/**
 * The WebExtension globals, read through one cast: tsc's program has no DOM or
 * WebExtension lib (tsconfig.json's lib is es2023), and a .d.ts for the API this
 * file calls would be a second description of Firefox's surface to keep true.
 * @returns {WebExtApi | null}
 */
function webext() {
	const globals = /** @type {Record<string, unknown>} */ (
		/** @type {unknown} */ (globalThis)
	);
	const api = globals.browser ?? globals.chrome;
	return typeof api === "object" && api !== null ? /** @type {WebExtApi} */ (api) : null;
}

/** @type {ReturnType<typeof setTimeout> | null} */
let scrubTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;

/**
 * @param {WebExtApi} api
 * @returns {void}
 */
function scheduleFlush(api) {
	if (flushTimer !== null) {
		return;
	}
	flushTimer = setTimeout(() => {
		flushTimer = null;
		run(api, () => flushOnce(api));
	}, FLUSH_DEBOUNCE_MS);
}

/**
 * The one error path: a failed task is recorded, never thrown at the event
 * dispatcher (a rejected listener is invisible in the browser console's noise).
 * @param {WebExtApi} api
 * @param {unknown} error
 * @returns {void}
 */
function reportError(api, error) {
	mergeStatus(api.storage.local, {
		last_error: describe(error),
		last_error_at: Date.now(),
	}).catch(() => undefined);
}

/**
 * @param {WebExtApi} api
 * @param {() => Promise<unknown>} task
 * @returns {void}
 */
function run(api, task) {
	task().catch((error) => reportError(api, error));
}

/**
 * @param {WebExtApi} api
 * @param {Record<string, unknown>} record
 * @param {"visit" | "bookmark" | "title" | "tombstone"} stream
 * @returns {Promise<void>}
 */
async function queueRecord(api, record, stream) {
	const settings = await loadSettings(api.storage.local);
	if (!settings.enabled) {
		return;
	}
	const { evicted } = await enqueue(
		api.storage.local,
		[{ stream, body: record }],
		settings.queue_bytes,
	);
	const dropped = Object.values(evicted).reduce((total, count) => total + count, 0);
	if (dropped > 0) {
		const status = await loadStatus(api.storage.local);
		await mergeStatus(api.storage.local, { evicted: status.evicted + dropped });
		if (stream === "bookmark") {
			// The walk is how a dropped bookmark row comes back; its cursor restarts
			// with it, so the resumed walk does not skip the dropped range.
			const streams = await loadStreams(api.storage.local);
			streams.bookmark = { walked_at: null, after_date_added: null, after_key: null };
			await saveStreams(api.storage.local, streams);
		}
	}
	scheduleFlush(api);
}

/**
 * @param {WebExtApi} api
 * @param {HistoryItem} item
 * @returns {Promise<void>}
 */
async function onVisited(api, item) {
	const record = liveVisitRecord(item);
	if (record === null) {
		return;
	}
	await queueRecord(api, record, "visit");
}

/**
 * @param {WebExtApi} api
 * @param {{ id: string, url: string, title: string }} item
 * @returns {Promise<void>}
 */
async function onTitleChanged(api, item) {
	const record = liveTitleRecord(item, Date.now());
	if (record === null) {
		return;
	}
	await queueRecord(api, record, "title");
}

/**
 * @param {WebExtApi} api
 * @param {{ allHistory: boolean, urls: string[] }} event
 * @returns {Promise<void>}
 */
async function onVisitRemoved(api, event) {
	const now = Date.now();
	// The extension's own retention prune deletes through the same API and
	// raises the same event. Forwarding those would mark exactly the pages the
	// archive just took as deleted, so the URLs this extension deleted are
	// consumed here and never become tombstones (docs/d204's visibility rule:
	// a removal means what the event names, and this one names our own prune).
	let urls = event.urls;
	if (!event.allHistory) {
		const scrub = await loadScrub(api.storage.local);
		const theirs = stripOwnRemovals(scrub, urls, now);
		if (theirs.length !== urls.length) {
			await saveScrub(api.storage.local, scrub);
		}
		urls = theirs;
	}
	if (urls.length === 0) {
		return;
	}
	for (const record of liveRemovalRecords({ ...event, urls }, now)) {
		await queueRecord(api, record, "tombstone");
	}
}

/**
 * @param {object} args
 * @param {import("./state.mjs").Streams} args.streams
 * @param {import("./queue.mjs").QueueMeta} args.meta
 * @param {import("./queue.mjs").StreamName} args.stream
 * @returns {Record<string, unknown> | null}
 */
function checkpointFor(args) {
	const live = args.meta[args.stream];
	if (args.stream === "visit") {
		return {
			cursor_ms: args.streams.visit.cursor_ms,
			pending: args.streams.visit.pending,
			acked_seq: live.acked,
		};
	}
	if (args.stream === "bookmark") {
		return { walked_at: args.streams.bookmark.walked_at, acked_seq: live.acked };
	}
	return { acked_seq: live.acked };
}

/**
 * @param {import("./queue.mjs").QueueMeta} meta
 * @returns {import("./queue.mjs").StreamName | null}
 */
function nextStream(meta) {
	for (const stream of FLUSH_ORDER) {
		if (meta[stream].count > 0) {
			return stream;
		}
	}
	return null;
}

/**
 * Drains the queue in single-stream batches until it is empty, the daemon
 * answers something retryable, or the wake's batch budget is spent.
 * @param {WebExtApi} api
 * @returns {Promise<{ drained: number }>} rows the daemon acknowledged
 */
async function flushOnce(api) {
	const storage = api.storage.local;
	const settings = await loadSettings(storage);
	if (!settings.enabled) {
		return { drained: 0 };
	}
	let drained = 0;
	let tune = await loadTune(storage);
	const streams = await loadStreams(storage);
	let state = await snapshot(storage);
	const status = await loadStatus(storage);
	let accepted = status.accepted;
	let duplicates = status.duplicates;
	let daemonVersion = status.daemon_version;
	let lastAckAt = status.last_ack_at;
	let rejected = status.rejected_batches;
	for (let round = 0; round < MAX_BATCHES_PER_WAKE; round += 1) {
		const stream = nextStream(state.meta);
		if (stream === null) {
			break;
		}
		const batch = await take(storage, stream, {
			rows: tune.batch_rows,
			bytes: tune.batch_bytes,
		});
		if (batch === null) {
			break;
		}
		const envelope = buildEnvelope({
			stream,
			batch,
			acked: state.meta[stream].acked,
			checkpoint: checkpointFor({ streams, meta: state.meta, stream }),
			records: batch.records.map((record) => record.body),
		});
		const began = Date.now();
		const result = await postBatch({
			fetchImpl: fetch,
			origin: settings.daemon_url,
			key: settings.key,
			envelope,
		});
		const elapsed = Date.now() - began;
		const tuned = tuneAfterCall(tune, elapsed, {});
		tune = tuned.tune;
		if (result.kind === "retry") {
			await mergeStatus(storage, {
				last_error: result.reason ?? "retryable daemon answer",
				last_error_at: Date.now(),
				budget_misses:
					status.budget_misses + (elapsed > tune.budget_ms ? 1 : 0),
			});
			break;
		}
		if (result.kind === "reject") {
			// Reposting identical bytes cannot succeed. The batch is dropped after
			// being recorded, so one malformed row cannot wedge the whole stream
			// (docs/d204 R10's last-error field is where it stays visible).
			rejected += 1;
			await mergeStatus(storage, {
				last_error: result.reason ?? "daemon rejected the batch",
				last_error_at: Date.now(),
				rejected_batches: rejected,
			});
			state = { meta: await ack(storage, batch), total_bytes: state.total_bytes - batch.bytes };
			continue;
		}
		state = { meta: await ack(storage, batch), total_bytes: state.total_bytes - batch.bytes };
		drained += batch.records.length;
		advanceVisitCheckpoint(state.meta, streams);
		accepted += result.accepted ?? 0;
		duplicates += result.duplicates ?? 0;
		daemonVersion = result.version ?? daemonVersion;
		lastAckAt = Date.now();
	}
	await saveStreams(storage, streams);
	await saveTune(storage, tune);
	await mergeStatus(storage, {
		started_at: status.started_at === 0 ? Date.now() : status.started_at,
		last_ack_at: lastAckAt,
		accepted,
		duplicates,
		daemon_version: daemonVersion,
		rejected_batches: rejected,
	});
	return { drained };
}

/**
 * One sweep: a backfill window, a flush, and the daily bookmark walk.
 * @param {WebExtApi} api
 * @returns {Promise<void>}
 */
async function sweepOnce(api) {
	const storage = api.storage.local;
	const settings = await loadSettings(storage);
	if (!settings.enabled) {
		return;
	}
	const tune = await loadTune(storage);
	const streams = await loadStreams(storage);
	const status = await loadStatus(storage);
	const result = await backfillPass({
		history: { search: api.history.search, getVisits: api.history.getVisits },
		storage,
		tune,
		streams,
		settings,
		queue_bytes: settings.queue_bytes,
		clock: Date.now,
	});
	await mergeStatus(storage, {
		budget_misses: status.budget_misses + (result.elapsed_ms > tune.budget_ms ? 1 : 0),
		evicted: status.evicted + (result.evicted ?? 0),
	});
	await saveStreams(storage, streams);
	await saveTune(storage, tune);
	const { drained } = await flushOnce(api);
	const walked = streams.bookmark.walked_at;
	if ((walked === null || Date.now() - walked > WALK_INTERVAL_MS) && drained > 0) {
		// A big profile completes over several sweeps: the walk is budgeted and its
		// resume point is durable, so the tree is never re-read from the start. The
		// budget is exactly what the flush just drained — a walk that enqueued more
		// than the daemon can absorb would fill the queue, evict rows, and restart
		// itself, which on a six-figure tree is a livelock rather than progress.
		await walkBookmarks({
			bookmarks: { getTree: api.bookmarks.getTree, get: api.bookmarks.get },
			storage,
			queue_bytes: settings.queue_bytes,
			streams,
			clock: Date.now,
			budget: drained,
		});
		await saveStreams(storage, streams);
		await flushOnce(api);
	}
	await retentionSweep(api, { storage, streams });
}

/**
 * The retention half of a sweep: prune what the archive already holds, remove
 * the GitHub repository-root bookmarks, and schedule the next scrub.
 *
 * WHY the schedule is two mechanisms again: a setTimeout is the only way to get
 * a 5-second cadence (an alarm's floor is a minute), and an alarm is the only
 * thing that survives the event page being suspended. So the fast lane is a
 * timer and the slow lane is an alarm, which is the same split the flush path
 * already documents.
 * @param {WebExtApi} api
 * @param {{ storage: StorageArea, streams: import("./state.mjs").Streams }} args
 * @returns {Promise<void>}
 */
async function retentionSweep(api, { storage, streams }) {
	const meta = await snapshot(storage);
	const pass = await retentionPass({
		history: { search: api.history.search, deleteRange: api.history.deleteRange },
		bookmarks: { getTree: api.bookmarks.getTree, remove: api.bookmarks.remove },
		storage,
		bookmarksSettled: streams.bookmark.walked_at !== null && meta.meta.bookmark.count === 0,
		archiveCursorMs: streams.visit.cursor_ms,
		now: Date.now(),
	});
	if (pass.decision.urgent) {
		// The fast lane: the minute alarm is the durable pace and one timer is
		// the accelerator, replaced rather than queued so a burst of sweeps
		// cannot stack callbacks.
		api.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
		// A rejected clear/creation is not worth failing the pass over: the next
		// wake re-derives both from the same state.
		api.alarms.clear(SCRUB_ALARM).catch(() => undefined);
		if (scrubTimer !== null) {
			clearTimeout(scrubTimer);
		}
		scrubTimer = setTimeout(() => {
			scrubTimer = null;
			run(api, () => sweepOnce(api));
		}, SCRUB_MIN_MS);
		return;
	}
	// The slow lane: the backoff has to reach the alarm, and the minute sweep
	// would otherwise keep probing every minute and make the cap decorative. So
	// the periodic alarm is dropped and one alarm is scheduled at the computed
	// delay; a live visit, a bookmark event, or a browser restart (which
	// re-creates the periodic alarm) puts the fast lane back.
	if (scrubTimer !== null) {
		clearTimeout(scrubTimer);
		scrubTimer = null;
	}
	api.alarms.clear(SWEEP_ALARM).catch(() => undefined);
	api.alarms.create(SCRUB_ALARM, {
		delayInMinutes: Math.max(1, Math.round(pass.decision.delayMs / 60_000)),
	});
}

/**
 * The alarm and startup path. Alarms do not survive a browser restart in Gecko
 * (they are nsITimer instances the extension's shutdown clears), so the alarm is
 * re-created on every load as well as on startup.
 * @param {WebExtApi} api
 * @returns {void}
 */
function ensureAlarm(api) {
	api.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
}

/**
 * @param {WebExtApi} api
 * @returns {void}
 */
function register(api) {
	api.history.onVisited.addListener((item) => {
		run(api, () => onVisited(api, /** @type {HistoryItem} */ (item)));
	});
	api.history.onTitleChanged.addListener((item) => {
		run(api, () =>
			onTitleChanged(api, /** @type {{ id: string, url: string, title: string }} */ (item)),
		);
	});
	api.history.onVisitRemoved.addListener((event) => {
		run(api, () =>
			onVisitRemoved(api, /** @type {{ allHistory: boolean, urls: string[] }} */ (event)),
		);
	});
	api.bookmarks.onCreated.addListener((_id, node) => {
		const record = createdRecord(/** @type {BookmarkNode} */ (node));
		if (record !== null) {
			run(api, () => queueRecord(api, record, "bookmark"));
		}
	});
	api.bookmarks.onChanged.addListener((id) => {
		run(api, async () => {
			const record = await changedRecord(
				{ getTree: api.bookmarks.getTree, get: api.bookmarks.get },
				String(id),
			);
			if (record !== null) {
				await queueRecord(api, record, "bookmark");
			}
		});
	});
	api.bookmarks.onMoved.addListener((id) => {
		run(api, async () => {
			const record = await changedRecord(
				{ getTree: api.bookmarks.getTree, get: api.bookmarks.get },
				String(id),
			);
			if (record !== null) {
				await queueRecord(api, record, "bookmark");
			}
		});
	});
	api.bookmarks.onRemoved.addListener((id, info) => {
		run(api, async () => {
			// The retention pass removes GitHub repository roots itself. That
			// removal raises this same event and must not become a tombstone: a
			// bookmark tombstone is an erase instruction, and the row it would
			// erase is the one the pass just archived.
			const scrub = await loadScrub(api.storage.local);
			if (consumeOwnBookmarkRemoval(scrub, String(id), Date.now())) {
				await saveScrub(api.storage.local, scrub);
				return;
			}
			const record = removedRecord(
				/** @type {{ parentId: string, index: number, node?: BookmarkNode }} */ (info),
				Date.now(),
			);
			if (record !== null) {
				await queueRecord(api, record, "tombstone");
			}
		});
	});
	api.alarms.onAlarm.addListener((alarm) => {
		const named = /** @type {{ name?: string }} */ (alarm);
		if (named.name === SWEEP_ALARM || named.name === SCRUB_ALARM) {
			run(api, () => sweepOnce(api));
		}
	});
	api.runtime.onInstalled.addListener(() => {
		ensureAlarm(api);
		// The first-run screen is the consent gate: install alone captures nothing.
		api.runtime.openOptionsPage().catch((error) => reportError(api, error));
	});
	api.runtime.onStartup.addListener(() => {
		ensureAlarm(api);
		run(api, () => sweepOnce(api));
	});
}

const api = webext();
if (api !== null) {
	register(api);
	ensureAlarm(api);
	run(api, () => sweepOnce(api));
}
