/**
 * @fileoverview list-providers.mjs — Print one TSV row per provider override —
 * "<id>\t<modelCount>\t<baseUrl>" — so generate.sh can emit a structured log line per
 * provider (it reads these rows in a `while read` loop and logs them with log_info).
 *
 * Deliberately does NOT import lib/log.mjs: this runs from generate.sh's
 * scratch dir, where the logger is only reachable through $LOG_LIB (the
 * generators get a copy staged next to them). If that copy were missing, an
 * import here would turn a cosmetic per-provider log line into a failed run —
 * so the rows, not the log lines, are this script's output.
 *
 * Prints nothing (exit 0) for an unreadable or invalid layer, for the same
 * reason: a bad artifact must not abort the install that just succeeded.
 *
 * Usage: node list-providers.mjs <models.json>
 */

import { readFileSync } from "node:fs";

/**
 * A provider entry, as far as this listing cares.
 * @typedef {object} PiProvider
 * @property {string} [baseUrl]
 * @property {unknown[]} [models]
 */

/**
 * A `models.json`-shaped layer.
 * @typedef {object} ModelsLayer
 * @property {Record<string, PiProvider>} [providers]
 */

const file = process.argv[2];

if (!file) {
	process.stderr.write("usage: list-providers.mjs <models.json>\n");
	process.exit(2);
}

/** @type {ModelsLayer} */
let doc = {};
try {
	doc = JSON.parse(readFileSync(file, "utf8"));
} catch {
	doc = {};
}

for (const [id, provider] of Object.entries(doc.providers ?? {})) {
	console.log(
		[id, (provider.models ?? []).length, provider.baseUrl ?? ""].join("\t"),
	);
}
