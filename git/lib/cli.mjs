/**
 * @fileoverview cli.mjs — the argv and entry scaffolding every tool in this
 * folder shares. Two things live here and nothing else does:
 *
 *   - `parseFlags` — ONE flag loop, so all seven entries reject an unknown flag
 *     with the same message and the same `{ flag }` field, and none of them can
 *     forget that a value-taking flag consumes the next argv entry. Each tool
 *     keeps its OWN table, because the flag set is that tool's interface, not
 *     plumbing.
 *   - `runEntry` — the `main().catch` tail every entry repeats: log
 *     `<tool> aborted` with the full error and exit 1.
 *
 * The loop is deliberately literal about missing values: `--root` at the end
 * of argv yields `undefined` (and `NaN` for a number flag), exactly as the
 * seven hand-written loops did. A port must not improve an interface nobody
 * asked to change — an operator's script that relied on the loose behaviour
 * keeps working, and the change that tightens it is a decision, not a
 * refactor's side effect.
 */

import { logError } from "./git-core.mjs";

/**
 * How a positional (non-flag) argv entry is treated.
 *   reject — any positional is an unknown flag (a tool whose input is flags only)
 *   last   — the last positional wins (a single-file tool)
 *   list   — positionals accumulate
 *   join   — positionals are one space-joined string (a query the shell split)
 * @typedef {"reject"|"last"|"list"|"join"} PositionalPolicy
 */

/**
 * One flag in a tool's table.
 * @typedef {object} FlagSpec
 * @property {string[]} [names] argv spellings; defaults to `--<key>`
 * @property {"string"|"number"|"bool"|"list"} [kind] defaults to "string"
 * @property {unknown} [default] the value when the flag never appears
 */

/**
 * @param {string[]|undefined} names
 * @param {string} key
 */
function flagNames(names, key) {
	return new Set(names ?? [`--${key}`]);
}

/**
 * The unknown-flag error, in the one shape every caller already threw: the
 * message a user sees, plus the offending token as a field (the run wrapper
 * serializes it, so the log line names the flag that died).
 * @param {string} token
 * @returns {Error & { flag: string }}
 */
function unknownFlag(token) {
	return Object.assign(new Error("unknown flag (try --help)"), {
		flag: token,
	});
}

/**
 * @param {string[]} argv
 * @param {Record<string, FlagSpec>} table
 * @param {PositionalPolicy} [positionals]
 * @returns {{ values: Record<string, any>, positionals: string[], help: boolean }}
 */
export function parseFlags(argv, table, positionals = "reject") {
	/** @type {Record<string, any>} */
	const values = {};
	/** @type {Map<string, string>} */
	const byName = new Map();
	for (const [key, spec] of Object.entries(table)) {
		values[key] = spec.kind === "list" ? [] : spec.default;
		for (const name of flagNames(spec.names, key)) {
			byName.set(name, key);
		}
	}
	/** @type {string[]} */
	const collected = [];
	let help = false;
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		// The loop condition guarantees a value; the check is the type gate's
		// form of that fact.
		if (token === undefined) {
			break;
		}
		if (token === "-h" || token === "--help") {
			help = true;
			continue;
		}
		const key = byName.get(token);
		if (key === undefined) {
			if (positionals === "reject" || token.startsWith("-")) {
				throw unknownFlag(token);
			}
			collected.push(token);
			continue;
		}
		const spec = table[key];
		// A boolean is the whole flag: it consumes nothing, so a following
		// `--no-optimize` stays a flag instead of becoming `--deep-optimize`'s
		// value. Everything else takes the next token — unfetched at the end of
		// argv is the loose case the hand-written loops had: no value, no
		// complaint.
		if (spec?.kind === "bool") {
			values[key] = true;
			continue;
		}
		const raw = argv[++i];
		switch (spec?.kind) {
			case "number":
				values[key] = Number(raw);
				break;
			case "list": {
				const list = /** @type {unknown[]} */ (values[key]);
				list.push(raw);
				break;
			}
			default:
				values[key] = raw;
		}
	}
	// The policy's own answer, under one key, so an entry never re-derives it:
	// the last token, all of them, or the one query the shell split apart.
	switch (positionals) {
		case "last":
			values.positional = collected.at(-1);
			break;
		case "list":
			values.positional = collected;
			break;
		case "join":
			values.positional = collected.join(" ");
			break;
		default:
			break;
	}
	return { values, positionals: collected, help };
}

/**
 * Run an entry's body, reporting any throw as the folder's one abort line and
 * exit status 1. Awaited by the entry so a rejection cannot slip past it.
 *
 * `report` exists for the one entry whose abort line is a different SHAPE, not
 * a different policy: forge-mirror flattens a git failure to `{error, detail}`
 * because its errors carry a child process's stderr, which the generic
 * serializer would render as an unreadable nested blob.
 * @param {string} label  the tool name the log line carries, e.g. "audit"
 * @param {() => unknown | Promise<unknown>} body
 * @param {{ report?: (err: any) => Record<string, unknown> }} [hooks]
 * @returns {Promise<void>}
 */
export async function runEntry(label, body, { report } = {}) {
	try {
		await body();
	} catch (err) {
		logError(`${label} aborted`, report ? report(err) : { error: err });
		process.exit(1);
	}
}
