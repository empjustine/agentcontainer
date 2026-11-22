/**
 * @fileoverview artifact.mjs — THE atomic artifact writer for every generator
 * in the repo (docs/d023: one shared helper, no per-generator copies).
 *
 * Contract (the repo-wide generator standard):
 *
 *   - ATOMIC SUBSTITUTION: content is written to `<out>.tmp` and renamed into
 *     place — a failed or partial write never clobbers the live artifact, and
 *     a successful run swaps the new content in as one filesystem step.
 *     `copyArtifact` gives a whole-file copy the same guarantee, so a snapshot
 *     refresh cannot expose a torn file either. There is no dry-run/plan
 *     mode (docs/d058): every artifact this writer targets is COMMITTED, so a
 *     rerun's own git diff is the review surface. A preview file could only
 *     duplicate that diff, and it would lie the moment the inputs moved on.
 *   - DEFAULT IS REPLACE: generators are the source of truth; a rerun
 *     overwrites the deployed artifact. There is no opt-in overwrite flag —
 *     the estige generator's former OVERWRITE=1 gate was
 *     the odd one out and is gone. Hand-edited deployed artifacts have no
 *     special status: the fact table / generated layers win (edit the
 *     generator inputs, not the output).
 *   - CANONICAL (JSON manifests): `writeJsonArtifact` applies the
 *     docs/d050 schema-aware ordering on top of the atomic write, so a rerun
 *     over unchanged inputs is byte-identical. Raw `writeArtifact` remains
 *     for non-JSON text and for collection-free JSON (default-model).
 *   - NO PRE-FLIGHT (docs/d228): `readArtifactOrNull` takes "absent" from the
 *     READ's own errno and `backupArtifact` from the COPY's, so no caller asks
 *     whether a path exists and then acts on the answer. The test is one
 *     syscall describing a moment, the act is another, and anything may happen
 *     between them (a rotation, a tmp cleaner, a second generation).
 *
 * Returns the destination path — always `out`, so callers can log it or
 * post-check it without knowing how the write was performed.
 *
 * Usage:
 *   import { writeJsonArtifact, writeArtifact } from "./lib/artifact.mjs";
 *   const written = writeJsonArtifact(out, doc);
 */

import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { serializeArtifact } from "./canonical-json.mjs";

// The driver takes the serializer with the writer, so the pair is published
// here as one import for that consumer.
export { serializeArtifact };

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
 * Copy `from` over `to` as one rename. A byte copy straight onto a committed
 * artifact is torn by a crash or a full disk, and the next run reads the torn
 * file as its input (docs/d228 R8).
 * @param {string} from source path
 * @param {string} to destination path
 * @returns {string} the destination path
 */
export function copyArtifact(from, to) {
	const tmp = `${to}.tmp`;
	copyFileSync(from, tmp);
	renameSync(tmp, to);
	return to;
}

/**
 * The committed artifact's text, or `null` when it is ABSENT. Every other
 * errno propagates: a caller told "absent" keeps a live file in place, and an
 * unreadable one (EACCES, EISDIR, ELOOP) is a different answer that must not be
 * reported as a missing input (docs/d228).
 * @param {string} out artifact path
 * @returns {string|null} its text, or null when nothing is there
 */
export function readArtifactOrNull(out) {
	try {
		return readFileSync(out, "utf-8");
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

/**
 * Copy the artifact about to be replaced to `<out>.bak-<stamp>` — best-effort
 * insurance, not a preservation contract — and answer with the backup's path,
 * or `null` when there was nothing to keep. The copy's own ENOENT is that
 * "nothing to keep" answer, so a target removed between a caller's read and
 * this call cannot turn the backup into a failure (docs/d228).
 * @param {string} out artifact path
 * @returns {string|null} the backup path, or null when `out` was absent
 */
export function backupArtifact(out) {
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const backup = `${out}.bak-${stamp}`;
	try {
		copyFileSync(out, backup);
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
			return null;
		}
		throw error;
	}
	return backup;
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
