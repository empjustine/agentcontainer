/**
 * @fileoverview filter-relays.mjs — Drop provider overrides whose baseUrl points at a
 * relay that is invalid on this host.
 *
 * generate-models.json.mjs probes localhost:18080 (the DEPRECATED local
 * inference port) and localhost:8080 — which on a peers-only host is ourselves,
 * so an override pointing there would make pi talk to the peer router it is
 * already bypassing. Both are only correct when that relay is actually in play,
 * so generate.sh passes its LOCAL_INFERENCE / SELF_RELAY switches in (both are
 * 1 on container hosts, 0 on Termux).
 *
 * The layer is rewritten in place and the dropped providers are printed as
 * "<id> <baseUrl>, ..." — empty output means nothing was dropped. An unreadable
 * or invalid layer is left untouched and produces no output: the caller's
 * fallback chain already copes with a missing models.json, so a parse failure
 * here must not abort the run (generate.sh runs under `set -e`).
 *
 * Usage: node filter-relays.mjs <models.json> <keepLocal18080:0|1> <keepSelf8080:0|1>
 */

import { readFileSync, writeFileSync } from "node:fs";

/**
 * A provider entry, as far as this filter cares.
 * @typedef {object} PiProvider
 * @property {string} [baseUrl]
 */

/**
 * A `models.json`-shaped layer.
 * @typedef {object} ModelsLayer
 * @property {Record<string, PiProvider>} [providers]
 */

const [file, keepLocalArg, keepSelfArg] = process.argv.slice(2);

if (!file || keepLocalArg === undefined || keepSelfArg === undefined) {
	process.stderr.write(
		"usage: filter-relays.mjs <models.json> <keepLocal18080:0|1> <keepSelf8080:0|1>\n",
	);
	process.exit(2);
}

const keepLocal = keepLocalArg === "1";
const keepSelf = keepSelfArg === "1";

/** @type {ModelsLayer} */
let doc = {};
try {
	doc = JSON.parse(readFileSync(file, "utf8"));
} catch {
	process.exit(0); // unreadable/invalid — leave the layer alone, print nothing
}

const providers = doc.providers ?? {};
const dropped = [];
for (const id of Object.keys(providers)) {
	const baseUrl = String(providers[id]?.baseUrl ?? "");
	const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1):18080(\/|$)/.test(
		baseUrl,
	);
	const isSelf = /^https?:\/\/(localhost|127\.0\.0\.1):8080(\/|$)/.test(
		baseUrl,
	);
	if ((isLocal && !keepLocal) || (isSelf && !keepSelf)) {
		dropped.push(`${id} ${baseUrl}`);
		delete providers[id];
	}
}

if (dropped.length) {
	writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
	process.stdout.write(dropped.join(", "));
}
