/**
 * @fileoverview artifact.mjs — THE atomic artifact writer for every generator
 * in the repo (docs/d023: one shared helper, no per-generator copies).
 *
 * Contract (the repo-wide generator standard):
 *
 *   - ATOMIC: content is written to `<out>.tmp` and renamed into place — a
 *     failed or partial write never clobbers the live artifact.
 *   - DEFAULT IS REPLACE: generators are the source of truth; a rerun
 *     overwrites the deployed artifact. There is no opt-in overwrite flag —
 *     `llm-reverse-proxy/generate-config.mjs`'s former OVERWRITE=1 gate was
 *     the odd one out and is gone. Hand-edited deployed artifacts have no
 *     special status: the fact table / generated layers win (edit the
 *     generator inputs, not the output).
 *   - DRY_RUN=1: the rename into place is SKIPPED — the live artifact is
 *     never touched. The content lands in `<out>.dry-run` (an inspectable
 *     preview) and a warn states exactly what would have been replaced.
 *
 * The logger is the shared lib/log.mjs module instance: generators import
 * log.mjs themselves (usually via the LIB_DIR staging convention), so
 * setLogTool there governs the `tool` field of these lines too.
 *
 * Returns the path actually written — the destination on a normal run, the
 * preview path under DRY_RUN=1 — so callers log the truth.
 *
 * Usage:
 *   import { writeArtifact } from "./artifact.mjs";   // from inside lib/
 *   import { writeArtifact } from `${LIB_DIR}/artifact.mjs`; // generators
 *   const written = writeArtifact(out, `${JSON.stringify(cfg, null, 2)}\n`);
 */

import { renameSync, writeFileSync } from "node:fs";
import { logWarn } from "./log.mjs";

/** @returns {boolean} true when DRY_RUN=1 (artifact replacement suppressed) */
export function isDryRun() {
	return process.env.DRY_RUN === "1";
}

/**
 * Atomically write `text` to `out`, honoring DRY_RUN (see the header).
 * @param {string} out destination path
 * @param {string} text full file content
 * @returns {string} path actually written (out, or the DRY_RUN preview)
 */
export function writeArtifact(out, text) {
	const tmp = `${out}.tmp`;
	writeFileSync(tmp, text, "utf-8");
	if (isDryRun()) {
		const preview = `${out}.dry-run`;
		renameSync(tmp, preview); // atomic on the same filesystem
		logWarn("dry-run — artifact NOT replaced; preview written", {
			artifact: out,
			preview,
			bytes: text.length,
		});
		return preview;
	}
	renameSync(tmp, out); // atomic on the same filesystem
	return out;
}
