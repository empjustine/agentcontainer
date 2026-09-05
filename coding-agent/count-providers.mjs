/**
 * @fileoverview count-providers.mjs — Print how many provider overrides a models.json
 * layer carries.
 *
 * generate.sh uses this to decide whether to install the layer: an EMPTY
 * provider map is a valid outcome of the detection cascade (every provider
 * reachable directly ⇒ nothing to override), and installing it would wipe a
 * working models.json. So the count — not the file's existence — is the
 * install condition.
 *
 * Prints `0` (and exits 0) for an unreadable or invalid layer: that leaves the
 * caller on its "keep what is there" path instead of aborting under `set -e`.
 *
 * Usage: node count-providers.mjs <models.json>   -> prints a number
 */

import { readFileSync } from "node:fs";

/**
 * A `models.json`-shaped layer.
 * @typedef {object} ModelsLayer
 * @property {Record<string, unknown>} [providers]
 */

const file = process.argv[2];

if (!file) {
	process.stderr.write("usage: count-providers.mjs <models.json>\n");
	process.exit(2);
}

/** @type {ModelsLayer} */
let doc = {};
try {
	doc = JSON.parse(readFileSync(file, "utf8"));
} catch {
	doc = {};
}

process.stdout.write(String(Object.keys(doc.providers ?? {}).length));
