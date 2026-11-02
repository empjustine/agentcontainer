/**
 * @fileoverview jq-free.test.mjs — the unit's entrypoints must not need `jq` on
 * PATH (the port retired lib/workload-*.jq and lib/workload-runtime.sh).
 *
 * WHY IT EXISTS: dropping jq as a host prerequisite is the whole point of
 * moving the workload API to node, and a leftover `jq` call is invisible in
 * review — it costs nothing on a dev host that has jq installed and breaks only
 * on the host that does not. The static half of the guard is here; the runtime
 * half (a tripwire `jq` ahead on PATH while the launcher runs) lives in
 * check-run-dirs.test.mjs, which already has a host fixture to launch.
 *
 * Run: . ./lib/node-run.sh && node_run --test tests/*.test.mjs   (from ./coding-agent)
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const unit = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * A jq INVOCATION, not a mention: the launchers' prose explains what the port
 * removed, so comments are stripped before this runs.
 */
const INVOCATION = /(?:^|[\s;&|("'])jq(?![\w-])/;

/**
 * Drop comments so the guard reads code only. Shell keeps trailing text (a
 * `#` mid-line may be inside a string); node also drops block comments.
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
function stripComments(name, body) {
	if (name.endsWith(".mjs")) {
		return body
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("//"))
			.join("\n");
	}
	return body
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

/**
 * @param {string} dir
 * @param {(path: string, name: string) => boolean} keep
 * @param {string} [prefix]
 * @returns {[string, string][]} [path relative to the unit, body]
 */
function sources(dir, keep, prefix = "") {
	/** @type {[string, string][]} */
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const name = `${prefix}${entry.name}`;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...sources(path, keep, `${name}/`));
		} else if (keep(name, entry.name)) {
			found.push([name, readFileSync(path, "utf8")]);
		}
	}
	return found;
}

test("no jq filter files remain in the unit", () => {
	const jqFiles = sources(unit, (_name, file) => file.endsWith(".jq")).map(
		([name]) => name,
	);
	assert.deepEqual(jqFiles, []);
});

test("no entrypoint invokes jq", () => {
	// The entrypoints and their libs — tests/ is excluded because a test
	// deliberately PLACES a tripwire jq on PATH (check-run-dirs.test.mjs).
	const offenders = sources(
		unit,
		(name, file) => /\.(sh|mjs)$/.test(file) && !name.startsWith("tests/"),
	)
		.filter(([name, body]) => INVOCATION.test(stripComments(name, body)))
		.map(([name]) => name);
	assert.deepEqual(offenders, []);
});
