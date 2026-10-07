/**
 * @fileoverview artifact.mjs — THE atomic artifact writer for every generator
 * in the repo (docs/d023: one shared helper, no per-generator copies).
 *
 * Contract (the repo-wide generator standard):
 *
 *   - ATOMIC SUBSTITUTION: content is written to `<out>.tmp` and renamed into
 *     place — a failed or partial write never clobbers the live artifact, and
 *     a successful run swaps the new content in as one filesystem step. There
 *     is no dry-run/plan mode (docs/d058): every artifact this writer targets
 *     is COMMITTED, so a rerun's own git diff is the review surface. A preview
 *     file could only duplicate that diff, and it would lie the moment the
 *     inputs moved on.
 *   - DEFAULT IS REPLACE: generators are the source of truth; a rerun
 *     overwrites the deployed artifact. There is no opt-in overwrite flag —
 *     `llm-reverse-proxy/generate-config.mjs`'s former OVERWRITE=1 gate was
 *     the odd one out and is gone. Hand-edited deployed artifacts have no
 *     special status: the fact table / generated layers win (edit the
 *     generator inputs, not the output).
 *   - CANONICAL (JSON manifests): `writeJsonArtifact` applies the
 *     docs/d050 schema-aware ordering on top of the atomic write, so a rerun
 *     over unchanged inputs is byte-identical. Raw `writeArtifact` remains
 *     for non-JSON text and for collection-free JSON (default-model).
 *
 * Returns the destination path — always `out`, so callers can log it or
 * post-check it without knowing how the write was performed.
 *
 * Usage:
 *   import { writeJsonArtifact } from "./artifact.mjs"; // JSON manifests
 *   import { writeArtifact } from `${LIB_DIR}/artifact.mjs`; // text output
 *   const written = writeJsonArtifact(out, doc);
 */

import { renameSync, writeFileSync } from "node:fs";
import { serializeArtifact } from "./canonical-json.mjs";

export { canonicalizeManifest, serializeArtifact } from "./canonical-json.mjs";

/**
 * Atomically write `text` to `out` (header contract: tmp + rename, replace).
 * @param {string} out destination path
 * @param {string} text full file content
 * @returns {string} the destination path
 */
export function writeArtifact(out, text) {
	const tmp = `${out}.tmp`;
	writeFileSync(tmp, text, "utf-8");
	renameSync(tmp, out); // atomic on the same filesystem
	return out;
}

/**
 * JSON-manifest writer: canonical serialization (docs/d050) fused with the
 * atomic write (docs/d023) at the ONE choke point, so a builder cannot emit
 * order-churning bytes without deliberately bypassing both contracts.
 * @param {string} out destination path (writeArtifact contract)
 * @param {unknown} value manifest to serialize canonically
 * @returns {string} path actually written (writeArtifact contract)
 */
export function writeJsonArtifact(out, value) {
	return writeArtifact(out, serializeArtifact(value));
}
