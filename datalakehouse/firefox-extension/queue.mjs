/**
 * @fileoverview queue.mjs — the durable, bounded, per-stream queue that stands
 * between a Firefox event and the daemon's ack (docs/d204 SLURP-R4/R8/R9).
 *
 * WHY per-stream storage keys rather than one array: a storage value is read and
 * written whole, so a single array would re-serialize megabytes on every visit.
 * An append here is one record write plus a ~200-byte meta write, and the ack is
 * a delete of exactly the rows the daemon absorbed — which is also the moment
 * the stream's checkpoint may move.
 *
 * WHY a stream, not a kind: the daemon acknowledges one batch at a time and the
 * checkpoint advances only over acknowledged rows, so a batch is single-stream
 * and the streams stay independently resumable (docs/d204's "The streams").
 *
 * WHY the tombstone queue is evicted last: a dropped visit or bookmark is
 * re-derivable from the browser's own store by the backfill sweep or the
 * bookmark walk. A removal is not — it is the only trace that the row ever
 * existed on this device.
 */

const META_KEY = "qmeta";

/**
 * @typedef {"visit" | "bookmark" | "title" | "tombstone"} StreamName
 * @typedef {object} StreamMeta
 * @property {number} head lowest live sequence number
 * @property {number} tail highest sequence number ever written
 * @property {number} acked highest sequence number the daemon acknowledged
 * @property {number} count live records
 * @property {number} bytes live payload bytes
 * @typedef {Record<StreamName, StreamMeta>} QueueMeta
 * @typedef {{ stream: StreamName, body: Record<string, unknown> }} QueuedRecord
 * @typedef {{ seq: number, body: Record<string, unknown> }} SeqRecord
 * @typedef {object} Batch
 * @property {StreamName} stream
 * @property {SeqRecord[]} records
 * @property {number} seq_low
 * @property {number} seq_high
 * @property {number} bytes
 */

/**
 * The storage.local surface the queue writes through: one shape for every
 * consumer, so a caller's narrower annotation cannot silently narrow the queue's.
 * @typedef {object} StorageArea
 * @property {(keys: string | string[]) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/** @type {readonly StreamName[]} */
const STREAMS = ["visit", "bookmark", "title", "tombstone"];

/** Cheapest to lose first; see the fileoverview. @type {readonly StreamName[]} */
const EVICT_ORDER = ["visit", "title", "bookmark", "tombstone"];

/** Test suite's estimate; the real one is measured, not derived. */
const encoder = new TextEncoder();

/**
 * @param {Record<string, unknown>} body
 * @returns {number}
 */
function bytesOf(body) {
	return encoder.encode(JSON.stringify(body)).length;
}

/**
 * @param {StreamName} stream
 * @param {number} seq
 * @returns {string}
 */
function recordKey(stream, seq) {
	return `q:${stream}:${seq}`;
}

/** @returns {StreamMeta} */
function emptyStreamMeta() {
	return { head: 1, tail: 0, acked: 0, count: 0, bytes: 0 };
}

/** @returns {QueueMeta} */
function emptyMeta() {
	return {
		visit: emptyStreamMeta(),
		bookmark: emptyStreamMeta(),
		title: emptyStreamMeta(),
		tombstone: emptyStreamMeta(),
	};
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
	return typeof value === "object" && value !== null;
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function count(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * @param {unknown} stored
 * @returns {QueueMeta}
 */
function resolveMeta(stored) {
	const meta = emptyMeta();
	if (!isRecord(stored)) {
		return meta;
	}
	for (const stream of STREAMS) {
		const raw = stored[stream];
		if (!isRecord(raw)) {
			continue;
		}
		meta[stream] = {
			head: count(raw.head, 1),
			tail: count(raw.tail, 0),
			acked: count(raw.acked, 0),
			count: count(raw.count, 0),
			bytes: count(raw.bytes, 0),
		};
	}
	return meta;
}

/**
 * @param {{ get: (keys: string | string[]) => Promise<Record<string, unknown>> }} storage
 * @returns {Promise<QueueMeta>}
 */
async function readMeta(storage) {
	const got = await storage.get(META_KEY);
	return resolveMeta(got[META_KEY]);
}

/**
 * @param {QueueMeta} meta
 * @returns {number}
 */
function totalBytes(meta) {
	let total = 0;
	for (const stream of STREAMS) {
		total += meta[stream].bytes;
	}
	return total;
}

/**
 * @param {QueueMeta} meta
 * @param {Record<string, number>} floors the sequence each stream's new rows start at
 * @returns {StreamName | null}
 */
function pickVictim(meta, floors) {
	for (const stream of EVICT_ORDER) {
		const live = meta[stream];
		if (live.count > 0 && live.head < (floors[stream] ?? Number.POSITIVE_INFINITY) && live.bytes > 0) {
			return stream;
		}
	}
	for (const stream of EVICT_ORDER) {
		const live = meta[stream];
		if (live.count > 0 && live.head < (floors[stream] ?? Number.POSITIVE_INFINITY)) {
			return stream;
		}
	}
	return null;
}

/**
 * Drops the oldest records until the queue fits the ceiling. Rows of the batch
 * being enqueued are never victims (that is what the floors are), so the ceiling
 * is soft by at most one batch — evicting a row that was just accepted would
 * turn a burst into a rewrite loop. Bounded so one pathological write cannot
 * spin: the next enqueue continues the trim.
 * @param {StorageArea} storage
 * @param {QueueMeta} meta
 * @param {number} limitBytes
 * @param {Record<string, number>} floors
 * @returns {Promise<Record<string, number>>} evicted count per stream
 */
async function evictTo(storage, meta, limitBytes, floors) {
	/** @type {Record<string, number>} */
	const evicted = {};
	let total = totalBytes(meta);
	let guard = 0;
	while (total > limitBytes && guard < 2000) {
		guard += 1;
		const stream = pickVictim(meta, floors);
		if (stream === null) {
			break;
		}
		const live = meta[stream];
		const key = recordKey(stream, live.head);
		const got = await storage.get(key);
		const body = got[key];
		const size = isRecord(body) ? bytesOf(body) : 0;
		await storage.remove([key]);
		live.head += 1;
		live.count = Math.max(0, live.count - 1);
		live.bytes = Math.max(0, live.bytes - size);
		total -= size;
		evicted[stream] = (evicted[stream] ?? 0) + 1;
	}
	return evicted;
}

/**
 * @param {Record<string, number>} into
 * @param {Record<string, number>} from
 * @returns {Record<string, number>}
 */
function mergeEvicted(into, from) {
	for (const [stream, count] of Object.entries(from)) {
		into[stream] = (into[stream] ?? 0) + count;
	}
	return into;
}

/**
 * Appends records and trims the queue to the ceiling. The records are written
 * before the meta so a crash between the two leaves an invisible record rather
 * than a queue that claims rows it does not have. A quota error is the one case
 * where the trim has to happen first: the store refused the write, so the
 * oldest rows go, and the write is retried once.
 * @param {StorageArea} storage
 * @param {QueuedRecord[]} records
 * @param {number} limitBytes
 * @returns {Promise<{ seqs: number[], evicted: Record<string, number> }>}
 */
export async function enqueue(storage, records, limitBytes) {
	/** @type {Record<string, unknown>} */
	const items = {};
	/** @type {number[]} */
	const seqs = [];
	const meta = await readMeta(storage);
	/** @type {Record<string, number>} */
	const floors = {};
	for (const record of records) {
		const live = meta[record.stream];
		if (floors[record.stream] === undefined) {
			floors[record.stream] = live.tail + 1;
		}
		live.tail += 1;
		live.count += 1;
		live.bytes += bytesOf(record.body);
		items[recordKey(record.stream, live.tail)] = record.body;
		seqs.push(live.tail);
	}
	if (seqs.length === 0) {
		return { seqs, evicted: {} };
	}
	/** @type {Record<string, number>} */
	let evicted = {};
	try {
		await storage.set(items);
	} catch {
		evicted = mergeEvicted(evicted, await evictTo(storage, meta, 0, floors));
		await storage.set(items);
	}
	evicted = mergeEvicted(evicted, await evictTo(storage, meta, limitBytes, floors));
	await storage.set({ [META_KEY]: meta });
	return { seqs, evicted };
}

/**
 * The oldest batch of one stream, bounded by rows and bytes. The first record is
 * always taken, so a single oversized row cannot starve the stream (docs/d204:
 * the cap is a target, and the miss is exposed rather than hidden).
 * @param {StorageArea} storage
 * @param {StreamName} stream
 * @param {{ rows: number, bytes: number }} limits
 * @returns {Promise<Batch | null>}
 */
export async function take(storage, stream, limits) {
	const meta = await readMeta(storage);
	const live = meta[stream];
	if (live.count <= 0) {
		return null;
	}
	const want = Math.max(1, Math.min(Math.round(limits.rows), live.count));
	/** @type {string[]} */
	const keys = [];
	for (let offset = 0; offset < want; offset += 1) {
		keys.push(recordKey(stream, live.head + offset));
	}
	const got = await storage.get(keys);
	/** @type {SeqRecord[]} */
	const records = [];
	let bytes = 0;
	for (let offset = 0; offset < keys.length; offset += 1) {
		const key = keys[offset];
		if (key === undefined) {
			continue;
		}
		const body = got[key];
		if (!isRecord(body)) {
			continue;
		}
		const size = bytesOf(body);
		if (records.length > 0 && bytes + size > limits.bytes) {
			break;
		}
		bytes += size;
		records.push({ seq: live.head + offset, body });
	}
	const first = records[0];
	const last = records.at(-1);
	if (first === undefined || last === undefined) {
		return null;
	}
	return {
		stream,
		records,
		seq_low: first.seq,
		seq_high: last.seq,
		bytes,
	};
}

/**
 * Removes an acknowledged batch and advances the stream's ack mark.
 * @param {StorageArea} storage
 * @param {Batch} batch
 * @returns {Promise<QueueMeta>}
 */
export async function ack(storage, batch) {
	const meta = await readMeta(storage);
	const live = meta[batch.stream];
	await storage.remove(batch.records.map((record) => recordKey(batch.stream, record.seq)));
	live.acked = Math.max(live.acked, batch.seq_high);
	live.count = Math.max(0, live.count - batch.records.length);
	live.bytes = Math.max(0, live.bytes - batch.bytes);
	live.head = Math.max(live.head, batch.seq_high + 1);
	await storage.set({ [META_KEY]: meta });
	return meta;
}

/**
 * @param {StorageArea} storage
 * @returns {Promise<{ meta: QueueMeta, total_bytes: number }>}
 */
export async function snapshot(storage) {
	const meta = await readMeta(storage);
	return { meta, total_bytes: totalBytes(meta) };
}

