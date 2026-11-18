/**
 * @fileoverview bookmarks.mjs — the bookmark producer: the tree snapshot, the
 * four event shapes, and folder-cascade tombstones (docs/d204's R3, and "The
 * streams").
 *
 * WHY the snapshot is one getTree call and not a per-folder walk: Firefox's
 * getChildren is implemented as getSubTree(root) internally (verified in
 * ext-bookmarks.js — the code carries a TODO for it), so "walking in folder
 * slices" would not bound the browser's work, only the extension's. The slice
 * this file does honour is the WRITE side: rows are enqueued in bounded chunks,
 * so no single storage write or JSON.stringify carries a whole profile.
 *
 * WHY the folder path is absent from the records: the facts are the parent guid
 * and the index. A path is a view over those, and storing it per row would make
 * every folder rename rewrite the subtree (docs/d205's bookmark row).
 */

import { bookmarkRecord, bookmarkTombstone } from "./wire.mjs";
import { enqueue } from "./queue.mjs";

/**
 * @typedef {object} BookmarkNode
 * @property {string} id guid
 * @property {string} title
 * @property {number} [index] absent on a node read back from a delta event
 * @property {number} [dateAdded] microseconds in an event payload, see wire.mjs
 * @property {string} type "bookmark" | "folder" | "separator"
 * @property {string} [url]
 * @property {string} [parentId]
 * @property {number} [dateGroupModified]
 * @property {BookmarkNode[]} [children]
 * @typedef {object} BookmarksApi
 * @property {() => Promise<BookmarkNode[]>} getTree
 * @property {(id: string) => Promise<BookmarkNode[]>} get
 */

/** One storage.local.set carries this many rows; see the fileoverview. */
const WALK_CHUNK = 200;

/**
 * The whole tree as bookmark rows, oldest first. The synthetic root node is
 * kept: the five real roots name it as their parent, so dropping it would leave
 * dangling parent ids in the daemon's path view.
 * @param {BookmarkNode[]} tree
 * @returns {Record<string, unknown>[]}
 */
export function bookmarkRecordsFromTree(tree) {
	/** @type {Record<string, unknown>[]} */
	const records = [];
	/** @param {BookmarkNode} node @returns {void} */
	const visit = (node) => {
		const record = bookmarkRecord(node, "walk");
		if (record !== null) {
			records.push(record);
		}
		for (const child of node.children ?? []) {
			visit(child);
		}
	};
	for (const root of tree) {
		visit(root);
	}
	records.sort(byDateAdded);
	return records;
}

/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {number}
 */
function byDateAdded(left, right) {
	const a = typeof left.date_added === "number" ? left.date_added : 0;
	const b = typeof right.date_added === "number" ? right.date_added : 0;
	if (a === b) {
		return String(left.key) < String(right.key) ? -1 : 1;
	}
	return a - b;
}

/**
 * Rows one sweep may walk. A profile with a hundred thousand bookmarks is the
 * case this exists for: the snapshot is idempotent but its rows are not free —
 * each one is a storage write, and a queue that cannot hold them all would
 * evict and then re-walk the same tree on every sweep. The walk therefore keeps
 * a durable cursor and finishes over several sweeps.
 */
const WALK_BUDGET = 2000;

/**
 * Whether a record sorts after the walk's resume point. The comparator is the
 * same one the snapshot is sorted by, so the cursor is exact even when several
 * bookmarks share a millisecond.
 * @param {Record<string, unknown>} record
 * @param {import("./state.mjs").BookmarkWalk} walk
 * @returns {boolean}
 */
function afterCursor(record, walk) {
	if (walk.after_date_added === null || walk.after_key === null) {
		return true;
	}
	const added = typeof record.date_added === "number" ? record.date_added : 0;
	if (added !== walk.after_date_added) {
		return added > walk.after_date_added;
	}
	return String(record.key) > walk.after_key;
}

/**
 * @param {object} args
 * @param {BookmarksApi} args.bookmarks
 * @param {import("./queue.mjs").StorageArea} args.storage
 * @param {number} args.queue_bytes
 * @param {import("./state.mjs").Streams} args.streams
 * @param {() => number} args.clock
 * @param {number} [args.budget] rows this call may enqueue
 * @returns {Promise<{ records: number, remaining: number, done: boolean, elapsed_ms: number, evicted: number }>}
 */
export async function walkBookmarks(args) {
	const began = args.clock();
	if ((args.budget ?? WALK_BUDGET) <= 0) {
		// No drained capacity means no room for a bookmark row; reading the tree
		// on a six-figure profile just to walk zero rows is the cost this guards.
		return { records: 0, remaining: 0, done: false, elapsed_ms: 0, evicted: 0 };
	}
	const tree = await args.bookmarks.getTree();
	const records = bookmarkRecordsFromTree(tree).filter((record) =>
		afterCursor(record, args.streams.bookmark),
	);
	const slice = records.slice(0, args.budget ?? WALK_BUDGET);
	let evicted = 0;
	for (let offset = 0; offset < slice.length; offset += WALK_CHUNK) {
		const chunk = slice.slice(offset, offset + WALK_CHUNK);
		const result = await enqueue(
			args.storage,
			chunk.map((body) => ({ stream: /** @type {const} */ ("bookmark"), body })),
			args.queue_bytes,
		);
		evicted += result.evicted.bookmark ?? 0;
	}
	const last = slice.at(-1);
	if (last !== undefined) {
		args.streams.bookmark.after_date_added =
			typeof last.date_added === "number" ? last.date_added : 0;
		args.streams.bookmark.after_key = String(last.key);
	}
	const done = slice.length === records.length;
	if (done) {
		args.streams.bookmark.walked_at = args.clock();
		args.streams.bookmark.after_date_added = null;
		args.streams.bookmark.after_key = null;
	}
	if (evicted > 0) {
		// A dropped bookmark row would be skipped by the cursor, so the walk
		// restarts instead: the same rows come back, and the daemon absorbs them.
		args.streams.bookmark.walked_at = null;
		args.streams.bookmark.after_date_added = null;
		args.streams.bookmark.after_key = null;
	}
	return {
		records: slice.length,
		remaining: records.length - slice.length,
		done,
		elapsed_ms: args.clock() - began,
		evicted,
	};
}

/**
 * @param {BookmarkNode} node
 * @returns {Record<string, unknown> | null}
 */
export function createdRecord(node) {
	return bookmarkRecord(node, "event");
}

/**
 * A change or move event carries only the delta, so the row is read back whole:
 * one get per event, and the row the daemon receives stays complete enough to
 * apply out of order.
 * @param {BookmarksApi} bookmarks
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function changedRecord(bookmarks, id) {
	const found = await bookmarks.get(id);
	const node = found[0];
	return node === undefined ? null : bookmarkRecord(node, "event");
}

/**
 * @param {{ parentId: string, index: number, node?: BookmarkNode }} info
 * @param {number} now
 * @returns {Record<string, unknown> | null}
 */
export function removedRecord(info, now) {
	const node = info.node;
	if (node === undefined || typeof node.id !== "string") {
		return null;
	}
	if (node.type !== "bookmark" && node.type !== "folder") {
		return null;
	}
	return bookmarkTombstone(
		{
			id: node.id,
			parent_id: typeof node.parentId === "string" ? node.parentId : info.parentId,
			node_type: node.type,
			url: typeof node.url === "string" ? node.url : "",
			title: typeof node.title === "string" ? node.title : "",
		},
		now,
	);
}
