/**
 * @fileoverview gen-lib.mjs — shared helpers for the llm-local-inference
 * generators (config.d layer writers). Explanations live in
 * docs/d018-split-config-d.md (merge contract) and docs/d001 (key naming).
 *
 * SCOPE NOTE: this module generates ONLY the local-inference layers
 * (00-general.yaml + 10-local-llm-inference.yaml). Cloud/remote peer relaying
 * is served by ../llm-reverse-proxy (the raw passthrough proxy) — the former
 * PROVIDERS table, cloud-peer generator and gfx1030 peer probe were removed
 * with that handoff.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Structured logger from ../lib (docs/d023), resolved through the LIB_DIR
// convention (default: this folder's sibling lib/).
const LIB_DIR =
	process.env.LIB_DIR ?? fileURLToPath(new URL("../lib", import.meta.url));
const { logInfo, logWarn, logError, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
setLogTool("llm-local-inference/gen-lib");

// Re-exported for generators that write a non-JSON artifact (the local-layer
// generator's .paths staleness manifest) under the same LIB_DIR convention.
export { logError, logInfo, logWarn, writeArtifact };

export const scriptDir = dirname(fileURLToPath(import.meta.url));

// --- llama-swap config helpers ---------------------------------------

/**
 * Read the general-purpose llama-swap config source.
 * @param {string} [path] defaults to llama-swap-core.json next to this file
 * @returns {Record<string, unknown>}
 */
export function loadCore(path = join(scriptDir, "llama-swap-core.json")) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Write an object as pretty JSON into config.d/ (the YAML loader accepts JSON
 * content, and JSON-in-.yaml matches the repo's existing config style). Write
 * contract: lib/artifact.mjs (atomic tmp+rename, replace by default, DRY_RUN=1
 * preview).
 * @param {string} name layer filename (e.g. "10-local-llm-inference.yaml")
 * @param {unknown} obj config object to serialize
 * @param {string} [dir] defaults to config.d/ next to this file
 * @returns {void}
 */
export function writeConfigD(name, obj, dir = join(scriptDir, "config.d")) {
	mkdirSync(dir, { recursive: true });
	const path = writeArtifact(
		join(dir, name),
		`${JSON.stringify(obj, null, 2)}\n`,
	);
	logInfo("wrote config.d layer", { path });
}
