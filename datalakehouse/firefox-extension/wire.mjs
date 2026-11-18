/**
 * @fileoverview wire.mjs — the producer's half of the browsing ingest contract:
 * the record shapes, the batch envelope, and the transport's three outcomes.
 *
 * The daemon end of this contract is docs/d204's "The daemon boundary" plus the
 * wire section it now carries. Two rules there shape every line here: the
 * producer sends RAW URLs (canonicalization is the daemon's job), and every
 * record carries its stream's natural identity, never a tab id or a local row
 * number.
 *
 * WHY the visit key is (url, visit time) and not the visit id Firefox also
 * offers: getVisits returns moz_historyvisits.id, a local SQLite row number. It
 * is not synced, it is renumbered by a profile rebuild, and the live event does
 * not carry it at all. A visit's URL and its millisecond timestamp are the only
 * two facts both paths agree on — and the pair also survives a profile export.
 */

const SCHEMA = 1;
const PRODUCER = "agentcontainer-slurp/0.1.0";
const ENDPOINT = "/ingest/slurp";

/** d204's tombstone sources, in the producer's vocabulary. */
const SRC_HISTORY = "firefox-history";
const SRC_BOOKMARKS = "firefox-bookmarks";

/**
 * The schemes d204 excludes. A whitelist rather than a blacklist: an
 * unanticipated internal scheme must be dropped, not archived.
 * @param {unknown} url
 * @returns {url is string}
 */
export function isCapturable(url) {
	return (
		typeof url === "string" &&
		(url.startsWith("http://") || url.startsWith("https://"))
	);
}

/**
 * Places hands extensions two time units for the same fact: getTree converts to
 * milliseconds, while the bookmark event payload passes the raw PRTime
 * microseconds through (verified against ext-bookmarks.js, docs/d204). A
 * microsecond value cannot be mistaken for a millisecond one — the boundary is
 * five orders of magnitude away — so the value decides its own unit.
 * @param {number} value
 * @returns {number}
 */
export function placesTimeMs(value) {
	return Math.round(value > 1e14 ? value / 1000 : value);
}

/**
 * @param {string} url
 * @param {number} visitTime
 * @returns {string}
 */
export function visitKey(url, visitTime) {
	return JSON.stringify([url, visitTime]);
}

/**
 * @param {string} pageId
 * @returns {string}
 */
export function titleKey(pageId) {
	return `title:${pageId}`;
}

/**
 * @typedef {object} VisitFields
 * @property {string} url
 * @property {number} visit_time milliseconds since the epoch
 * @property {string} [title]
 * @property {string} [transition]
 * @property {string} [page_id] the sync-stable page guid
 * @property {string} [visit_id] the local visit row number, informational only
 * @property {"live" | "backfill" | "backfill-coarse"} via
 */

/**
 * A visit row. transition and referring visit are only available from
 * getVisits, so a live row (onVisited) omits them and the backfill sweep fills
 * them in later under the same key (docs/d204's "Adaptive batching").
 * @param {VisitFields} fields
 * @returns {Record<string, unknown>}
 */
export function visitRecord(fields) {
	return {
		src: SRC_HISTORY,
		kind: "visit",
		key: visitKey(fields.url, fields.visit_time),
		url: fields.url,
		visit_time: fields.visit_time,
		title: fields.title ?? "",
		via: fields.via,
		...(fields.transition === undefined ? {} : { transition: fields.transition }),
		...(fields.page_id === undefined ? {} : { page_id: fields.page_id }),
		...(fields.visit_id === undefined ? {} : { visit_id: fields.visit_id }),
	};
}

/**
 * A page-title fact. Keyed on the page guid, not on a visit: the title belongs
 * to the page, and a title learned today must not create a visit (docs/d204's
 * onTitleChanged note).
 * @param {{ page_id: string, url: string, title: string, seen_at: number }} fields
 * @returns {Record<string, unknown>}
 */
export function titleRecord(fields) {
	return {
		src: SRC_HISTORY,
		kind: "title",
		key: titleKey(fields.page_id),
		url: fields.url,
		title: fields.title,
		seen_at: fields.seen_at,
		via: "event",
	};
}

/**
 * The bookmark surface this file reads, spelled locally because bookmarks.mjs
 * imports this module (a JSDoc import back would be a cycle).
 * @typedef {object} BookmarkNodeLike
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [type]
 * @property {number} [index]
 * @property {number} [dateAdded]
 * @property {string} [url]
 * @property {string} [parentId]
 * @property {number} [dateGroupModified]
 * @property {BookmarkNodeLike[]} [children]
 */

/**
 * A bookmark or folder row. The folder path is NOT carried: the facts are the
 * parent guid and the index, and the path is a view the daemon derives from the
 * parent chain it also stores (docs/d205's bookmark row).
 * @param {BookmarkNodeLike} node a bookmarks.BookmarkTreeNode
 * @param {"walk" | "event"} via
 * @returns {Record<string, unknown> | null}
 */
export function bookmarkRecord(node, via) {
	if (typeof node.id !== "string" || typeof node.type !== "string") {
		return null;
	}
	if (node.type !== "bookmark" && node.type !== "folder") {
		return null;
	}
	const parentId = typeof node.parentId === "string" ? node.parentId : "";
	return {
		src: SRC_BOOKMARKS,
		kind: "bookmark",
		key: node.id,
		node_type: node.type,
		url: node.type === "bookmark" && isCapturable(node.url) ? node.url : null,
		title: typeof node.title === "string" ? node.title : "",
		parent_id: parentId,
		position: typeof node.index === "number" ? node.index : 0,
		date_added: typeof node.dateAdded === "number" ? placesTimeMs(node.dateAdded) : 0,
		date_modified:
			typeof node.dateGroupModified === "number"
				? placesTimeMs(node.dateGroupModified)
				: null,
		via,
	};
}

/**
 * A removal. onRemoved reports the removed item only — a folder's descendants
 * arrive as isDescendantRemoval events the API filters out — so a folder
 * tombstone is marked cascade and the daemon drops the subtree below the same
 * key.
 * @param {{ id: string, parent_id: string, node_type: string, url: string, title: string }} removed
 * @param {number} deletedAt
 * @returns {Record<string, unknown>}
 */
export function bookmarkTombstone(removed, deletedAt) {
	return {
		src: SRC_BOOKMARKS,
		kind: "bookmark-removed",
		key: removed.id,
		node_type: removed.node_type,
		url: removed.url,
		title: removed.title,
		parent_id: removed.parent_id,
		cascade: removed.node_type === "folder",
		deleted_at: deletedAt,
		source: "bookmark",
	};
}

/**
 * The history deletion surface. Firefox reports (event.allHistory, urls): a
 * page-level removal with no visit, time or origin detail, and "everything"
 * when the user clears history — verified against ext-history.js, docs/d204.
 * A local row is therefore only ever page-granular, and the clear marker is
 * sent as a mark rather than expanded into deletions: the archive keeps the
 * rows until the backend's retention rule decides (docs/d205's pending issue).
 * @param {{ allHistory: boolean, urls: string[] }} event
 * @param {number} deletedAt
 * @returns {Record<string, unknown>[]}
 */
export function historyRemovalRecords(event, deletedAt) {
	if (event.allHistory) {
		return [
			{
				src: SRC_HISTORY,
				kind: "history-cleared",
				key: "*",
				deleted_at: deletedAt,
				source: "local",
			},
		];
	}
	return event.urls.filter(isCapturable).map((url) => ({
		src: SRC_HISTORY,
		kind: "visit-removed",
		key: url,
		url,
		deleted_at: deletedAt,
		source: "local",
	}));
}

/**
 * @param {object} args
 * @param {string} args.stream
 * @param {{ seq_low: number, seq_high: number }} args.batch
 * @param {number} args.acked highest sequence the daemon has acknowledged
 * @param {Record<string, unknown> | null} [args.checkpoint] the stream's checkpoint value
 * @param {Record<string, unknown>[]} args.records
 * @returns {Record<string, unknown>}
 */
export function buildEnvelope(args) {
	return {
		schema: SCHEMA,
		producer: PRODUCER,
		stream: args.stream,
		stream_seq: {
			low: args.batch.seq_low,
			high: args.batch.seq_high,
			acked: args.acked,
		},
		checkpoint: args.checkpoint ?? null,
		records: args.records,
	};
}

/**
 * @typedef {object} PostResult
 * @property {"ack" | "retry" | "reject"} kind
 * @property {number} [status]
 * @property {number} [accepted]
 * @property {number} [duplicates]
 * @property {string} [version]
 * @property {string} [reason]
 */

/**
 * Posts one batch and classifies the answer: 2xx is the ack d204 requires, a
 * 4xx that is not a retryable status is a permanent reject (reposting the same
 * bytes cannot succeed), everything else is retryable.
 * @param {object} args
 * @param {(input: string, init: { method: string, headers: Record<string, string>, body: string, signal: AbortSignal }) => Promise<Response>} args.fetchImpl
 * @param {string} args.origin
 * @param {string} args.key "" sends no Authorization header
 * @param {Record<string, unknown>} args.envelope
 * @param {number} [args.timeoutMs]
 * @returns {Promise<PostResult>}
 */
export async function postBatch(args) {
	/** @type {Record<string, string>} */
	const headers = {
		"content-type": "application/json",
		accept: "application/json",
	};
	if (args.key !== "") {
		headers.authorization = `Bearer ${args.key}`;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 15_000);
	try {
		const response = await args.fetchImpl(args.origin + ENDPOINT, {
			method: "POST",
			headers,
			body: JSON.stringify(args.envelope),
			signal: controller.signal,
		});
		const text = await response.text();
		if (response.ok) {
			const body = parseJson(text);
			return {
				kind: "ack",
				status: response.status,
				accepted: typeof body?.accepted === "number" ? body.accepted : 0,
				duplicates: typeof body?.duplicates === "number" ? body.duplicates : 0,
				version: typeof body?.version === "string" ? body.version : "",
			};
		}
		const retryable =
			response.status === 408 ||
			response.status === 425 ||
			response.status === 429 ||
			response.status >= 500;
		return {
			kind: retryable ? "retry" : "reject",
			status: response.status,
			reason: `daemon answered ${response.status}: ${clip(text)}`,
		};
	} catch (error) {
		return { kind: "retry", reason: `transport: ${describe(error)}` };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseJson(text) {
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null
			? /** @type {Record<string, unknown>} */ (parsed)
			: null;
	} catch {
		return null;
	}
}

/**
 * @param {string} text
 * @returns {string}
 */
function clip(text) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

export { describe };
