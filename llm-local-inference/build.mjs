/**
 * @fileoverview build.mjs — build this unit's serving artifact for THIS host
 * (docs/d041; d083 made the build entry per-unit, docs/d113 folded the root
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
 * The streams a captured child can write, as `[descriptor, name]` pairs. The
 * descriptor is what the `stream` field carries: shorter than a word, and the
 * form generalizes to any other descriptor a child was handed without
 * inventing a spelling for it (docs/d151).
 * @type {readonly (readonly [number, "stdout" | "stderr"])[]}
 */
const CAPTURED_STREAMS = [
	[1, "stdout"],
	[2, "stderr"],
];

/**
 * Emit one captured line as one record. The LINE is the message (docs/d151):
 * it is the only specific thing this record has to say, and a fixed label would
 * repeat down the whole stream while pushing the one varying value into a field
 * named after it.
 * @param {number} stream file descriptor the line arrived on
 * @param {string} cmd command label ("podman image pull")
 * @param {string} line
 * @returns {void}
 */
function logCommandLine(stream, cmd, line) {
	logInfo(line, { target, cmd, stream });
}

/**
 * Run one command to completion, capturing stdout+stderr LINE BY LINE and
 * re-emitting each as a structured log record (docs/d045): the container
 * backend is an upstream that cannot be made to honor d045 itself, so the
 * wrapping layer owns the line-boundary.
 * @param {string} executable
 * @param {string[]} args
 * @param {string} cmd the command as a reader names it — executable AND
 * subcommand, so `podman image pull` lines stay distinguishable from every
 * other podman subcommand in a merged stream (docs/d151)
 * @returns {Promise<boolean>} success
 */
async function run(executable, args, cmd) {
	return await new Promise((resolve) => {
		const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
		for (const [stream, name] of CAPTURED_STREAMS) {
			let partial = "";
			child[name].setEncoding("utf8");
			child[name].on("data", (/** @type {string} */ chunk) => {
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
					logCommandLine(stream, cmd, kept);
				}
			});
			child[name].on("end", () => {
				if (!partial) {
					return;
				}
				logCommandLine(stream, cmd, partial);
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
// The label names the subcommand, not just the backend: every podman line in
// a merged stream is otherwise the same `cmd` (docs/d151).
const imagePullCmd = `${containerTool} image pull`;
const ok = await run(containerTool, ["image", "pull", llamaSwapImage], imagePullCmd);
if (!ok) {
	logError("build failed", { target });
	process.exit(1);
}
logInfo("build complete", { targets: 1 });
