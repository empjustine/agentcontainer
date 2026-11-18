/**
 * @fileoverview fake-webext.mjs — in-memory stand-ins for the three host
 * surfaces the extension touches (storage.local, history, bookmarks). They
 * reproduce the CONTRACT the producer relies on, including the two facts that
 * shaped it: history.search returns newest-first and caps at maxResults, and
 * getVisits returns every visit of a URL with no time filter.
 */

/**
 * @typedef {object} FakeStorage
 * @property {Map<string, unknown>} data
 * @property {(keys: string | string[]) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/**
 * @param {Record<string, unknown>} [initial]
 * @param {{ quota?: number }} [options] quota in serialized bytes, 0 = none
 * @returns {FakeStorage} a storage.local-shaped area backed by a Map
 */
export function createStorage(initial = {}, options = {}) {
	const data = new Map(Object.entries(initial));
	const quota = options.quota ?? 0;
	/** @param {unknown} value @returns {unknown} */
	const clone = (value) => JSON.parse(JSON.stringify(value));
	/** @param {Map<string, unknown>} map @returns {number} */
	const bytes = (map) => {
		let total = 0;
		for (const value of map.values()) {
			total += JSON.stringify(value).length;
		}
		return total;
	};
	return {
		data,
		/** @param {string | string[]} keys @returns {Promise<Record<string, unknown>>} */
		async get(keys) {
			const wanted = Array.isArray(keys) ? keys : [keys];
			/** @type {Record<string, unknown>} */
			const found = {};
			for (const key of wanted) {
				if (data.has(key)) {
					found[key] = clone(data.get(key));
				}
			}
			return found;
		},
		/** @param {Record<string, unknown>} items @returns {Promise<void>} */
		async set(items) {
			const projected = new Map(data);
			for (const [key, value] of Object.entries(items)) {
				projected.set(key, clone(value));
			}
			if (quota > 0 && bytes(projected) > quota) {
				throw new Error("QuotaExceededError: storage.local is full");
			}
			for (const [key, value] of projected) {
				data.set(key, value);
			}
		},
		/** @param {string | string[]} keys @returns {Promise<void>} */
		async remove(keys) {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				data.delete(key);
			}
		},
	};
}

/**
 * @typedef {object} FakeVisit
 * @property {number} visit_time
 * @property {string} [transition]
 * @typedef {object} FakePage
 * @property {string} url
 * @property {string} [title]
 * @property {string} [page_id]
 * @property {FakeVisit[]} visits
 */

/**
 * @param {FakePage[]} pages
 * @returns {import("../history.mjs").HistoryApi & { calls: { search: Record<string, unknown>[], getVisits: Record<string, unknown>[] } }} a history-shaped API plus the call log
 */
export function createHistory(pages) {
	/** @type {{ search: Record<string, unknown>[], getVisits: Record<string, unknown>[] }} */
	const calls = { search: [], getVisits: [] };
	const lastVisit = (/** @type {FakePage} */ page) =>
		page.visits.reduce((high, visit) => Math.max(high, visit.visit_time), 0);
	return {
		calls,
		/** @param {{ startTime: number, endTime: number, maxResults: number, text: string }} query */
		async search(query) {
			calls.search.push({ ...query });
			return pages
				.filter((page) => {
					const at = lastVisit(page);
					return at >= query.startTime && at <= query.endTime;
				})
				.sort((left, right) => lastVisit(right) - lastVisit(left))
				.slice(0, query.maxResults)
				.map((page) => ({
					id: page.page_id ?? page.url,
					url: page.url,
					title: page.title ?? "",
					lastVisitTime: lastVisit(page),
					visitCount: page.visits.length,
				}));
		},
		/** @param {{ url: string }} query */
		async getVisits(query) {
			calls.getVisits.push({ ...query });
			const page = pages.find((candidate) => candidate.url === query.url);
			if (page === undefined) {
				throw new Error(`no such page: ${query.url}`);
			}
			return page.visits
				.map((visit, index) => ({
					id: page.page_id ?? page.url,
					visitId: String(index + 1),
					visitTime: visit.visit_time,
					referringVisitId: "0",
					transition: visit.transition ?? "link",
				}))
				.sort((left, right) => right.visitTime - left.visitTime);
		},
	};
}

/**
 * @typedef {object} FakeNode
 * @property {string} id
 * @property {string} title
 * @property {string} type
 * @property {number} [index]
 * @property {number} [dateAdded]
 * @property {string} [url]
 * @property {string} [parentId]
 * @property {FakeNode[]} [children]
 */

/**
 * @param {FakeNode} tree
 * @returns {import("../bookmarks.mjs").BookmarksApi} a bookmarks-shaped API
 */
export function createBookmarks(tree) {
	/** @type {FakeNode[]} */
	const all = [];
	/** @param {FakeNode} node @returns {void} */
	const collect = (node) => {
		all.push(node);
		for (const child of node.children ?? []) {
			collect(child);
		}
	};
	collect(tree);
	return {
		/** @returns {Promise<FakeNode[]>} */
		async getTree() {
			return [tree];
		},
		/** @param {string} id @returns {Promise<FakeNode[]>} */
		async get(id) {
			const found = all.find((node) => node.id === id);
			if (found === undefined) {
				throw new Error(`no such bookmark: ${id}`);
			}
			return [found];
		},
	};
}

/**
 * Every queued record, oldest first — the assertion surface for "what would
 * this wake have posted". Reads the fake's own Map, which is why it takes the
 * fake's return value rather than the storage contract.
 * @param {FakeStorage} storage
 * @returns {Record<string, unknown>[]}
 */
export function queuedRecords(storage) {
	/** @param {string} key @returns {number} */
	const seqOf = (key) => Number(key.split(":")[2]);
	return [...storage.data.entries()]
		.filter(([key]) => key.startsWith("q:"))
		.sort((left, right) => seqOf(left[0]) - seqOf(right[0]))
		.map(([, value]) => /** @type {Record<string, unknown>} */ (value));
}
