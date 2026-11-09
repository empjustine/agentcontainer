/**
 * @fileoverview build.mjs — build the coding-agent image for THIS host
 * (docs/d041; d083 made the build entry per-unit, docs/d113 folded the root
 * builder away — this folder now owns the target it builds).
 *
 * The compile is the image build itself: no host toolchain is involved, and
 * the target is deliberately UNGATED. d083's free-disk floor retired with the
 * node:24-trixie base (d087) — the multi-GB disk consumer on a build host was
 * the llama-swap pull, which is gated at the source where that waste happens
 * (llm-local-inference/build.mjs), not here.
 *
 * Idempotence comes from the LAYER CACHE, not from a skip check (docs/d041):
 * an unchanged build is a cache hit in seconds, and a changed Containerfile or
 * mise.toml is picked up without a flag. The former skip-if-present check was
 * retired on purpose — it keyed on tag PRESENCE, so an edited Containerfile
 * left a stale image unless the operator knew FORCE=1 (the silent-staleness
 * trap the repo's fail-loudly contract forbids). FORCE=1 now means
 * cache-bust: --no-cache.
 *
 * Env overrides: FORCE · CODING_AGENT_TAG.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectContainerTool } from "./lib/host-capabilities.mjs";
import { logError, logInfo, setLogTool } from "./lib/log.mjs";

setLogTool("coding-agent/build");

const codingAgentRoot = dirname(fileURLToPath(import.meta.url));
const force = process.env.FORCE === "1";
const tag = process.env.CODING_AGENT_TAG ?? "localhost/empjustine/coding-agent";

/**
 * Defense-in-depth line sanitizer (docs/d045). The ROOT cause of tty progress
 * leak is fixed per-tool at the source, only for tools this repo controls: the
 * Containerfile drops /etc/apt/apt.conf.d/99-no-dpkg-pty (Dpkg::Use-Pty=0 —
 * apt otherwise wraps dpkg in a pty, so dpkg renders "(Reading database ...
 * N%)" as raw \r redraw frames) and sets MISE_QUIET for mise's tty progress
 * UI. But the wrapper cannot reach every arg it spawns (dpkg invoked outside
 * apt, spinner tools not yet audited), so a redraw chain that survives to this
 * layer collapses to its final frame rather than logging every intermediate
 * spinner state as capture noise. A leaked redraw here is a bubble to add a
 * source-side fix, not a reason to rely on this path.
 * @param {string} line
 * @returns {string|null}
 */
function collapseRedrawFrames(line) {
	if (!line.includes("\r")) {
		return line;
	}
	const frames = line.split("\r").filter((frame) => frame.length > 0);
	return frames.length > 0 ? (frames.at(-1) ?? null) : null;
}

/**
 * The streams a captured child can write, as `[descriptor, name]` pairs. The
 * descriptor is what the `stream` field carries: shorter than a word, and the
 * form generalizes to any other descriptor a child was handed (a traced shell
 * script writes its xtrace to BASH_XTRACEFD) without inventing a spelling for
 * it (docs/d151).
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
 * @param {string} cmd command label ("podman image build")
 * @param {string} line
 * @returns {void}
 */
function logCommandLine(stream, cmd, line) {
	logInfo(line, { target, cmd, stream });
}

/**
 * Run one command to completion, capturing stdout+stderr LINE BY LINE and
 * re-emitting each as a structured log record (docs/d045): buildah cannot be
 * made to honor d045 itself, so the wrapping layer owns the line-boundary.
 * stdio:"inherit" would turn the parallel per-unit image builds into byte-wise
 * interleaved garbage.
 * @param {string} executable
 * @param {string[]} args
 * @param {string} cmd the command as a reader names it — executable AND
 * subcommand, so a stream of `podman image build` lines cannot be mistaken for
 * `podman image pull` ones (docs/d151)
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
					const keptLine = collapseRedrawFrames(line);
					if (!keptLine) {
						continue; // null (all-\r) or empty: not a record
					}
					logCommandLine(stream, cmd, keptLine);
				}
			});
			child[name].on("end", () => {
				// A stream ending in \n leaves an empty partial — not a line.
				if (!partial) {
					return;
				}
				const keptPartial = collapseRedrawFrames(partial);
				if (!keptPartial) {
					return;
				}
				logCommandLine(stream, cmd, keptPartial);
			});
		}
		child.on("close", (code) => resolve(code === 0));
		child.on("error", () => resolve(false));
	});
}

const target = "coding-agent-image";
const containerTool = detectContainerTool();
if (!containerTool) {
	logError(
		"no container tool — the coding-agent image needs podman or docker (there is no host-native build path)",
	);
	process.exit(91);
}

// Every image build goes through the explicit subcommand (`image build` /
// `buildx build`) rather than the backend-dependent bare `build` alias, and
// carries --progress=plain: default progress "auto" is tty-detected, and an
// agent harness often IS a pty — which renders buildah/buildx progress as
// overlapping redraw frames instead of appendable lines.
const imageBuildSubcommand =
	containerTool === "podman" ? ["image", "build"] : ["buildx", "build"];
const imageBuildArgs = [...imageBuildSubcommand, "--progress=plain"];
// Derived from the SAME array the build runs, so the `cmd` a line is filed
// under cannot drift from the command that produced it.
const imageBuildCmd = [containerTool, ...imageBuildSubcommand].join(" ");

// BUILD_DATE / UID / GID / USER are baked into the image so the sandbox user
// matches the host operator (d098's uid-mapping rule): the container writes
// into mounted host dirs as the invoking user, never as an unowned uid.
const buildDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");

logInfo("building", { target });
const ok = await run(containerTool, [
	...imageBuildArgs,
	"--pull",
	...(force ? ["--no-cache"] : []),
	"--build-arg",
	`BUILD_DATE=${buildDate}`,
	"--build-arg",
	`UID=${process.env.SUDO_UID ?? process.getuid?.() ?? ""}`,
	"--build-arg",
	`GID=${process.env.SUDO_GID ?? process.getgid?.() ?? ""}`,
	"--build-arg",
	`USER=${process.env.USER ?? ""}`,
	"--tag",
	`${tag}:${buildDate}`,
	"--tag",
	`${tag}:latest`,
	"-f",
	join(codingAgentRoot, "Containerfile"),
	codingAgentRoot,
], imageBuildCmd);
if (!ok) {
	logError("build failed", { target });
	process.exit(1);
}
logInfo("build complete", { targets: 1 });
