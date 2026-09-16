/**
 * @fileoverview generate.mjs — generate EVERYTHING at once (docs/d041):
 * spawn each runner folder's generate.mjs in sequence — llm-reverse-proxy
 * (offline, fast), llm-local-inference (capability-gated), coding-agent
 * (network-heavy). A folder failure is reported and does NOT stop the others
 * (a GPU-less host failing local-inference must not block the proxy and the
 * coding-agent catalogs); the process exits non-zero if any folder failed.
 *
 * The root entry only SPAWNS — it never imports across runner folders, so
 * each folder's standalone rule (docs/architecture.md) stays intact and every
 * folder's generate.mjs also works on its own via its own generate.sh shim.
 *
 * The node interpreter was already resolved through lib/node-run.sh by the
 * generate.sh shim, so children run under process.execPath (the same pinned
 * node).
 *
 * Env: pass-through — DRY_RUN, SKIP_GEN, MODELS_DEV_REFRESH, OPENCODE_CONFIG_DIR,
 * PI_CODING_AGENT_DIR, LOCAL_INFERENCE all reach the folder generators untouched.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logError, logInfo, setLogTool } from "./lib/log.mjs";

setLogTool("generate");

const repoRoot = dirname(fileURLToPath(import.meta.url));
// Cheap/offline first, expensive/network last.
const FOLDERS = ["llm-reverse-proxy", "llm-local-inference", "coding-agent"];

let failures = 0;
for (const folder of FOLDERS) {
	const entry = join(repoRoot, folder, "generate.mjs");
	logInfo("generating folder", { folder });
	const r = spawnSync(process.execPath, [entry], { stdio: "inherit" });
	if (r.status !== 0) {
		failures += 1;
		logError("folder generation failed — continuing with the next folder", {
			folder,
			exit: r.status,
		});
	}
}

if (failures > 0) {
	logError("generate finished with failures", {
		failed: failures,
		of: FOLDERS.length,
	});
	process.exit(1);
}
logInfo("all folders generated", { folders: FOLDERS.length });
