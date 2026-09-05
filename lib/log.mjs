/**
 * @fileoverview log.mjs — structured logging shared by this repo's node tools.
 *
 * One JSON object per line on stderr (LOG_FORMAT=logfmt for logfmt):
 *   {"ts":"2025-09-02T12:00:00Z","level":"info","tool":"generate-models.json","msg":"...","key":"value"}
 * Stdout stays reserved for machine-consumed output — never log to it.
 *
 * Env:
 *   LOG_LEVEL  debug|info|warn|error   (default: info)
 *   LOG_FORMAT json|logfmt             (default: json)
 *   LOG_TOOL   component name          (default derived per call site; each
 *              tool sets it once: setLogTool("coding-agent/generate"))
 *
 * Import with an env override so the same file works both in place and when
 * copied to a scratch dir (see coding-agent/generate.sh):
 *   const { logInfo, logWarn } = await import(
 *     process.env.LOG_LIB ?? new URL("../lib/log.mjs", import.meta.url));
 */

const PRIOS = { debug: 0, info: 1, warn: 2, error: 3 };
const THRESH = PRIOS[(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? 1;

let tool = process.env.LOG_TOOL ?? "node";
export function setLogTool(name) {
	tool = name;
}

function ts() {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fmtLogfmtValue(v) {
	const s = String(v);
	return /[\s"=\\]/.test(s) || s === "" ? JSON.stringify(s) : s;
}

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
		JSON.stringify({ ...base, ...fields }, (_k, v) =>
			v instanceof Error ? { name: v.name, message: v.message } : v,
		) + "\n",
	);
}

export const logDebug = (msg, fields) => emit("debug", msg, fields);
export const logInfo = (msg, fields) => emit("info", msg, fields);
export const logWarn = (msg, fields) => emit("warn", msg, fields);
export const logError = (msg, fields) => emit("error", msg, fields);

/** log at error level and process.exit(code). */
export function logDie(code, msg, fields = {}) {
	emit("error", msg, fields);
	process.exit(code);
}
