/**
 * @fileoverview state.mjs — the durable state beside the queue: per-stream
 * checkpoints, the adaptive batch knobs, and the status line the operator reads.
 *
 * WHY the checkpoints live here and not in the queue meta: a checkpoint is a
 * statement about what the DAEMON acknowledged, so it is written only in the
 * ack path (docs/d204 SLURP-R9), while the queue meta moves on every enqueue.
 * Keeping the two apart is what makes an interrupted flush resumable.
 *
 * WHY the knobs are persisted at all: the 5-second budget (docs/d204) is a
 * target measured per call, and the measured size must survive the background
 * page being suspended — a process-local size would restart every wake at the
 * default and never converge on a profile.
 */

const STREAMS_KEY = "streams";
const TUNE_KEY = "tune";
const STATUS_KEY = "status";

/**
 * @typedef {object} VisitCursor
 * @property {number | null} cursor_ms every visit at or before this instant is acked
 * @property {{ window_end: number, seq_high: number } | null} pending the window in flight
 * @property {number | null} repaired_at last trailing re-read
 */

/**
 * @typedef {object} BookmarkWalk
 * @property {number | null} walked_at last COMPLETED walk
 * @property {number | null} after_date_added resume point, or null when no walk is open
 * @property {string | null} after_key tie-breaker for the same millisecond
 * @typedef {object} Streams
 * @property {VisitCursor} visit
 * @property {BookmarkWalk} bookmark
 */

/**
 * @typedef {object} Tune
 * @property {number} window_ms backfill time window
 * @property {number} page_size history.search maxResults
 * @property {number} batch_rows rows per posted batch
 * @property {number} batch_bytes bytes per posted batch
 * @property {number} visit_cap per-URL getVisits expansion ceiling
 * @property {number} budget_ms the soft ceiling every pass is measured against
 */

/** @type {Readonly<Tune>} */
export const TUNE_DEFAULTS = {
	window_ms: 3_600_000,
	page_size: 100,
	batch_rows: 200,
	batch_bytes: 262_144,
	visit_cap: 500,
	budget_ms: 5000,
};

/**
 * The knobs' bounds: a value outside these is a typo, not a preference.
 * @type {Record<keyof Tune, [number, number]>}
 */
const TUNE_BOUNDS = {
	window_ms: [60_000, 604_800_000],
	page_size: [25, 500],
	batch_rows: [50, 1000],
	batch_bytes: [65_536, 4_194_304],
	visit_cap: [50, 5000],
	budget_ms: [1000, 60_000],
};

/** @returns {Streams} */
export function emptyStreams() {
	return {
		visit: { cursor_ms: null, pending: null, repaired_at: null },
		bookmark: { walked_at: null, after_date_added: null, after_key: null },
	};
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
	return typeof value === "object" && value !== null;
}

/** @param {unknown} value @returns {number | null} */
function numberOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} stored
 * @returns {Streams}
 */
function resolveStreams(stored) {
	const streams = emptyStreams();
	if (!isRecord(stored)) {
		return streams;
	}
	const visit = isRecord(stored.visit) ? stored.visit : {};
	const bookmark = isRecord(stored.bookmark) ? stored.bookmark : {};
	streams.visit.cursor_ms = numberOrNull(visit.cursor_ms);
	streams.visit.repaired_at = numberOrNull(visit.repaired_at);
	streams.bookmark.walked_at = numberOrNull(bookmark.walked_at);
	streams.bookmark.after_date_added = numberOrNull(bookmark.after_date_added);
	streams.bookmark.after_key =
		typeof bookmark.after_key === "string" ? bookmark.after_key : null;
	const pending = visit.pending;
	if (isRecord(pending)) {
		const windowEnd = numberOrNull(pending.window_end);
		const seqHigh = numberOrNull(pending.seq_high);
		if (windowEnd !== null && seqHigh !== null) {
			streams.visit.pending = { window_end: windowEnd, seq_high: seqHigh };
		}
	}
	return streams;
}

/**
 * @param {import("./queue.mjs").StorageArea} storage
 * @returns {Promise<Streams>}
 */
export async function loadStreams(storage) {
	const got = await storage.get(STREAMS_KEY);
	return resolveStreams(got[STREAMS_KEY]);
}

/**
 * @param {import("./queue.mjs").StorageArea} storage
 * @param {Streams} streams
 * @returns {Promise<void>}
 */
export async function saveStreams(storage, streams) {
	await storage.set({ [STREAMS_KEY]: streams });
}

/**
 * @param {number} value
 * @param {[number, number]} bounds
 * @returns {number}
 */
function clamp(value, bounds) {
	const [low, high] = bounds;
	return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * @param {unknown} stored
 * @returns {Tune}
 */
function resolveTune(stored) {
	const raw = isRecord(stored) ? stored : {};
	/** @type {Tune} */
	const tune = { ...TUNE_DEFAULTS };
	for (const key of /** @type {readonly (keyof Tune)[]} */ (Object.keys(tune))) {
		const value = raw[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			tune[key] = clamp(value, TUNE_BOUNDS[key]);
		}
	}
	return tune;
}

/**
 * @param {import("./queue.mjs").StorageArea} storage
 * @returns {Promise<Tune>}
 */
export async function loadTune(storage) {
	const got = await storage.get(TUNE_KEY);
	return resolveTune(got[TUNE_KEY]);
}

/**
 * @param {import("./queue.mjs").StorageArea} storage
 * @param {Tune} tune
 * @returns {Promise<void>}
 */
export async function saveTune(storage, tune) {
	await storage.set({ [TUNE_KEY]: resolveTune(tune) });
}

/**
 * The batch policy d204 states as a requirement: a call that misses the budget
 * shrinks the next one, one that finishes far inside it grows. Growth is slower
 * than the shrink on purpose — an overshoot costs a stalled browser, an
 * undershoot only more passes.
 * @param {Tune} tune
 * @param {number} elapsed_ms
 * @param {{ saturated?: boolean }} [observed] a search page that filled up may hide older rows
 * @returns {{ tune: Tune, action: "shrink" | "grow" | "hold" }}
 */
export function tuneAfterCall(tune, elapsed_ms, observed) {
	if (observed?.saturated === true || elapsed_ms > tune.budget_ms) {
		return {
			action: "shrink",
			tune: {
				...tune,
				window_ms: tune.window_ms / 2,
				page_size: tune.page_size / 2,
				batch_rows: tune.batch_rows / 2,
				batch_bytes: tune.batch_bytes / 2,
			},
		};
	}
	if (elapsed_ms < tune.budget_ms / 4) {
		return {
			action: "grow",
			tune: {
				...tune,
				window_ms: tune.window_ms * 2,
				page_size: tune.page_size * 1.5,
				batch_rows: tune.batch_rows * 1.5,
				batch_bytes: tune.batch_bytes * 2,
			},
		};
	}
	return { action: "hold", tune };
}

/**
 * @typedef {object} Status
 * @property {number} started_at
 * @property {number | null} last_ack_at
 * @property {string} last_error
 * @property {number | null} last_error_at
 * @property {number} accepted
 * @property {number} duplicates
 * @property {string} daemon_version
 * @property {number} evicted
 * @property {number} budget_misses
 * @property {number} rejected_batches
 */

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function numberField(raw, key, fallback) {
	const value = numberOrNull(raw[key]);
	return value === null ? fallback : value;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function stringField(raw, key, fallback) {
	const value = raw[key];
	return typeof value === "string" ? value : fallback;
}

/**
 * @param {unknown} stored
 * @returns {Status}
 */
function resolveStatus(stored) {
	const raw = isRecord(stored) ? stored : {};
	return {
		started_at: numberField(raw, "started_at", 0),
		last_ack_at: numberOrNull(raw.last_ack_at),
		last_error: stringField(raw, "last_error", ""),
		last_error_at: numberOrNull(raw.last_error_at),
		accepted: numberField(raw, "accepted", 0),
		duplicates: numberField(raw, "duplicates", 0),
		daemon_version: stringField(raw, "daemon_version", ""),
		evicted: numberField(raw, "evicted", 0),
		budget_misses: numberField(raw, "budget_misses", 0),
		rejected_batches: numberField(raw, "rejected_batches", 0),
	};
}

/**
 * @param {import("./queue.mjs").StorageArea} storage
 * @returns {Promise<Status>}
 */
export async function loadStatus(storage) {
	const got = await storage.get(STATUS_KEY);
	return resolveStatus(got[STATUS_KEY]);
}

/**
 * A status patch merged into the stored one. Serialized by the caller (the
 * background page's single flush), so a read-modify-write cannot interleave.
 * @param {import("./queue.mjs").StorageArea} storage
 * @param {Partial<Status>} patch
 * @returns {Promise<Status>}
 */
export async function mergeStatus(storage, patch) {
	const current = await loadStatus(storage);
	const merged = { ...current, ...patch };
	await storage.set({ [STATUS_KEY]: merged });
	return merged;
}

