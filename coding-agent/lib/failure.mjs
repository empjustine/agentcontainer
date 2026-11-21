/**
 * @fileoverview failure.mjs — the ONE shape a coding-agent entry point uses to
 * stop on an error (docs/d225): an Error carrying the process exit code the CLI
 * contract names, thrown up to the top-level handler, which logs it once and
 * sets process.exitCode. This module never touches the process, so every
 * `finally` between the throw and that handler still runs — the property the
 * retired `die()`/`process.exit()` pair could not give.
 *
 * The key is `Symbol.for("process.exitCode")`, not the string "exitCode": a
 * string would collide with any error that happens to carry that word (a
 * child_process error, a library's own field), and this unit's lib/ is a per
 * folder copy (docs/d113) — Symbol.for's global registry makes every copy
 * agree on the same key without a shared import.
 *
 * Usage:
 *   throw failure("no workload backend available", 91, { backend: null });
 */

/** The global-registry symbol an exit code rides on; exitCodeOf is the reader. */
const EXIT_CODE = Symbol.for("process.exitCode");

/**
 * @param {string} message static label — the structured detail goes in `fields`
 *   (docs/d045: the message is the stable label, the fields are the metadata)
 * @param {number} exitCode the process status this failure maps to
 * @param {Record<string, unknown>} [fields]
 * @returns {Error & { [EXIT_CODE]: number, fields?: Record<string, unknown> }}
 */
export function failure(message, exitCode, fields) {
	return Object.assign(new Error(message), {
		[EXIT_CODE]: exitCode,
		...(fields === undefined ? {} : { fields }),
	});
}

/**
 * The exit code a value carries, or undefined when it carries none (an
 * unexpected throw, a foreign error). The top-level handler is the only caller.
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function exitCodeOf(value) {
	const code =
		typeof value === "object" && value !== null
			? /** @type {Record<symbol, unknown>} */ (value)[EXIT_CODE]
			: undefined;
	return typeof code === "number" ? code : undefined;
}
