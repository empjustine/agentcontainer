/**
 * @fileoverview merge-models-json.mjs — Merge the layered pi model files into one
 * models.json.
 *
 * THE LAYERED CAKE (this file is the contract — the merge rules below are
 * implemented here and nowhere else):
 *
 * pi reads a single `models.json`, but every concern is generated
 * independently, so each concern writes its own *layer* and this script
 * collapses them. A deployment picks its layers simply by placing the files it
 * wants next to this script — the collector reads whatever is present at
 * runtime, so no layer needs to know about any other.
 *
 * Layer set (all in this directory):
 *
 * | File                              | Concern                                            | Produced by                                              |
 * |-----------------------------------|----------------------------------------------------|----------------------------------------------------------|
 * | `00-model-base.json`              | base foundation (usually `{}`)                     | checked in — optional; `{}` is used when absent          |
 * | `model-000-cloud-default.json`    | cloud providers                                    | no-op slot reserved for cloud — writes `{}`; cloud config lives in env vars / `auth.json` (pi auto-detects). No generator ships it today |
 * | `model-010-local-default.json`    | local llama-swap models **+ cloud-via-peer fallback** | `generate-models.json.mjs`                             |
 * | `model-015-cloud-cline-pass.json` | cloud models off the vendored models.dev catalog   | `generate-cline-pass.mjs` (no network, no secrets)        |
 * | `model-020-peer-default.json`     | peer reverse-proxy models                          | *(future)*                                               |
 *
 * Every `model-*.json` is a `models.json`-shaped layer:
 * `{ "providers": { "<id>": {...} } }` — or `{}` for a no-op layer.
 *
 * Merge order: base (`00-model-base.json`, or `{}` when absent) then every
 * `model-*.json` in **lexical filename order** — the zero-padded lexorank
 * (`000`, `010`, `015`, `020`) makes filename sort equal to merge order:
 *
 * ```text
 * 00-model-base.json  (or {})
 *   + model-000-cloud-default.json
 *   + model-010-local-default.json
 *   + model-015-cloud-cline-pass.json
 *   + model-020-peer-default.json   (future)
 *   → models.json
 * ```
 *
 * Merge semantics:
 * - `providers` merge per **provider id**; a provider defined in a later layer
 *   is added, or its fields are merged if it already exists.
 * - Within a provider, **objects** (e.g. `compat`) recursively merge;
 *   **scalar** and **array** fields (e.g. `baseUrl`, `models`) are
 *   **replaced** by the later layer.
 *
 * So a later layer *overrides* a scalar/base setting and *adds* models,
 * without the earlier layer needing to know about it.
 *
 * Usage: node merge-models-json.mjs [out]
 *   out defaults to $PI_MODELS_JSON else ./models.json.
 *   Copy the merged models.json into the container's ~/.pi/agent/models.json.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Structured logging (JSON lines on stderr; see lib/log.mjs).  The env
// override lets generate.sh point this at its scratch-dir copy.
// String() and not a bare URL: `import()` wants a string specifier, and a
// file: URL stringifies back to itself, so the default keeps working.
const { logInfo, setLogTool } = await import(
	String(process.env.LOG_LIB ?? new URL("../lib/log.mjs", import.meta.url))
);
setLogTool("coding-agent/merge-models-json");

const scriptDir = dirname(fileURLToPath(import.meta.url));

/**
 * A JSON object node; arrays and scalars are merge leaves (see header).
 * @typedef {Record<string, unknown>} JsonObject
 */

/**
 * @param {unknown} value
 * @returns {value is JsonObject} true for plain objects — arrays and null are
 *   leaves, not merge targets
 */
function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep-merge layers left to right: objects recurse, everything else is
 * replaced by the later layer.
 * @param {...unknown} layers
 * @returns {JsonObject}
 */
function deepMerge(...layers) {
	/** @type {JsonObject} */
	const out = {};
	for (const layer of layers) {
		if (!isPlainObject(layer)) continue;
		for (const [key, value] of Object.entries(layer)) {
			if (isPlainObject(value) && isPlainObject(out[key])) {
				out[key] = deepMerge(out[key], value);
			} else {
				out[key] = value;
			}
		}
	}
	return out;
}

/**
 * @param {string} path
 * @returns {unknown} the parsed document (any shape — layers are validated by
 *   the merge, not here)
 * @throws {Error} when the file is missing or not valid JSON
 */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(
			`failed to parse ${path}: ${/** @type {Error} */ (error).message}`,
		);
	}
}

/** @returns {void} */
function main() {
	const basePath = join(scriptDir, "00-model-base.json");
	const base = existsSync(basePath) ? readJson(basePath) : {};
	const overlayNames = readdirSync(scriptDir)
		.filter((name) => /^model-.*\.json$/.test(name))
		.sort();
	const layers = [
		base,
		...overlayNames.map((name) => readJson(join(scriptDir, name))),
	];
	const out =
		process.argv[2] ??
		process.env.PI_MODELS_JSON ??
		join(scriptDir, "models.json");
	const tmp = `${out}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(deepMerge(...layers), null, 2)}\n`);
	renameSync(tmp, out); // atomic on the same filesystem: a failed merge never clobbers the good artifact
	logInfo("merged layers", { overlays: overlayNames.length, path: out });
}

main();
