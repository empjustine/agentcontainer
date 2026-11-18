/**
 * @fileoverview options.mjs — the first-run consent screen and the settings
 * form, plus the status line docs/d204's R10 asks for.
 *
 * WHY the DOM is typed by hand below: tsconfig's program has lib es2023 and
 * @types/node only (no DOM), and this page touches exactly five members of it.
 * A four-line typedef is the honest description; a DOM lib in the global
 * program would describe a browser the node half of this tree does not have.
 */

import { loadSettings, normaliseDaemonUrl, saveSettings } from "./settings.mjs";
import { snapshot } from "./queue.mjs";
import { loadStatus, loadStreams } from "./state.mjs";

/**
 * @typedef {object} PageElement
 * @property {string} value
 * @property {boolean} checked
 * @property {string} textContent
 * @property {boolean} disabled
 * @property {(type: string, listener: () => void) => void} addEventListener
 * @typedef {{ getElementById: (id: string) => PageElement | null }} Page
 * @typedef {{ local: import("./queue.mjs").StorageArea }} Api
 */

/**
 * @returns {Page}
 */
function page() {
	const globals = /** @type {Record<string, unknown>} */ (
		/** @type {unknown} */ (globalThis)
	);
	return /** @type {Page} */ (globals.document);
}

/**
 * @returns {Api}
 */
function api() {
	const globals = /** @type {Record<string, unknown>} */ (
		/** @type {unknown} */ (globalThis)
	);
	return /** @type {Api} */ (globals.browser ?? globals.chrome);
}

/**
 * @param {Page} doc
 * @param {string} id
 * @returns {PageElement}
 */
function need(doc, id) {
	const found = doc.getElementById(id);
	if (found === null) {
		throw new Error(`options.html is missing #${id}`);
	}
	return found;
}

/**
 * @param {number | null} value
 * @returns {string}
 */
function stamp(value) {
	return value === null || value === 0 ? "never" : new Date(value).toISOString();
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function kib(bytes) {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * @param {Page} doc
 * @param {Api} web
 * @returns {Promise<void>}
 */
async function render(doc, web) {
	const storage = web.local;
	const settings = await loadSettings(storage);
	const status = await loadStatus(storage);
	const streams = await loadStreams(storage);
	const queued = await snapshot(storage);
	need(doc, "enabled").checked = settings.enabled;
	need(doc, "daemon_url").value = settings.daemon_url;
	need(doc, "key").value = settings.key;
	const rows = queued.meta;
	const lines = [
		`capture: ${settings.enabled ? "running" : "stopped (consent not given)"}`,
		"accepted " +
			status.accepted +
			" · duplicates " +
			status.duplicates +
			" · daemon " +
			(status.daemon_version === "" ? "unknown" : status.daemon_version),
		`last ack ${stamp(status.last_ack_at)}`,
		"last error " +
			(status.last_error === ""
				? "none"
				: `${status.last_error} (${stamp(status.last_error_at)})`),
		"budget misses " +
			status.budget_misses +
			" · rejected batches " +
			status.rejected_batches +
			" · evicted rows " +
			status.evicted,
		"queue " +
			rows.visit.count +
			"/" +
			rows.bookmark.count +
			" visits/bookmarks · " +
			rows.title.count +
			" titles · " +
			rows.tombstone.count +
			" tombstones · " +
			kib(queued.total_bytes),
		"backfill cursor " +
			stamp(streams.visit.cursor_ms) +
			(streams.visit.pending === null ? "" : " (window in flight)"),
		"bookmark walk " +
			(streams.bookmark.after_key === null
				? stamp(streams.bookmark.walked_at)
				: `in progress after ${stamp(streams.bookmark.after_date_added)}`),
	];
	need(doc, "status").textContent = lines.join("\n");
}

/**
 * @param {Page} doc
 * @param {Api} web
 * @returns {Promise<void>}
 */
async function save(doc, web) {
	const notice = need(doc, "notice");
	const typed = need(doc, "daemon_url").value;
	const origin = normaliseDaemonUrl(typed);
	if (origin === null) {
		notice.textContent =
			"daemon origin must be http on 127.0.0.1, localhost or [::1]";
		return;
	}
	const current = await loadSettings(web.local);
	await saveSettings(web.local, {
		...current,
		enabled: need(doc, "enabled").checked,
		daemon_url: origin,
		key: need(doc, "key").value.trim(),
	});
	notice.textContent = "saved";
	await render(doc, web);
}

const doc = page();
const web = api();
const saveButton = need(doc, "save");
saveButton.addEventListener("click", () => {
	save(doc, web).catch((error) => {
		need(doc, "notice").textContent = `save failed: ${String(error)}`;
	});
});
render(doc, web).catch((error) => {
	need(doc, "status").textContent = `status unavailable: ${String(error)}`;
});
