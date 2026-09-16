/**
 * @fileoverview log.mjs — structured logging shared by this repo's node tools.
 *
 * One JSON object per line on stdout (LOG_FORMAT=logfmt for logfmt):
 *   {"ts":"2025-09-02T12:00:00Z","level":"info","tool":"generate-pi-coding-agent","msg":"...","key":"value"}
 *
 * No level filtering happens here, ever — debug/trace/warn/error all go to the
 * stream; a consumer that wants less noise filters downstream with jsonlines
 * tooling (`jq 'select(.level=="error")'`). The producer's only judgment call
 * is WHICH level to label a line, never whether to drop it (docs/d045).
 *
 * Stream: stdout by default. A script whose stdout IS the machine-consumed
 * payload (git/audit.mjs's JSON report, search-references' results,
 * -vbs-mirror-all.sh's --list TSV) calls setLogStream("stderr") once at
 * startup so logs cannot interleave with the payload; `2>&1 | jq` still gives
 * the consumer one jsonlines stream. Docs/d045 owns the policy.
 *
 * Error values in fields serialize as structured objects — name, message,
 * stack, own enumerable properties — with the full cause/suppressed chain
 * walked recursively (`cause`, AggregateError `errors`, SuppressedError
 * `error`/`suppressed`). Messages are never interpolated with dynamic values:
 * the message is the stable label, the fields are the metadata (docs/d045).
 *
 * Env:
 *   LOG_FORMAT  json|logfmt   (default: json)
 *   LOG_TOOL    component name (default derived per call site; each tool sets
 *               it once: setLogTool("coding-agent/generate"))
 *
 * Import via the LIB_DIR convention (docs/d023) so the same file works both in
 * place and when staged next to the generators:
 *   const { logInfo, logWarn } = await import(`${LIB_DIR}/log.mjs`);
 */

let tool = process.env.LOG_TOOL ?? "node";
/**
 * @param {string} name
 */
export function setLogTool(name) {
	tool = name;
}

let stream = /** @type {{ write(chunk: string): unknown }} */ (
	/** @type {unknown} */ (process.stdout)
);
/**
 * Route the log stream away from stdout for scripts whose stdout is a
 * machine-consumed payload (docs/d045). "stdout" restores the default.
 * @param {"stdout"|"stderr"} name
 */
export function setLogStream(name) {
	stream = name === "stderr" ? process.stderr : process.stdout;
}

function ts() {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Cause/suppressed chains are user data; a cyclic one must not hang the emit.
// No real chain here is deeper than a wrapped fetch → wrapped parse → cause.
const MAX_SERIALIZATION_DEPTH = 8;

/**
 * Serialize a log field value. Errors become structured objects (name,
 * message, stack, own enumerable properties, plus the explicitly walked
 * non-enumerable `cause`/`errors`/`error`/`suppressed`); plain objects and
 * arrays recurse; primitives pass through.
 * @param {unknown} v
 * @param {number} depth
 * @returns {unknown}
 */
function serialize(v, depth) {
	if (depth >= MAX_SERIALIZATION_DEPTH) {
		return v instanceof Error
			? { name: v.name, message: v.message }
			: Array.isArray(v)
				? "[max depth]"
				: { "[max depth]": true };
	}
	if (v instanceof Error) return serializeError(v, depth);
	if (Array.isArray(v)) return v.map((item) => serialize(item, depth + 1));
	if (v !== null && typeof v === "object") {
		return Object.fromEntries(
			Object.entries(v).map(([k, item]) => [k, serialize(item, depth + 1)]),
		);
	}
	return v;
}

/**
 * `cause`, AggregateError's `errors`, and SuppressedError's `error`/`suppressed`
 * are all NON-enumerable own properties (verified on node 24) — Object.entries
 * misses them, so they are walked explicitly. Attached properties from
 * `Object.assign(err, {...})` ARE enumerable and flow through the general pass.
 * @param {Error} err
 * @param {number} depth
 * @returns {unknown}
 */
function serializeError(err, depth) {
	/** @type {Record<string, unknown>} */
	const out = { name: err.name, message: err.message };
	if (typeof err.stack === "string") out.stack = err.stack;
	for (const [k, v] of Object.entries(err)) {
		out[k] = serialize(v, depth + 1);
	}
	for (const k of ["cause", "errors", "error", "suppressed"]) {
		if (k in out || !(k in err)) continue;
		const v = /** @type {Record<string, unknown>} */ (
			/** @type {unknown} */ (err)
		)[k];
		out[k] = serialize(v, depth + 1);
	}
	return out;
}

/**
 * @param {unknown} v
 */
function fmtLogfmtValue(v) {
	// Structured fields may be objects/arrays/errors after serialization —
	// JSON-encode those instead of leaking "[object Object]".
	if (v !== null && typeof v === "object") return JSON.stringify(v);
	const s = String(v);
	return /[\s"=\\]/.test(s) || s === "" ? JSON.stringify(s) : s;
}

/**
 * @param {string} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, msg, fields = {}) {
	const base = { ts: ts(), level, tool, msg };
	if (process.env.LOG_FORMAT === "logfmt") {
		const rest = Object.entries(
			/** @type {Record<string, unknown>} */ (serialize(fields, 0)),
		)
			.map(([k, v]) => `${k}=${fmtLogfmtValue(v)}`)
			.join(" ");
		const msgv = /[\s"=\\]/.test(msg) ? JSON.stringify(msg) : msg;
		stream.write(
			`ts=${base.ts} level=${level} tool=${tool} msg=${msgv}${rest ? " " + rest : ""}\n`,
		);
		return;
	}
	stream.write(
		JSON.stringify({
			...base,
			.../** @type {Record<string, unknown>} */ (serialize(fields, 0)),
		}) + "\n",
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
