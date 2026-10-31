/**
 * @fileoverview generate.mjs — generate EVERYTHING at once (docs/d041):
 * spawn each runner folder's generator in sequence — estige (offline,
 * fast), llm-local-inference (capability-gated), coding-agent
 * (network-heavy). A folder failure is reported and does NOT stop the others
 * (a GPU-less host failing local-inference must not block the proxy and the
 * coding-agent catalogs); the process exits non-zero if any folder failed.
 *
 * The root entry only SPAWNS — it never imports across runner folders, so
 * each folder's standalone rule (docs/architecture.md) stays intact and every
 * folder's generator also works on its own (its own generate.sh shim where
 * the folder is node-based).
 *
 * estige is all-Go since docs/d102: its generator is the proxy binary's own
 * `generate` subcommand, invoked as `go run .` from the folder — source is
 * always what runs, so there is no stale-binary trap, and the host running
 * this needs the go toolchain (it needs it to build estige anyway). The node
 * interpreter for the remaining folders was already resolved through
 * lib/node-run.sh by the generate.sh shim, so they run under
 * process.execPath (the same pinned node).
 *
 * Env: pass-through — OPENCODE_CONFIG_DIR, PI_CODING_AGENT_DIR,
 * LOCAL_INFERENCE reach the folder generators untouched (each is read by
 * the folder that owns it; `SKIP_GEN` was retired in docs/d070).
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { goToolchainReady } from "./lib/go-build.mjs";
import { logError, logInfo, setLogTool } from "./lib/log.mjs";

setLogTool("generate");

const repoRoot = dirname(fileURLToPath(import.meta.url));
/**
 * Cheap/offline first, expensive/network last.
 * @type {readonly {folder: string, cmd: string, args: readonly string[], cwd?: string}[]}
 */
const FOLDERS = [
	{
		folder: "estige",
		cmd: "go",
		args: ["run", ".", "generate"],
		cwd: join(repoRoot, "estige"),
	},
	{
		folder: "llm-local-inference",
		cmd: process.execPath,
		args: [join(repoRoot, "llm-local-inference", "generate.mjs")],
	},
	{
		folder: "coding-agent",
		cmd: process.execPath,
		args: [join(repoRoot, "coding-agent", "generate.mjs")],
	},
];

let failures = 0;
for (const { folder, cmd, args, cwd } of FOLDERS) {
	logInfo("generating folder", { folder });
	// The estige leg spawns `go` from the caller's PATH. There is no repo
	// mise pin (toolchain selection is an explicit `mise exec` at the CLI,
	// repo-wide), so on a mise host the bare shim errors with "No version is
	// set" — probe first and say the fix, instead of surfacing a bare exit 1
	// from the child.
	if (cmd === "go" && !goToolchainReady()) {
		failures += 1;
		logError("no working go toolchain on PATH — run as: mise exec go@1.27 -- ./generate.mjs", {
			folder,
		});
		continue;
	}
	const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
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
