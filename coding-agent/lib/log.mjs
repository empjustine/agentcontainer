/**
 * @fileoverview log.mjs — structured logging shared by this repo's node tools.
 *
 * One JSON object per line on stdout (LOG_FORMAT=logfmt for logfmt):
 *   {"msg":"...","key":"value","ts":1756824000000,"severityNumber":9,"tool":"coding-agent/generate"}
 *
 * `msg` leads and the fields this kernel fills in trail it, so the event is
 * what a truncated view keeps. `ts` is Unix epoch MILLISECONDS as a number, and
 * `severityNumber` is OpenTelemetry's SeverityNumber — the level name folded
 * into bands of four so a consumer compares numbers instead of matching words.
 * docs/d151 owns the record shape and its field order; the canonical ranges are
 * TRACE 1-4, DEBUG 5-8, INFO 9-12, WARN 13-16, ERROR 17-20, FATAL 21-24, and 0
 * is an unspecified severity.
 * @see https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
 *
 * Level filtering is the consumer's job (d045, reaffirmed by d060): no line
 * is ever dropped here. A producer logs the useful-but-noisy detail at
 * `debug` unconditionally and never carries a --verbose branch of its own
 * (d045 owns the rest of the contract — static message labels, structured
 * fields, full cause chains), and whoever reads the stream prunes it —
 * `jq 'select(.severityNumber >= 5)'` for the quiet view, or one band with
 * `jq 'select(.severityNumber >= 17)'`.
 *
 * Stream: stdout by default. A script whose stdout IS the machine-consumed
 * payload (git/audit.mjs's JSON report, search-references' results,
 * vbs-mirror-all.mjs's --list TSV) calls setLogStream("stderr") once at
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
 * Import via the LIB_DIR convention (docs/d023), so a consumer never has to
 * know where its own sources sit relative to the shared kernel:
 *   const { logInfo, logWarn } = await import(`${LIB_DIR}/log.mjs`);
 * A lib that must also load on Windows imports through pathToFileURL()
 * instead — a `C:\...` specifier parses as a URL scheme and is rejected by
 * the ESM loader (git/git-lib.mjs, docs/d062).
 */

let tool = process.env.LOG_TOOL ?? "node";
/**
 * @param {string} name
 * @returns {void}
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
 * @returns {void}
 */
export function setLogStream(name) {
	stream = name === "stderr" ? process.stderr : process.stdout;
}

/**
 * Each level's wire value, as an index into OpenTelemetry's severity bands
 * (docs/d151): the four levels this kernel emits sit on their band's floor,
 * and the remaining anchors are here so a new helper inherits the scale
 * instead of re-deriving it.
 * @type {Record<string, number>}
 */
const SEVERITY_NUMBER = {
	trace: 1,
	debug: 5,
	info: 9,
	warn: 13,
	error: 17,
	fatal: 21,
};

/**
 * A level name as its SeverityNumber. An unknown level fails here rather than
 * serializing to `undefined`: a record with no severity is a record nobody can
 * sort, so the call site that spelled the level wrong is what has to change.
 * @param {string} level
 * @returns {number}
 */
function severityNumber(level) {
	const number = SEVERITY_NUMBER[level];
	if (number === undefined) {
		throw Object.assign(new Error("unknown log level"), { level });
	}
	return number;
}

/**
 * Cause/suppressed chains are user data; a cyclic one must not hang the emit.
 * No real chain here is deeper than a wrapped fetch → wrapped parse → cause.
 * @type {number}
 */
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
	if (v instanceof Error) {
		return serializeError(v, depth);
	}
	if (Array.isArray(v)) {
		return v.map((item) => serialize(item, depth + 1));
	}
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
	if (typeof err.stack === "string") {
		out.stack = err.stack;
	}
	for (const [k, v] of Object.entries(err)) {
		out[k] = serialize(v, depth + 1);
	}
	for (const k of ["cause", "errors", "error", "suppressed"]) {
		if (k in out || !(k in err)) {
			continue;
		}
		const v = /** @type {Record<string, unknown>} */ (
			/** @type {unknown} */ (err)
		)[k];
		out[k] = serialize(v, depth + 1);
	}
	return out;
}

/**
 * Logfmt escaping for a field value: objects/arrays (post-serialization) are
 * JSON-encoded inline; scalars are quoted only when whitespace/quotes/`=`/
 * backslashes or empty would otherwise corrupt the line format.
 * @param {unknown} v
 * @returns {string}
 */
function fmtLogfmtValue(v) {
	// Structured fields may be objects/arrays/errors after serialization —
	// JSON-encode those instead of leaking "[object Object]".
	if (v !== null && typeof v === "object") {
		return JSON.stringify(v);
	}
	const s = String(v);
	return /[\s"=\\]/.test(s) || s === "" ? JSON.stringify(s) : s;
}

/**
 * One log line. The message is the stable label; structured fields carry the
 * per-call metadata (docs/d045 — never interpolated into the message). The
 * level name reaches the wire as its SeverityNumber, so a record carries one
 * sortable number where it used to carry a word (docs/d151).
 * @param {string} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 * @returns {void}
 */
function emit(level, msg, fields = {}) {
	// The event leads; the three fields this kernel fills in trail it, so a
	// reader skimming raw lines, or a terminal that truncates them, meets what
	// happened before the bookkeeping (docs/d151).
	const trailer = {
		ts: Date.now(),
		severityNumber: severityNumber(level),
		tool,
	};
	if (process.env.LOG_FORMAT === "logfmt") {
		const rest = Object.entries(
			/** @type {Record<string, unknown>} */ (serialize(fields, 0)),
		)
			.map(([k, v]) => `${k}=${fmtLogfmtValue(v)}`)
			.join(" ");
		const msgv = /[\s"=\\]/.test(msg) ? JSON.stringify(msg) : msg;
		stream.write(
			`msg=${msgv}${rest ? ` ${rest}` : ""} ts=${trailer.ts} severityNumber=${trailer.severityNumber} tool=${tool}\n`,
		);
		return;
	}
	stream.write(
		`${JSON.stringify({
			msg,
			.../** @type {Record<string, unknown>} */ (serialize(fields, 0)),
			...trailer,
		})}\n`,
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
