/**
 * @fileoverview build.mjs — build this unit's serving artifact for THIS host
 * (docs/d041; d083 made the build entry per-unit, docs/d104 folded the root
 * builder away). There is nothing to compile: the OCI workflow means llama-swap
 * arrives as a pre-pulled image, so the target is one pull of the image run.sh
 * will use.
 *
 * The pull is GATED on this host being an inference ENDPOINT (docs/d087) —
 * render devices AND the RAM floor, the SAME gate generate.mjs puts on its
 * serving layer (shared probes, lib/host-capabilities.mjs): against a
 * non-endpoint host the pull is a wasted multi-GB download of an image that
 * cannot serve (no accelerator to run llama.cpp on, or too little RAM for
 * weights + KV cache), and run.sh would refuse to launch anyway (its
 * config.d layer gate dies first). This pull — not the coding-agent image — is
 * what d083's retired free-disk floor was really protecting.
 *
 * Idempotence comes from the image store: a pull of an already-present tag is
 * a manifest check, not a download, so there is no FORCE knob — the tag is a
 * moving reference by design and every run re-resolves it.
 *
 * Env overrides: LLAMA_SWAP_IMAGE.
 */

import { spawn } from "node:child_process";
import {
	INFERENCE_MIN_RAM_GIB,
	detectContainerTool,
	detectGpuDevices,
	totalMemGiB,
} from "./lib/host-capabilities.mjs";
import { logError, logInfo, logWarn, setLogTool } from "./lib/log.mjs";

setLogTool("llm-local-inference/build");

const target = "llama-swap-image";
const llamaSwapImage =
	process.env.LLAMA_SWAP_IMAGE ??
	"ghcr.io/mostlygeek/llama-swap:unified-vulkan";

/**
 * Run one command to completion, capturing stdout+stderr LINE BY LINE and
 * re-emitting each as a structured log record (docs/d045): the container
 * backend is an upstream that cannot be made to honor d045 itself, so the
 * wrapping layer owns the line-boundary.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<boolean>} success
 */
async function run(cmd, args) {
	return await new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		// The union literal (not a bare string[] loop variable) is what makes
		// child[stream] a known-property index under checkJs.
		for (const stream of /** @type {("stdout"|"stderr")[]} */ ([
			"stdout",
			"stderr",
		])) {
			let partial = "";
			child[stream].setEncoding("utf8");
			child[stream].on("data", (/** @type {string} */ chunk) => {
				partial += chunk;
				const lines = partial.split("\n");
				// split on a non-empty string never yields an empty tail, so the
				// undefined side of pop() is unreached; ?? satisfies exactOptional.
				partial = /** @type {string} */ (lines.pop());
				for (const line of lines) {
					// tty-redrawn progress arrives as \r-separated frames in one
					// line; only the final frame carries information (docs/d045).
					const kept = line.includes("\r")
						? (line.split("\r").filter(Boolean).at(-1) ?? "")
						: line;
					if (!kept) {
						continue;
					}
					logInfo("command output", { target, cmd, stream, line: kept });
				}
			});
			child[stream].on("end", () => {
				if (!partial) {
					return;
				}
				logInfo("command output", { target, cmd, stream, line: partial });
			});
		}
		child.on("close", (code) => resolve(code === 0));
		child.on("error", () => resolve(false));
	});
}

const containerTool = detectContainerTool();
const renderDevices = detectGpuDevices();
const hostRamGiB = totalMemGiB();

if (containerTool === null) {
	logError("no container tool — the llama-swap image needs podman or docker");
	process.exit(91);
}

// The gate is the endpoint definition itself, not a proxy for it: a host that
// cannot serve has no use for the pull. LOCAL_INFERENCE=1 is NOT honored here
// on purpose — generate.mjs's debug override generates a config, but an image
// this host cannot run is a wasted download regardless.
if (renderDevices.length === 0 || hostRamGiB < INFERENCE_MIN_RAM_GIB) {
	logWarn("skipping target — host is not an inference endpoint", {
		target,
		renderDevices: renderDevices.length,
		ramGiB: hostRamGiB,
		minRamGiB: INFERENCE_MIN_RAM_GIB,
	});
	process.exit(0);
}

logInfo("building", { target });
const ok = await run(containerTool, ["image", "pull", llamaSwapImage]);
if (!ok) {
	logError("build failed", { target });
	process.exit(1);
}
logInfo("build complete", { targets: 1 });
