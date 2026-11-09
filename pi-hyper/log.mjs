/**
 * @fileoverview log.mjs — this folder's structured logging: one JSON object
 * per line on stdout. The record leads with `msg`, carries the call site's
 * fields next, and ends with this kernel's `ts`, `severityNumber` and `tool`
 * (docs/d045/d060; the order is d151's).
 *
 * `ts` is Unix epoch MILLISECONDS as a number, and `severityNumber` is
 * OpenTelemetry's SeverityNumber — the level name folded into bands of four,
 * so a reader compares numbers where it used to match level words (docs/d151
 * owns the record shape and the canonical ranges).
 *
 * Two files here log (`generate.mjs`, `sources.mjs`), each naming itself once
 * with setLogTool, so every line is attributable to the file that emitted it.
 * Level filtering is the consumer's job (docs/d045): nothing is dropped here,
 * and a reader prunes with `jq 'select(.severityNumber >= 5)'`. Messages are
 * stable labels; per-call metadata rides the structured fields and is never
 * interpolated into the message.
 *
 * Scope is deliberately this folder's. The shared kernel this was folded out
 * of also offered a stderr stream selector and a logfmt format; this folder
 * has no call site for either — nothing here writes a machine-consumed payload
 * to stdout, and JSONL is the contract (docs/d045). Nothing here emits a
 * `warn` line either, so there is no logWarn: the surface is exactly what the
 * two call sites use.
 */

let tool = process.env.LOG_TOOL ?? "node";

/**
 * The component name every later line carries.
 * @param {string} name e.g. "pi-cline-pass/generate"
 * @returns {void}
 */
export function setLogTool(name) {
	tool = name;
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
 * Cause chains are user data and may be cyclic, so the walk is depth-bounded:
 * one malformed error must never hang the emit. No chain logged from this
 * folder is deeper than a wrapped fetch → wrapped parse → cause.
 * @type {number}
 */
const MAX_SERIALIZATION_DEPTH = 8;

/**
 * A field value as JSON-safe data. Errors become structured objects, since
 * JSON.stringify would otherwise render `{}` for every one of them.
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function serialize(value, depth) {
	if (value instanceof Error) {
		return depth >= MAX_SERIALIZATION_DEPTH
			? { name: value.name, message: value.message }
			: serializeError(value, depth);
	}
	if (depth >= MAX_SERIALIZATION_DEPTH) {
		return "[max depth]";
	}
	if (Array.isArray(value)) {
		return value.map((item) => serialize(item, depth + 1));
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, serialize(item, depth + 1)]),
		);
	}
	return value;
}

/**
 * `cause`, AggregateError's `errors` and SuppressedError's `error`/`suppressed`
 * are NON-enumerable own properties (verified on node 24), so Object.entries
 * misses them and they are walked explicitly. Properties attached with
 * `Object.assign(err, …)` ARE enumerable and arrive through the general pass.
 * @param {Error} err
 * @param {number} depth
 * @returns {Record<string, unknown>}
 */
function serializeError(err, depth) {
	/** @type {Record<string, unknown>} */
	const out = { name: err.name, message: err.message };
	if (typeof err.stack === "string") {
		out.stack = err.stack;
	}
	for (const [key, value] of Object.entries(err)) {
		out[key] = serialize(value, depth + 1);
	}
	for (const key of ["cause", "errors", "error", "suppressed"]) {
		if (key in out || !(key in err)) {
			continue;
		}
		out[key] = serialize(
			/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (err))[
				key
			],
			depth + 1,
		);
	}
	return out;
}

/**
 * One log line: the message is the stable label, the fields the metadata
 * (docs/d045).
 * @param {string} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 * @returns {void}
 */
function emit(level, msg, fields = {}) {
	// The event leads; the three fields this kernel fills in trail it, so a
	// reader skimming raw lines, or a terminal that truncates them, meets what
	// happened before the bookkeeping (docs/d151).
	process.stdout.write(
		`${JSON.stringify({
			msg,
			.../** @type {Record<string, unknown>} */ (serialize(fields, 0)),
			ts: Date.now(),
			severityNumber: severityNumber(level),
			tool,
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
export const logError = (msg, fields) => emit("error", msg, fields);
