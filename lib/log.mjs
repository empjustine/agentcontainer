/**
 * @fileoverview log.mjs — structured logging shared by this repo's node tools.
 *
 * One JSON object per line on stderr (LOG_FORMAT=logfmt for logfmt):
 *   {"ts":"2025-09-02T12:00:00Z","level":"info","tool":"generate-local-llama-swap","msg":"...","key":"value"}
 * Stdout stays reserved for machine-consumed output — never log to it.
 *
 * Env:
 *   LOG_LEVEL  debug|info|warn|error   (default: info)
 *   LOG_FORMAT json|logfmt             (default: json)
 *   LOG_TOOL   component name          (default derived per call site; each
 *              tool sets it once: setLogTool("coding-agent/generate"))
 *
 * Import via the LIB_DIR convention (docs/d023) so the same file works both in
 * place and when staged next to the generators:
 *   const { logInfo, logWarn } = await import(`${LIB_DIR}/log.mjs`);
 */

/** @type {Record<string, number>} */
const PRIOS = { debug: 0, info: 1, warn: 2, error: 3 };
const THRESH = PRIOS[(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? 1;

let tool = process.env.LOG_TOOL ?? "node";
/**
 * @param {string} name
 */
export function setLogTool(name) {
	tool = name;
}

function ts() {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * @param {unknown} v
 */
function fmtLogfmtValue(v) {
	const s = String(v);
	return /[\s"=\\]/.test(s) || s === "" ? JSON.stringify(s) : s;
}

/**
 * @param {string} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, msg, fields = {}) {
	if ((PRIOS[level] ?? 1) < THRESH) return;
	const base = { ts: ts(), level, tool, msg };
	if (process.env.LOG_FORMAT === "logfmt") {
		const rest = Object.entries(fields)
			.map(([k, v]) => `${k}=${fmtLogfmtValue(v)}`)
			.join(" ");
		const msgv = /[\s"=\\]/.test(msg) ? JSON.stringify(msg) : msg;
		process.stderr.write(
			`ts=${base.ts} level=${level} tool=${tool} msg=${msgv}${rest ? " " + rest : ""}\n`,
		);
		return;
	}
	process.stderr.write(
		JSON.stringify(
			{ ...base, ...fields },
			/** @param {string} _k @param {unknown} v */
			(_k, v) =>
				v instanceof Error ? { name: v.name, message: v.message } : v,
		) + "\n",
	);
}

/**
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
export const logDebug = (msg, fields) => emit("debug", msg, fields);
/**
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
export const logInfo = (msg, fields) => emit("info", msg, fields);
/**
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
export const logWarn = (msg, fields) => emit("warn", msg, fields);
/**
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
export const logError = (msg, fields) => emit("error", msg, fields);
