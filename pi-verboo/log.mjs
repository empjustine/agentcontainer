/**
 * @fileoverview log.mjs — this folder's structured logging: one JSON object per
 * line on stdout carrying the repo-wide `ts`/`level`/`tool`/`msg` fields
 * (docs/d045/d060).
 *
 * Two files here log (`sources.mjs`, `generate.mjs`), each naming itself once
 * with setLogTool, so every line is attributable to the file that emitted it —
 * which is also why this stays a folder-root module instead of moving into
 * either of them.
 *
 * Level filtering is the consumer's job (docs/d045, reaffirmed by d060):
 * nothing is dropped here. A producer logs the useful-but-noisy detail at
 * `debug` unconditionally and never carries a --verbose branch of its own, and
 * whoever reads the stream prunes it — `jq 'select(.level!="debug")'` for the
 * quiet view, or one level with `jq 'select(.level=="error")'`.
 *
 * Error values in fields serialize as structured objects — name, message,
 * stack, own enumerable properties — with the full cause/suppressed chain
 * walked recursively (`cause`, AggregateError `errors`, SuppressedError
 * `error`/`suppressed`). A generator failure logs its Error here, so a fetch's
 * `cause` chain is what this serialization exists for. Messages are never
 * interpolated with dynamic values: the message is the stable label, the
 * fields are the metadata (docs/d045).
 *
 * Scope is deliberately this folder's. The shared kernel this was folded out
 * of also offered a stderr stream selector and a logfmt format; this folder
 * has no call site for either — neither file writes a machine-consumed payload
 * to stdout, and JSONL is the contract (docs/d045).
 *
 * Env:
 *   LOG_TOOL  component name (default derived per call site; each file sets it
 *             once: setLogTool("pi-verboo/generate"))
 */

let tool = process.env.LOG_TOOL ?? "node";

/**
 * The component name every later line carries.
 * @param {string} name e.g. "pi-verboo/generate"
 * @returns {void}
 */
export function setLogTool(name) {
	tool = name;
}

/** @returns {string} UTC now at second precision — the `ts` field. */
function ts() {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Cause chains are user data and may be cyclic, so the walk is depth-bounded:
 * one malformed error must never hang the emit. No chain logged from this
 * folder is deeper than a wrapped fetch → wrapped parse → cause.
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
 * One log line. The message is the stable label; structured fields carry the
 * per-call metadata (docs/d045 — never interpolated into the message).
 * @param {string} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 * @returns {void}
 */
function emit(level, msg, fields = {}) {
	process.stdout.write(
		`${JSON.stringify({
			ts: ts(),
			level,
			tool,
			msg,
			.../** @type {Record<string, unknown>} */ (serialize(fields, 0)),
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
