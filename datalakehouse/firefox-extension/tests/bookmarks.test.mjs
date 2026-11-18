/**
 * @fileoverview The bookmark producer's contract (docs/d204 R3): the snapshot's
 * order and shape, the event rows read back whole, and the folder cascade.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	bookmarkRecordsFromTree,
	changedRecord,
	createdRecord,
	removedRecord,
	walkBookmarks,
} from "../bookmarks.mjs";
import { snapshot } from "../queue.mjs";
import { emptyStreams } from "../state.mjs";
import { createBookmarks, createStorage, queuedRecords } from "./fake-webext.mjs";

/** @type {import("../bookmarks.mjs").BookmarkNode} */
const TREE = {
	id: "root________",
	title: "",
	type: "folder",
	index: 0,
	dateAdded: 0,
	children: [
		{
			id: "toolbar_____",
			title: "Bookmarks Toolbar",
			type: "folder",
			index: 0,
			dateAdded: 1_600_000_000_000_000,
			children: [
				{ id: "sep", title: "", type: "separator", index: 0, url: "data:" },
				{
					id: "b2",
					title: "B2",
					type: "bookmark",
					index: 1,
					url: "https://b.example/",
					parentId: "toolbar_____",
					dateAdded: 1_700_000_000_000_000,
				},
			],
		},
		{
			id: "menu________",
			title: "Bookmarks Menu",
			type: "folder",
			index: 1,
			dateAdded: 1_500_000_000_000_000,
			children: [
				{
					id: "b1",
					title: "B1",
					type: "bookmark",
					index: 0,
					url: "https://a.example/",
					parentId: "menu________",
					dateAdded: 1_650_000_000_000_000,
				},
			],
		},
	],
};

test("the tree is flattened oldest-first, with roots kept and separators dropped", () => {
	const rows = bookmarkRecordsFromTree([TREE]);
	assert.deepEqual(
		rows.map((row) => row.key),
		["root________", "menu________", "toolbar_____", "b1", "b2"],
	);
	const b1 = rows.find((row) => row.key === "b1");
	assert.ok(b1);
	assert.equal(b1.date_added, 1_650_000_000_000, "microseconds became milliseconds");
	assert.equal(b1.parent_id, "menu________");
	assert.equal(b1.node_type, "bookmark");
	assert.equal(
		rows.some((row) => row.key === "sep"),
		false,
		"a separator is not a fact",
	);
});

test("the walk enqueues the snapshot and records when it ran", async () => {
	const bookmarks = createBookmarks(TREE);
	const storage = createStorage();
	const streams = emptyStreams();
	const result = await walkBookmarks({
		bookmarks,
		storage,
		queue_bytes: 1_000_000,
		streams,
		clock: () => 42,
	});
	assert.equal(result.records, 5);
	assert.equal(result.remaining, 0);
	assert.equal(result.done, true);
	assert.equal(result.evicted, 0);
	assert.equal(streams.bookmark.walked_at, 42);
	assert.equal(streams.bookmark.after_key, null);
	assert.equal(queuedRecords(storage).length, 5);
	const state = await snapshot(storage);
	assert.equal(state.meta.bookmark.count, 5);
});

test("a large tree is walked over several sweeps from a durable cursor", async () => {
	const bookmarks = createBookmarks(TREE);
	const storage = createStorage();
	const streams = emptyStreams();
	const walk = (/** @type {number} */ budget) =>
		walkBookmarks({
			bookmarks,
			storage,
			queue_bytes: 1_000_000,
			streams,
			clock: () => 42,
			budget,
		});

	const first = await walk(2);
	assert.deepEqual([first.records, first.remaining, first.done], [2, 3, false]);
	assert.equal(streams.bookmark.after_key, "menu________");
	assert.equal(streams.bookmark.walked_at, null);

	const second = await walk(2);
	assert.deepEqual([second.records, second.remaining, second.done], [2, 1, false]);
	assert.equal(streams.bookmark.after_key, "b1");

	const third = await walk(2);
	assert.deepEqual([third.records, third.remaining, third.done], [1, 0, true]);
	assert.equal(streams.bookmark.walked_at, 42);
	assert.equal(streams.bookmark.after_key, null);
	assert.equal(
		queuedRecords(storage).length,
		5,
		"each row crossed the queue exactly once",
	);
});

test("a created bookmark is normalised from the event's raw PRTime", () => {
	const row = createdRecord({
		id: "b3",
		title: "B3",
		type: "bookmark",
		index: 0,
		url: "https://c.example/",
		parentId: "menu________",
		dateAdded: 1_700_000_000_000_000,
	});
	assert.ok(row);
	assert.equal(row.date_added, 1_700_000_000_000);
	assert.equal(row.via, "event");
});

test("a change or move reads the row back whole", async () => {
	const bookmarks = createBookmarks(TREE);
	const row = await changedRecord(bookmarks, "b2");
	assert.ok(row);
	assert.equal(row.url, "https://b.example/");
	assert.equal(row.position, 1);
});

test("a folder removal is a cascade, and a separator removal is nothing", () => {
	const folder = removedRecord(
		{
			parentId: "toolbar_____",
			index: 0,
			node: { id: "f9", title: "Folder", type: "folder", parentId: "toolbar_____" },
		},
		7,
	);
	assert.ok(folder);
	assert.equal(folder.cascade, true);
	assert.equal(folder.deleted_at, 7);
	assert.equal(
		removedRecord({ parentId: "toolbar_____", index: 0, node: { id: "s", title: "", type: "separator" } }, 7),
		null,
	);
	const bookmark = removedRecord(
		{ parentId: "toolbar_____", index: 1, node: { id: "b2", title: "B2", type: "bookmark", url: "https://b.example/" } },
		7,
	);
	assert.ok(bookmark);
	assert.equal(bookmark.cascade, false);
	assert.equal(bookmark.url, "https://b.example/");
});
