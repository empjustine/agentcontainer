/**
 * @fileoverview settings.mjs — the extension's one settings surface: defaults,
 * validation, and the storage round-trip.
 *
 * WHY capture starts disabled: install is not consent. The first-run screen
 * (options.html) states that history and bookmarks leave the browser, and
 * nothing is queued or posted until the operator ticks that box (docs/d204's
 * Privacy section).
 *
 * WHY the daemon URL is validated to loopback: the manifest's host permission
 * covers loopback only, and a LAN address would put the archive and the static
 * key on the wire in clear text (docs/d204's daemon boundary).
 */

const SETTINGS_KEY = "settings";

/**
 * @typedef {object} Settings
 * @property {boolean} enabled capture is consented and running
 * @property {string} daemon_url origin only, e.g. "http://127.0.0.1:4433"
 * @property {string} key static shared secret; "" sends no Authorization header
 * @property {number} queue_bytes soft ceiling for the durable queue
 * @property {number} repair_hours trailing re-read window of the backfill sweep
 */

/** @type {Readonly<Settings>} */
const DEFAULT_SETTINGS = {
	enabled: false,
	// The hister listener's port (docs/d205): the stock hister extension already
	// defaults to it, so one origin serves both the hister API and this
	// producer's /ingest/slurp edge.
	daemon_url: "http://127.0.0.1:4433",
	key: "",
	queue_bytes: 4 * 1024 * 1024,
	repair_hours: 6,
};

/**
 * The loopback spellings the manifest asks permission for. A list, not a
 * suffix test: "127.0.0.1.evil.example" ends with neither.
 * @type {readonly string[]}
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * A daemon origin, or null when the string is not an http loopback origin.
 * Only the origin is kept, so a pasted path cannot silently retarget the posts.
 * @param {string} value
 * @returns {string | null}
 */
export function normaliseDaemonUrl(value) {
	let parsed;
	try {
		parsed = new URL(value.trim());
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:") {
		return null;
	}
	if (!LOOPBACK_HOSTS.includes(parsed.hostname)) {
		return null;
	}
	return parsed.origin;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
	return typeof value === "object" && value !== null;
}

/**
 * Stored settings made safe to use: an unknown or stale field falls back to its
 * default instead of reaching fetch as undefined. A stored daemon URL that fails
 * validation falls back too — a bad edit must not silently stop capture — and
 * the status block names the value in force.
 * @param {unknown} stored
 * @returns {Settings}
 */
function resolveSettings(stored) {
	const raw = isRecord(stored) ? stored : {};
	const daemon = normaliseDaemonUrl(
		typeof raw.daemon_url === "string"
			? raw.daemon_url
			: DEFAULT_SETTINGS.daemon_url,
	);
	return {
		enabled: raw.enabled === true,
		daemon_url: daemon === null ? DEFAULT_SETTINGS.daemon_url : daemon,
		key: typeof raw.key === "string" ? raw.key : DEFAULT_SETTINGS.key,
		queue_bytes:
			typeof raw.queue_bytes === "number" && raw.queue_bytes > 0
				? raw.queue_bytes
				: DEFAULT_SETTINGS.queue_bytes,
		repair_hours:
			typeof raw.repair_hours === "number" && raw.repair_hours >= 0
				? raw.repair_hours
				: DEFAULT_SETTINGS.repair_hours,
	};
}

/**
 * @param {import("./queue.mjs").StorageArea} storage
 * @returns {Promise<Settings>}
 */
export async function loadSettings(storage) {
	const got = await storage.get(SETTINGS_KEY);
	return resolveSettings(got[SETTINGS_KEY]);
}

/**
 * @param {import("./queue.mjs").StorageArea} storage
 * @param {Settings} settings
 * @returns {Promise<void>}
 */
export async function saveSettings(storage, settings) {
	await storage.set({ [SETTINGS_KEY]: settings });
}

