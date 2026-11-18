/**
 * @fileoverview retention.mjs — the extension-side half of "history falls into
 * the archive instead of vanishing": the prune decision, the GitHub
 * repository-root bookmark rule, and the scrub cadence.
 *
 * WHY the browser is pruned by the extension at all (docs/d204's retention
 * rule): Firefox expires history on its own schedule, and a row that is gone
 * before a sweep reached it is gone from the archive too. The producer is
 * therefore the thing that stays AHEAD of the browser's retention: after a
 * batch is acknowledged, the oldest rows are deleted through the public
 * history API — the same call the browser's own "forget" front end makes — so
 * the deletion is user-grade and observable, never a database edit.
 *
 * WHY the limits are half of Firefox's: the archive is the durable copy, so the
 * browser only has to hold what the archive has not yet taken. Halving the
 * documented maximum leaves the other half as the producer's working set, which
 * is what makes a caught-up profile survive a long suspension without losing
 * anything.
 *
 * WHY the scrub backs off exponentially: a caught-up profile has nothing to do,
 * and a 5-second wake forever is a battery and CPU tax for no rows. The cadence
 * therefore starts at the sweep floor while there is backlog, doubles while the
 * backlog stays empty, and caps at a week — the point at which a quiet profile
 * costs one wake per week. A backlog appearing again (new visits, or history
 * that has not been pruned) resets the cadence to the floor.
 */

/**
 * Gecko's own expiry numbers, read from the source rather than assumed
 * (toolkit/components/places/PlacesExpiration.sys.mjs, mozilla-central):
 *
 * - exotic visits are expired at 90 days (QUERY_FIND_EXOTIC_VISITS_TO_EXPIRE);
 * - the over-the-limit rule never touches the last 7 days
 *   (QUERY_FIND_VISITS_TO_EXPIRE), so a profile with many bookmarks keeps its
 *   recent history;
 * - the page limit is a 75 MiB database budget (DATABASE_MAX_SIZE = 78643200)
 *   divided by the average URI size, and 100000 is the constant it falls back
 *   to when the database cannot be measured
 *   (places.history.expiration.max_pages defaults to -1, "derive");
 * - 180 days appears once, as the threshold for pages whose only relations are
 *   favicons — it is not a history rule.
 *
 * So the two numbers a producer can plan against are 90 days and ~100000 pages,
 * and the day rule is the one with a hard constant: the page limit moves with
 * the database size and the pref override, which a WebExtension cannot read.
 */
export const BROWSER_VISIT_DAYS = 90;
export const BROWSER_OVER_LIMIT_FLOOR_DAYS = 7;
export const BROWSER_DB_BUDGET_BYTES = 78_643_200;
export const BROWSER_PAGE_FALLBACK = 100_000;

/**
 * The prune targets: half of the browser's rule, so the producer always leads
 * the expiry rather than racing it. Equal targets would delete the same rows the
 * browser is about to expire, and a row that is deleted before it is acked is
 * the one case this whole module exists to prevent.
 */
export const PRUNE_PAGES = BROWSER_PAGE_FALLBACK / 2;
export const PRUNE_DAYS = BROWSER_VISIT_DAYS / 2;

/**
 * Rows one pass may delete. Two reasons for a ceiling rather than one big
 * deleteRange: the call raises one removal event per page, so its cost is the
 * row count (the 5-second budget), and the pruned URLs have to stay in the
 * scrub state so the producer can tell its own deletion from the user's.
 */
const PRUNE_CHUNK = 1000;

/** The sweep floor and the exponential cap, in milliseconds. */
export const SCRUB_MIN_MS = 5000;
export const SCRUB_MAX_MS = 7 * 24 * 3_600_000;

const DAY_MS = 24 * 3_600_000;
const SCRUB_KEY = "scrub";

/**
 * GitHub's first path segments that name a site feature rather than a user, so
 * github.com/settings/profile is not read as the repository settings/profile.
 * @type {readonly string[]}
 */
const GITHUB_RESERVED = [
	"about", "account", "apps", "codespaces", "collections", "contact", "dashboard",
	"enterprise", "events", "explore", "features", "issues", "join", "login", "logout",
	"marketplace", "new", "notifications", "orgs", "organizations", "pricing",
	"pulls", "readme", "search", "security", "sessions", "settings", "signup",
	"site", "sponsors", "stars", "topics", "trending", "users", "watching",
];

/**
 * A repository root is exactly two path segments on github.com: the owner and
 * the repository. Anything longer is a page inside it (issues, a file, a
 * branch), and anything shorter is a profile — neither is a "saved the project
 * once" bookmark, and deleting those would be deleting the user's reading list.
 * @param {string} url
 * @returns {boolean}
 */
export function isGithubRepoRoot(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return false;
	}
	const host = parsed.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") {
		return false;
	}
	if (parsed.search !== "" || parsed.hash !== "") {
		return false;
	}
	const segments = parsed.pathname.split("/").filter((part) => part !== "");
	const [owner, repo] = segments;
	if (segments.length !== 2 || owner === undefined || repo === undefined) {
		return false;
	}
	return !GITHUB_RESERVED.includes(owner.toLowerCase());
}

/**
 * How far back the browser may be pruned, or null when nothing is prunable.
 *
 * The page target cannot name a timestamp without reading every row, so the
 * count case estimates the cutoff from the observed span (uniform-ish visit
 * density) and converges: the next pass re-measures after the delete. The day
 * target is exact.
 * @param {object} args
 * @param {number} args.count rows the browser currently reports
 * @param {number} args.oldestMs epoch ms of the oldest reported row
 * @param {number} args.newestMs epoch ms of the newest reported row
 * @param {number} args.now
 * @param {number} [args.maxPages]
 * @param {number} [args.maxDays]
 * @returns {number | null} delete everything older than this instant
 */
export function pruneCutoff({
	count,
	oldestMs,
	newestMs,
	now,
	maxPages = PRUNE_PAGES,
	maxDays = PRUNE_DAYS,
}) {
	if (count <= 0 || !Number.isFinite(oldestMs) || !Number.isFinite(newestMs)) {
		return null;
	}
	/** @type {number[]} */
	const cutoffs = [];
	const dayCutoff = now - maxDays * DAY_MS;
	if (oldestMs < dayCutoff) {
		cutoffs.push(dayCutoff);
	}
	if (count > maxPages) {
		const span = Math.max(1, newestMs - oldestMs);
		const keepFraction = maxPages / count;
		cutoffs.push(Math.round(oldestMs + span * (1 - keepFraction)));
	}
	if (cutoffs.length === 0) {
		return null;
	}
	// The conservative cutoff: pruning no further than every trigger agrees on
	// keeps one pass from deleting rows another rule still wants.
	return Math.min(...cutoffs);
}

/**
 * @typedef {object} ScrubDecision
 * @property {boolean} urgent a fast wake is worth it
 * @property {number} delayMs when the next sweep should run
 */

/**
 * The cadence: floor while urgent, double while settled, capped at a week.
 * @param {object} args
 * @param {boolean} args.urgent
 * @param {number} [args.previousMs]
 * @returns {ScrubDecision}
 */
export function scrubDelay({ urgent, previousMs = 0 }) {
	if (urgent) {
		return { urgent: true, delayMs: SCRUB_MIN_MS };
	}
	const grown = previousMs > 0 ? previousMs * 2 : SCRUB_MIN_MS * 2;
	return { urgent: false, delayMs: Math.min(SCRUB_MAX_MS, grown) };
}

/**
 * The backlog test that decides "fast" from "settled". Two independent halves:
 * rows the browser will expire before the archive saw them (prunable history),
 * and a profile that has fallen under the prune targets because the browser
 * itself expired rows — the second is the "history is falling" case, where a
 * slow sweep would lose exactly what the archive exists to keep.
 * @param {object} args
 * @param {number} args.count
 * @param {number} args.oldestMs
 * @param {number} args.now
 * @param {number} [args.maxPages]
 * @param {number} [args.maxDays]
 * @returns {boolean}
 */
export function isUrgent({
	count,
	oldestMs,
	now,
	maxPages = PRUNE_PAGES,
	maxDays = PRUNE_DAYS,
}) {
	if (count > maxPages) {
		return true;
	}
	return now - oldestMs > maxDays * DAY_MS;
}

/**
 * The browser rows the archive does not need to keep: bookmark roots of GitHub
 * repositories, sent as their own bookmark rows before removal.
 * @param {Record<string, unknown>[]} nodes flattened bookmark nodes
 * @returns {{ id: string, url: string }[]}
 */
export function githubRepoRootBookmarks(nodes) {
	/** @type {{ id: string, url: string }[]} */
	const found = [];
	for (const node of nodes) {
		const { id, type, url } = node;
		if (type !== "bookmark" || typeof url !== "string" || typeof id !== "string") {
			continue;
		}
		if (isGithubRepoRoot(url)) {
			found.push({ id, url });
		}
	}
	return found;
}

/**
 * @param {Record<string, unknown>[]} tree a bookmarks.getTree() result
 * @returns {Record<string, unknown>[]} every node, depth first
 */
export function flattenTree(tree) {
	/** @type {Record<string, unknown>[]} */
	const out = [];
	/** @param {Record<string, unknown>[]} nodes @returns {void} */
	const visit = (nodes) => {
		for (const node of nodes) {
			out.push(node);
			const children = /** @type {{ children?: Record<string, unknown>[] }} */ (node)
				.children;
			if (Array.isArray(children)) {
				visit(children);
			}
		}
	};
	visit(tree);
	return out;
}


/**
 * A page as history.search reports it: pages, not visits, so lastVisitTime is
 * the page's newest visit and the field both targets are measured on.
 * @param {Record<string, unknown>} row
 * @returns {number}
 */
function lastVisit(row) {
	const at = Number(row.lastVisitTime === undefined ? row.visitTime : row.lastVisitTime);
	return Number.isFinite(at) ? at : 0;
}

/**
 * The chunk's boundary instants: the page times at or before the cutoff, oldest
 * first, capped at the chunk size. The last one is what deleteRange is asked
 * for, so a page sharing that instant is pruned with the chunk.
 * @param {Record<string, unknown>[]} rows
 * @param {number} cutoff
 * @param {number} limit
 * @returns {number[]}
 */
function candidateEnds(rows, cutoff, limit) {
	const times = rows
		.map((row) => lastVisit(row))
		.filter((at) => at > 0 && at <= cutoff)
		.sort((left, right) => left - right);
	return Number.isFinite(limit) ? times.slice(0, limit) : times;
}

/**
 * history.search that answers an empty list instead of throwing: a probe the
 * browser refuses must not take the whole pass — and the bookmark removal after
 * it — down.
 * @param {{ search: Function }} history
 * @param {Record<string, unknown>} query
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function searchRows(history, query) {
	try {
		const rows = await history.search(query);
		return Array.isArray(rows) ? rows : [];
	} catch {
		return [];
	}
}
/**
 * @typedef {object} ScrubState
 * @property {number} previous_ms last delay the scheduler used
 * @property {number} last_at when the last retention pass ran
 * @property {number} pruned_rows rows deleted from the browser so far
 * @property {number} removed_bookmarks GitHub roots removed so far
 * @property {number} last_cutoff_ms the last cutoff applied, 0 for none
 * @property {number} pruned_at when the last history prune ran, 0 for none
 * @property {number} pruned_before_ms the boundary of the last history prune
 * @property {string[]} own_bookmark_ids bookmarks this pass removed and whose event is therefore its own
 * @property {number} own_removals_at when those lists were last written, so a stale entry cannot
 *   swallow a later user deletion of the same page or bookmark
 * @property {number} observed_count rows the browser reported last pass
 * @property {number} observed_oldest_ms oldest row the browser reported last pass
 */

/** @type {Readonly<ScrubState>} */
const SCRUB_DEFAULTS = {
	previous_ms: 0,
	last_at: 0,
	pruned_rows: 0,
	removed_bookmarks: 0,
	last_cutoff_ms: 0,
	pruned_at: 0,
	pruned_before_ms: 0,
	own_bookmark_ids: [],
	own_removals_at: 0,
	observed_count: 0,
	observed_oldest_ms: 0,
};

/**
 * How long an own-removal entry is trusted. The event for a deleteRange or a
 * bookmarks.remove arrives within the same wake, so a few seconds is generous —
 * and the bound is what keeps a missed event from swallowing a real deletion
 * months later.
 */
export const OWN_REMOVAL_TTL_MS = 10_000;

/**
 * @param {import("./queue.mjs").StorageArea} storage
 * @returns {Promise<ScrubState>}
 */
export async function loadScrub(storage) {
	const got = await storage.get(SCRUB_KEY);
	const raw = /** @type {Record<string, unknown>} */ (got[SCRUB_KEY] ?? {});
	/** @param {string} key @param {number} fallback @returns {number} */
	const numberField = (key, fallback) => {
		const value = raw[key];
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};
	/** @type {ScrubState} */
	const state = {
		previous_ms: numberField("previous_ms", SCRUB_DEFAULTS.previous_ms),
		last_at: numberField("last_at", SCRUB_DEFAULTS.last_at),
		pruned_rows: numberField("pruned_rows", SCRUB_DEFAULTS.pruned_rows),
		removed_bookmarks: numberField("removed_bookmarks", SCRUB_DEFAULTS.removed_bookmarks),
		last_cutoff_ms: numberField("last_cutoff_ms", SCRUB_DEFAULTS.last_cutoff_ms),
		own_removals_at: numberField("own_removals_at", SCRUB_DEFAULTS.own_removals_at),
		pruned_at: numberField("pruned_at", SCRUB_DEFAULTS.pruned_at),
		pruned_before_ms: numberField("pruned_before_ms", SCRUB_DEFAULTS.pruned_before_ms),
		observed_count: numberField("observed_count", SCRUB_DEFAULTS.observed_count),
		observed_oldest_ms: numberField("observed_oldest_ms", SCRUB_DEFAULTS.observed_oldest_ms),
		own_bookmark_ids: [],
	};
	/** @param {unknown} list @returns {string[]} */
	const stringList = (list) =>
		Array.isArray(list)
			? /** @type {unknown[]} */ (list).filter((value) => typeof value === "string")
			: [];
	state.own_bookmark_ids = stringList(raw.own_bookmark_ids);
	return state;
}

/**
 * @param {import("./queue.mjs").StorageArea} storage
 * @param {ScrubState} state
 * @returns {Promise<void>}
 */
export async function saveScrub(storage, state) {
	await storage.set({ [SCRUB_KEY]: state });
}

/**
 * One retention pass: prune the browser's oldest history, then remove the
 * GitHub repository-root bookmarks the archive already holds.
 *
 * WHY the removal waits for the bookmark stream: the daemon must have the row
 * before the browser loses it. A bookmark whose record is still queued is left
 * alone this pass.
 *
 * WHY the prune is capped by the archive's cursor: deleting a browser row the
 * archive has not taken destroys the only copy. The cutoff is clamped to the
 * visit stream's checkpoint, so retention can never run ahead of the producer —
 * during the first fill that means retention waits, which is also why the
 * expensive probe is skipped while nothing is archiveable.
 *
 * WHY the deleted URLs are kept: \`deleteRange\` raises the same removal event a
 * user's deletion raises, and the producer forwards removals as marks. Without
 * this list the extension would mark exactly the pages it just archived as
 * deleted, hiding them from every read face.
 * @param {object} args
 * @param {{ search: Function, deleteRange: Function }} args.history
 * @param {{ getTree: Function, remove: Function }} args.bookmarks
 * @param {import("./queue.mjs").StorageArea} args.storage
 * @param {boolean} args.bookmarksSettled
 * @param {number | null} args.archiveCursorMs the visit checkpoint, null before the first ack
 * @param {number} args.now
 * @param {number} [args.maxPages]
 * @param {number} [args.maxDays]
 * @param {number} [args.maxRows]
 * @returns {Promise<{ state: ScrubState, decision: ScrubDecision, removed: number, pruned: { before: number, optimistic: boolean }[] }>}
 */
export async function retentionPass({
	history,
	bookmarks,
	storage,
	bookmarksSettled,
	archiveCursorMs,
	now,
	maxPages = PRUNE_PAGES,
	maxDays = PRUNE_DAYS,
	maxRows = PRUNE_CHUNK,
}) {
	const state = await loadScrub(storage);
	const historyArchived = archiveCursorMs !== null && typeof history.search === "function";
	/** @type {string[]} */
	/** @type {{ before: number, optimistic: boolean }[]} */
	/** @type {{ before: number, optimistic: boolean }[]} */
	let pruned = [];
	let count = 0;
	let oldestMs = Number.POSITIVE_INFINITY;
	let newestMs = 0;
	if (historyArchived) {
		// Two phases, because the two targets cost different queries.
		//
		// Phase 1 — the day rule. history.search takes an endTime, so "is anything
		// older than the target" is a one-row probe, and the answer authorises the
		// whole policy window: an entry older than the target is prunable by
		// definition, so the delete is a range to min(dayCutoff, cursor) rather than
		// a walk. That is the optimistic truncation — a page sitting just inside the
		// window goes with it — and it is safe because the cursor clamp has already
		// proved the archive holds everything this pass can reach.
		//
		// Phase 2 — the page rule, and the only case that needs the profile's size.
		// No WebExtension API reports it, so it can only be counted, and counting is
		// worth paying only when the day rule has nothing to do.
		const dayCutoff = now - maxDays * DAY_MS;
		const old = await searchRows(history, {
			text: "",
			startTime: 0,
			endTime: dayCutoff,
			maxResults: 1,
		});
		/** @type {number[]} */
		let ends = [];
		if (old.length > 0) {
			ends = [Math.min(dayCutoff, archiveCursorMs)];
		} else {
			const rows = await searchRows(history, {
				text: "",
				startTime: 0,
				maxResults: maxPages + 1,
			});
			for (const row of rows) {
				const at = lastVisit(row);
				if (at <= 0) {
					continue;
				}
				count += 1;
				if (at < oldestMs) {
					oldestMs = at;
				}
				if (at > newestMs) {
					newestMs = at;
				}
			}
			// The runtime sanity check the browser cannot otherwise give us: a
			// WebExtension cannot read places.history.expiration.max_pages, so the
			// only way to see whether the effective retention matches Gecko's rule
			// is to record what the browser actually still holds.
			state.observed_count = count;
			state.observed_oldest_ms = Number.isFinite(oldestMs) ? oldestMs : 0;
			const proposed = pruneCutoff({ count, oldestMs, newestMs, now, maxPages, maxDays });
			const cutoff = proposed === null ? null : Math.min(proposed, archiveCursorMs);
			if (cutoff !== null) {
				ends = candidateEnds(rows, cutoff, maxRows);
			}
		}
		const end = ends.at(-1);
		if (end !== undefined) {
			// WHY the record is written BEFORE the call: deleteRange raises the
			// removal events itself, and the listener reads this state while the
			// pass is still in flight. Recording afterwards loses the race and the
			// pages are forwarded as user tombstones.
			state.pruned_at = now;
			state.pruned_before_ms = end;
			await saveScrub(storage, state);
			await history.deleteRange({ startTime: 0, endTime: end });
			state.pruned_rows += 1;
			state.last_cutoff_ms = end;
			pruned = [{ before: end, optimistic: old.length > 0 }];
		}
	}
	let removed = 0;
	if (bookmarksSettled && typeof bookmarks.getTree === "function") {
		const tree = await bookmarks.getTree();
		const roots = githubRepoRootBookmarks(flattenTree(tree));
		if (roots.length > 0) {
			// Same write-ahead rule as the history prune: remove() raises onRemoved
			// synchronously enough that the listener can read this state first.
			state.own_bookmark_ids = [
				...state.own_bookmark_ids,
				...roots.map((node) => node.id),
			].slice(-maxRows * 2);
			state.own_removals_at = now;
			await saveScrub(storage, state);
			for (const node of roots) {
				await bookmarks.remove(node.id);
				removed += 1;
			}
			state.removed_bookmarks += removed;
		}
	}
	const urgent = historyArchived
		? isUrgent({ count, oldestMs, now, maxPages, maxDays })
		: !bookmarksSettled;
	const decision = historyArchived
		? scrubDelay({ urgent, previousMs: state.previous_ms })
		: { urgent, delayMs: urgent ? SCRUB_MIN_MS : 60_000 };
	state.previous_ms = decision.delayMs;
	state.last_at = now;
	await saveScrub(storage, state);
	return { state, decision, removed, pruned };
}

/**
 * Whether an own-removal record is still trusted: records older than the TTL
 * are dropped, because a missed event must not turn into a permanent claim
 * that the user deleted nothing.
 * @param {number} at the record's own timestamp
 * @param {number} now
 * @returns {boolean}
 */
function ownRemovalFresh(at, now) {
	return at !== 0 && now - at <= OWN_REMOVAL_TTL_MS;
}

/**
 * The URLs from a removal event that the extension did NOT delete itself.
 *
 * A history prune is a time range, so the pages it catches are not always
 * nameable — the day rule deletes the whole policy window from a one-row probe.
 * The record is therefore the window itself: while the prune is fresh, a
 * removal event is the extension's own. A user deletion landing inside that
 * window is ignored too, which is the safe direction — the archive is
 * append-only, so the row it keeps is the row the user still had.
 * @param {ScrubState} state
 * @param {string[]} urls
 * @param {number} [now]
 * @returns {string[]}
 */
export function stripOwnRemovals(state, urls, now = Date.now()) {
	if (!ownRemovalFresh(state.pruned_at, now)) {
		state.pruned_at = 0;
		state.pruned_before_ms = 0;
		return urls;
	}
	state.pruned_at = 0;
	state.pruned_before_ms = 0;
	return [];
}
/**
 * The bookmark twin: true when this onRemoved event is the pass's own
 * bookmarks.remove, which must not be forwarded as a tombstone.
 * @param {ScrubState} state
 * @param {string} id
 * @param {number} [now]
 * @returns {boolean}
 */
export function consumeOwnBookmarkRemoval(state, id, now = Date.now()) {
	if (state.own_bookmark_ids.length === 0 || !ownRemovalFresh(state.own_removals_at, now)) {
		return false;
	}
	const index = state.own_bookmark_ids.indexOf(id);
	if (index === -1) {
		return false;
	}
	state.own_bookmark_ids = state.own_bookmark_ids.filter((entry) => entry !== id);
	return true;
}
