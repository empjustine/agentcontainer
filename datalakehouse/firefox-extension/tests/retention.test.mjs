/**
 * @fileoverview The retention rules (docs/d204's retention section): the prune
 * targets, the GitHub repository-root removal, and the scrub cadence that keeps
 * history falling into the archive instead of vanishing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	BROWSER_DB_BUDGET_BYTES,
	BROWSER_OVER_LIMIT_FLOOR_DAYS,
	BROWSER_PAGE_FALLBACK,
	BROWSER_VISIT_DAYS,
	OWN_REMOVAL_TTL_MS,
	PRUNE_DAYS,
	PRUNE_PAGES,
	SCRUB_MAX_MS,
	SCRUB_MIN_MS,
	flattenTree,
	consumeOwnBookmarkRemoval,
	githubRepoRootBookmarks,
	isGithubRepoRoot,
	isUrgent,
	loadScrub,
	pruneCutoff,
	retentionPass,
	scrubDelay,
	stripOwnRemovals,
} from "../retention.mjs";
import { createStorage } from "./fake-webext.mjs";

const DAY = 24 * 3_600_000;
const NOW = 1_800_000_000_000;

test("the prune targets lead Gecko's expiry rule instead of matching it", () => {
	// Gecko expires exotic visits at 90 days and falls back to 100000 pages; the
	// producer takes half of each, so it always prunes before the browser does.
	assert.equal(BROWSER_VISIT_DAYS, 90);
	assert.equal(BROWSER_OVER_LIMIT_FLOOR_DAYS, 7);
	assert.equal(BROWSER_PAGE_FALLBACK, 100_000);
	assert.equal(BROWSER_DB_BUDGET_BYTES, 78_643_200);
	assert.equal(PRUNE_PAGES, 50_000);
	assert.equal(PRUNE_DAYS, 45);
});

test("a profile inside both targets is not pruned", () => {
	const cutoff = pruneCutoff({
		count: 1000,
		oldestMs: NOW - 10 * DAY,
		newestMs: NOW,
		now: NOW,
	});
	assert.equal(cutoff, null);
});

test("the day target cuts exactly at the target window", () => {
	const cutoff = pruneCutoff({
		count: 1000,
		oldestMs: NOW - 200 * DAY,
		newestMs: NOW,
		now: NOW,
	});
	assert.equal(cutoff, NOW - PRUNE_DAYS * DAY);
});

test("the page target estimates a cutoff from the span and stays conservative", () => {
	const cutoff = pruneCutoff({
		count: 1000,
		oldestMs: NOW - 20 * DAY,
		newestMs: NOW,
		now: NOW,
		maxPages: 100,
	});
	assert.ok(cutoff !== null);
	// 900 of 1000 rows must go: the estimated cutoff sits nine tenths into the span.
	const expected = Math.round(NOW - 20 * DAY + 20 * DAY * 0.9);
	assert.equal(cutoff, expected);
});

test("both triggers together prune only as deep as the earlier cutoff", () => {
	// Deleting past the earlier of the two cutoffs would remove rows one rule
	// still wants, so the pass takes the minimum and lets the next one re-measure.
	const cutoff = pruneCutoff({
		count: 1001,
		oldestMs: NOW - 200 * DAY,
		newestMs: NOW,
		now: NOW,
		maxPages: 1000,
	});
	const estimate = Math.round(NOW - 200 * DAY + 200 * DAY * (1 - 1000 / 1001));
	assert.equal(cutoff, Math.min(estimate, NOW - PRUNE_DAYS * DAY));
});

const ROOTS = [
	["https://github.com/giraffe-fsharp/Giraffe", true],
	["https://github.com/giraffe-fsharp/Giraffe/", true],
	["http://github.com/a/b", true],
	["https://www.github.com/a/b", true],
	["https://github.com/a/b/issues", false],
	["https://github.com/a/b/tree/main/src", false],
	["https://github.com/a/b?tab=readme", false],
	["https://github.com/a", false],
	["https://github.com/settings/profile", false],
	["https://github.com/orgs/rust-lang", false],
	["https://github.com/a/b.git", true],
	["https://gist.github.com/a/b", false],
	["https://github.com/a/b#readme", false],
	["not a url", false],
];

test("only a repository root counts, never a page inside one", () => {
	for (const [url, expected] of ROOTS) {
		assert.equal(isGithubRepoRoot(String(url)), expected, String(url));
	}
});

test("the removal list is the repository roots already bookmarked", () => {
	const tree = [
		{"id": "root________", "type": "folder", "children": [
			{"id": "1", "type": "bookmark", "url": "https://github.com/a/b"},
			{"id": "2", "type": "bookmark", "url": "https://example.com/x"},
			{"id": "f", "type": "folder", "children": [
				{"id": "3", "type": "bookmark", "url": "https://github.com/a/b/pull/1"},
				{"id": "4", "type": "bookmark", "url": "https://github.com/c/d"},
			]},
		]},
	];
	assert.equal(flattenTree(tree).length, 6);
	assert.deepEqual(githubRepoRootBookmarks(flattenTree(tree)), [
		{ id: "1", url: "https://github.com/a/b" },
		{ id: "4", url: "https://github.com/c/d" },
	]);
});

test("the cadence is the floor while urgent and doubles while settled", () => {
	assert.deepEqual(scrubDelay({ urgent: true, previousMs: SCRUB_MAX_MS }), {
		urgent: true,
		delayMs: SCRUB_MIN_MS,
	});
	let decision = scrubDelay({ urgent: false, previousMs: 0 });
	assert.equal(decision.delayMs, SCRUB_MIN_MS * 2);
	decision = scrubDelay({ urgent: false, previousMs: decision.delayMs });
	assert.equal(decision.delayMs, SCRUB_MIN_MS * 4);
	decision = scrubDelay({ urgent: false, previousMs: SCRUB_MAX_MS / 2 });
	assert.equal(decision.delayMs, SCRUB_MAX_MS);
});

test("urgency is history falling, not the bookmark walk", () => {
	// The walk is paced by what the flush drained, so forcing a 5-second scrub
	// loop for it would only multiply the pass's probe without moving bookmarks.
	assert.equal(isUrgent({ count: 10, oldestMs: NOW - DAY, now: NOW }), false);
	assert.equal(isUrgent({ count: 10, oldestMs: NOW - 120 * DAY, now: NOW }), true);
});

test("history falling under the targets is urgent, not slow", () => {
	assert.equal(isUrgent({ count: 10, oldestMs: NOW - 120 * DAY, now: NOW }), true);
	assert.equal(isUrgent({ count: 60_000, oldestMs: NOW - DAY, now: NOW }), true);
});

/**
 * @param {{ rows?: Record<string, unknown>[], tree?: Record<string, unknown>[] }} [args]
 */
function fakeBrowser({ rows = [], tree = [] } = {}) {
	/** @type {{ startTime: number, endTime: number }[]} */
	const ranges = [];
	/** @type {string[]} */
	const removed = [];
	return {
		ranges,
		removed,
		history: {
			// The probe semantics that matter: newest-first, a startTime/endTime
			// window, and maxResults as a hard cap (as Gecko's API documents).
			search: async (/** @type {Record<string, number>} */ query = {}) => {
				const start = query.startTime ?? 0;
				const end = query.endTime ?? Number.POSITIVE_INFINITY;
				const cap = query.maxResults ?? rows.length;
				return rows
					.filter(
						(row) =>
							Number(row.lastVisitTime) >= start && Number(row.lastVisitTime) <= end,
					)
					.sort((left, right) => Number(right.lastVisitTime) - Number(left.lastVisitTime))
					.slice(0, cap);
			},
			deleteRange: async (/** @type {{ startTime: number, endTime: number }} */ range) => {
				ranges.push(range);
			},
		},
		bookmarks: {
			getTree: async () => tree,
			remove: async (/** @type {string} */ id) => {
				removed.push(id);
			},
		},
	};
}

test("a pass prunes the browser only when a target is exceeded", async () => {
	const storage = createStorage();
	const browser = fakeBrowser({ rows: [{ lastVisitTime: NOW - DAY }] });
	const pass = await retentionPass({
		...browser,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: NOW,
		now: NOW,
	});
	assert.deepEqual(browser.ranges, []);
	assert.equal(pass.decision.urgent, false);
	const stored = await loadScrub(storage);
	assert.ok(stored.previous_ms >= SCRUB_MIN_MS * 2);
});

test("a pass deletes through the range API and records the cutoff", async () => {
	const storage = createStorage();
	const browser = fakeBrowser({ rows: [{ lastVisitTime: NOW - 200 * DAY }, { lastVisitTime: NOW }] });
	const pass = await retentionPass({
		...browser,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: NOW,
		now: NOW,
	});
	assert.equal(browser.ranges.length, 1);
	const [range] = browser.ranges;
	// The day rule prunes the policy window, so the boundary is the target itself.
	assert.deepEqual(range, { startTime: 0, endTime: NOW - PRUNE_DAYS * DAY });
	assert.equal(pass.state.last_cutoff_ms, NOW - PRUNE_DAYS * DAY);
});

test("the day rule costs one bounded probe, not a profile listing", async () => {
	const storage = createStorage();
	/** @type {{ endTime?: number, maxResults?: number }[]} */
	const calls = [];
	const browser = {
		history: {
			search: async (/** @type {{ endTime?: number, maxResults?: number }} */ query) => {
				calls.push(query);
				return [{ lastVisitTime: NOW - 200 * DAY, url: "https://a.example/old" }];
			},
			deleteRange: async () => undefined,
		},
		bookmarks: {
			getTree: async () => [],
			remove: async () => undefined,
		},
	};
	await retentionPass({
		...browser,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: NOW,
		now: NOW,
	});
	assert.equal(calls.length, 1, "the count probe must not run when the day rule fires");
	assert.equal(calls[0]?.endTime, NOW - PRUNE_DAYS * DAY);
	assert.equal(calls[0]?.maxResults, 1);
});

test("the count probe runs only when nothing is past the day target", async () => {
	const storage = createStorage();
	/** @type {{ endTime?: number, maxResults?: number }[]} */
	const calls = [];
	const browser = {
		history: {
			search: async (/** @type {{ endTime?: number, maxResults?: number }} */ query) => {
				calls.push(query);
				if (query.maxResults === 1) {
					return [];
				}
				return [
					{ lastVisitTime: NOW - 2 * DAY, url: "https://a.example/b" },
					{ lastVisitTime: NOW - DAY, url: "https://a.example/a" },
				];
			},
			deleteRange: async () => undefined,
		},
		bookmarks: {
			getTree: async () => [],
			remove: async () => undefined,
		},
	};
	await retentionPass({
		...browser,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: NOW,
		now: NOW,
		maxPages: 1,
	});
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.maxResults, 2, "maxPages + 1: one row over the target is the answer");
	assert.equal(calls[1]?.endTime, undefined);
});

test("the own-removal record is written before the browser is asked to delete", async () => {
	const storage = createStorage();
	/** @type {number[][]} */
	const seenAtCall = [];
	const browser = {
		history: {
			search: async () => [{ lastVisitTime: NOW - 200 * DAY }, { lastVisitTime: NOW }],
			deleteRange: async () => {
				// observed through the scrub state, not through this call
				const state = await loadScrub(storage);
				seenAtCall.push([state.pruned_before_ms]);
			},
		},
		bookmarks: {
			getTree: async () => [],
			remove: async () => {
				// no repository root in this tree, so nothing is removed
			},
		},
	};
	await retentionPass({ ...browser, storage, bookmarksSettled: true, archiveCursorMs: NOW, now: NOW });
	// The listener reads this state while the call is in flight, so an empty list
	// here is the race that would forward our own prune as a user tombstone.
	assert.equal(seenAtCall.length, 1);
	// The listener reads this window while the call is in flight, so a zero here
	// is the race that would forward our own prune as a user tombstone.
	assert.ok((seenAtCall[0]?.[0] ?? 0) > 0);
});

test("a bookmark removal is on record before the browser raises its event", async () => {
	const storage = createStorage();
	/** @type {string[][]} */
	const seenAtCall = [];
	/** @type {number[]} */
	const seenDeletes = [];
	const browser = {
		history: {
			search: async () => [],
			deleteRange: async () => {
				seenDeletes.push(1);
			},
		},
		bookmarks: {
			getTree: async () => [{ "id": "1", "type": "bookmark", "url": "https://github.com/a/b" }],
			remove: async () => {
				const state = await loadScrub(storage);
				seenAtCall.push([...state.own_bookmark_ids]);
			},
		},
	};
	await retentionPass({ ...browser, storage, bookmarksSettled: true, archiveCursorMs: 0, now: NOW });
	assert.deepEqual(seenAtCall[0], ["1"]);
});

test("the GitHub-root removal does not wait for the first visit ack", async () => {
	const storage = createStorage();
	const browser = fakeBrowser({
		tree: [{ "id": "1", "type": "bookmark", "url": "https://github.com/a/b" }],
	});
	const pass = await retentionPass({
		...browser,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: null,
		now: NOW,
	});
	assert.deepEqual(browser.removed, ["1"]);
	assert.equal(pass.removed, 1);
});

test("a bookmark the pass removed is not forwarded as a tombstone", async () => {
	const storage = createStorage();
	const tree = [{ "id": "1", "type": "bookmark", "url": "https://github.com/a/b" }];
	const browser = fakeBrowser({ tree });
	await retentionPass({ ...browser, storage, bookmarksSettled: true, archiveCursorMs: 0, now: NOW });
	const state = await loadScrub(storage);
	// The event for our own remove arrives once, and only once.
	assert.equal(consumeOwnBookmarkRemoval(state, "1", NOW + 100), true);
	assert.equal(consumeOwnBookmarkRemoval(state, "1", NOW + 100), false);
	// A user's later removal of a different bookmark is not swallowed.
	assert.equal(consumeOwnBookmarkRemoval(state, "2", NOW + 100), false);
});

test("an own-removal record expires rather than swallowing a real deletion", async () => {
	const storage = createStorage();
	const browser = fakeBrowser({
		tree: [{ "id": "1", "type": "bookmark", "url": "https://github.com/a/b" }],
	});
	await retentionPass({ ...browser, storage, bookmarksSettled: true, archiveCursorMs: 0, now: NOW });
	const state = await loadScrub(storage);
	state.pruned_at = NOW;
	state.pruned_before_ms = NOW - DAY;
	assert.deepEqual(stripOwnRemovals(state, ["example.com/gone"], NOW + 100), []);
	// The window is consumed by its first match, and a later event — or one after
	// the TTL — is a user's deletion, not the pass's.
	assert.deepEqual(stripOwnRemovals(state, ["example.com/gone"], NOW + 200), [
		"example.com/gone",
	]);
	state.own_removals_at = NOW;
	assert.equal(consumeOwnBookmarkRemoval(state, "1", NOW + OWN_REMOVAL_TTL_MS + 1), false);
});

test("bookmarks are only removed once the bookmark stream is settled", async () => {
	const storage = createStorage();
	const tree = [
		{"id": "1", "type": "bookmark", "url": "https://github.com/a/b"},
	];
	const unsettled = fakeBrowser({ tree });
	await retentionPass({
		...unsettled,
		storage,
		bookmarksSettled: false,
		archiveCursorMs: NOW,
		now: NOW,
	});
	assert.deepEqual(unsettled.removed, []);

	const settled = fakeBrowser({ tree });
	const pass = await retentionPass({
		...settled,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: NOW,
		now: NOW,
	});
	assert.deepEqual(settled.removed, ["1"]);
	assert.equal(pass.removed, 1);
	assert.equal(pass.state.removed_bookmarks, 1);
});

test("a pass with no acked archive cursor prunes nothing and probes nothing", async () => {
	const storage = createStorage();
	const browser = fakeBrowser({ rows: [{ lastVisitTime: NOW - 200 * DAY }] });
	const pass = await retentionPass({
		...browser,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: null,
		now: NOW,
	});
	assert.deepEqual(browser.ranges, []);
	assert.deepEqual(pass.pruned, []);
	assert.equal(pass.decision.urgent, false);
	assert.equal(pass.decision.delayMs, 60_000);
});

test("a prune never runs past the archive's cursor", async () => {
	const storage = createStorage();
	const cursor = NOW - 150 * DAY;
	const browser = fakeBrowser({
		rows: [{ lastVisitTime: cursor - 1000, url: "https://a.example/old" }],
	});
	const pass = await retentionPass({
		...browser,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: cursor,
		now: NOW,
	});
	assert.equal(browser.ranges.length, 1);
	assert.deepEqual(browser.ranges[0], { startTime: 0, endTime: cursor });
	assert.equal(pass.pruned[0]?.before, cursor);
	assert.equal(pass.pruned[0]?.optimistic, true);
});

test("a pass's own removal events are not forwarded as user tombstones", async () => {
	const storage = createStorage();
	const browser = fakeBrowser({
		rows: [
			{ lastVisitTime: NOW - 200 * DAY, url: "https://a.example/one" },
			{ lastVisitTime: NOW - 199 * DAY, url: "https://a.example/two" },
		],
	});
	const pass = await retentionPass({
		...browser,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: NOW,
		now: NOW,
	});
	assert.equal(pass.pruned[0]?.before, NOW - PRUNE_DAYS * DAY);

	const state = await loadScrub(storage);
	// The removal events for exactly these two pages are the extension's own.
	assert.deepEqual(
		stripOwnRemovals(state, ["https://a.example/one", "https://a.example/two"]),
		[],
	);
	assert.equal(state.pruned_at, 0, "the window is consumed by the match");
	// A later, genuine deletion of the same page is not swallowed by an old entry.
	assert.deepEqual(stripOwnRemovals(state, ["https://a.example/one"]), [
		"https://a.example/one",
	]);
});

test("the page rule deletes at most its row chunk, leaving the rest for the next", async () => {
	const storage = createStorage();
	// Inside the day window, so only the page rule can fire; the chunk then bounds
	// the delete because those rows are enumerated.
	const browser = fakeBrowser({
		rows: [
			{ lastVisitTime: NOW - DAY, url: "https://a.example/one" },
			{ lastVisitTime: NOW - 2 * DAY, url: "https://a.example/two" },
			{ lastVisitTime: NOW - 3 * DAY, url: "https://a.example/three" },
		],
	});
	const pass = await retentionPass({
		...browser,
		storage,
		bookmarksSettled: true,
		archiveCursorMs: NOW,
		now: NOW,
		maxPages: 1,
		maxRows: 1,
	});
	assert.equal(browser.ranges.length, 1);
	const [range] = browser.ranges;
	assert.equal(range?.startTime, 0);
	// The page rule enumerates, so its delete is bounded by a page it named.
	assert.ok((range?.endTime ?? 0) < NOW);
	assert.equal(pass.pruned[0]?.optimistic, false);
});
