/**
 * @fileoverview build.mjs — build EVERYTHING for THIS host (docs/d041;
 * d041 also converted the per-folder build.sh shells into this one node
 * builder). Dual mode, detected from the environment — not a flag:
 *
 *   - Container host (podman/docker): all image targets run IN PARALLEL —
 *     every base image at once (coding-agent image build, llama-swap image
 *     pull, llm-reverse-proxy multi-stage image build; the compile for the
 *     proxy happens INSIDE the image, so no host go toolchain is needed).
 *   - Termux (PREFIX under /data/data/com.termux): strictly SERIALIZED —
 *     ~1 GB devices cannot parallelize go builds. Order: provisioning
 *     (lib/provision-termux.sh — node/jq via pkg, the infisical CLI source
 *     build) first, then the native android/arm64 proxy binary through
 *     lib/go-build.mjs.
 *   - Bare host, no container tool: the host proxy binary is the only thing
 *     this host can serve — needs go.
 *
 * Idempotence comes from the CACHES, not from skip checks (docs/d041): a
 * container build on unchanged inputs is a layer-cache hit — seconds, not
 * work — and go's build cache is content-addressed, so an unchanged binary
 * build is near-instant. Targets therefore ALWAYS run and pick up source
 * changes without a flag. The former skip-if-present checks (ported from
 * the old llm-reverse-proxy build.sh) are gone on purpose: they keyed on
 * tag/file PRESENCE, so editing main.go after a build left the stale
 * image/binary in place unless the operator knew FORCE=1 — a silent-
 * staleness trap of exactly the kind the repo's fail-loudly contract
 * forbids. FORCE=1 now means cache-bust: --no-cache for image builds,
 * `-a` (rebuild all packages) for go.
 *
 * BUILD_PLAN=1 logs the chosen target set without executing.
 *
 * Env overrides: FORCE · BUILD_PLAN · IMAGE_TAG / LLAMA_SWAP_IMAGE /
 * CODING_AGENT_TAG · GOFLAGS · plus lib/provision-termux.sh's own set.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	androidBuildEnv,
	commonBuildFlags,
	goToolchainReady,
	hostBuildEnv,
} from "./lib/go-build.mjs";
import { logError, logInfo, logWarn, setLogTool } from "./lib/log.mjs";

setLogTool("build");

const repoRoot = dirname(fileURLToPath(import.meta.url));
const termux = Boolean(process.env.PREFIX?.includes("com.termux"));
const force = process.env.FORCE === "1";
const plan = process.env.BUILD_PLAN === "1";

const containerTool = existsSync("/usr/bin/podman")
	? "podman"
	: existsSync("/usr/bin/docker")
		? "docker"
		: null;

/**
 * Defense-in-depth line sanitizer (docs/d045). The ROOT cause of tty progress
 * leak is fixed per-tool at the source, only for tools this repo controls:
 * the coding-agent Containerfile drops /etc/apt/apt.conf.d/99-no-dpkg-pty
 * (Dpkg::Use-Pty=0 — apt otherwise wraps dpkg in a pty, so dpkg renders
 * "(Reading database ... N%)" as raw \r redraw frames) and sets MISE_QUIET
 * for mise's tty progress UI. But the wrapper cannot reach every arg it
 * spawns (future Containerfiles, dpkg invoked outside apt, spinner tools not
 * yet audited), so a redraw chain that survives to this layer collapses to
 * its final frame rather than logging every intermediate spinner state as
 * capture noise. A leaked redraw here is a bubble to add a source-side fix,
 * not a reason to rely on this path.
 * @param {string} line
 * @returns {string|null}
 */
function collapseRedrawFrames(line) {
	if (!line.includes("\r")) return line;
	const frames = line.split("\r").filter((frame) => frame.length > 0);
	return frames.length > 0 ? (frames.at(-1) ?? null) : null;
}

/**
 * Run one command to completion, capturing stdout+stderr LINE BY LINE and
 * re-emitting each as a structured log record (docs/d045): child processes
 * are upstreams (buildah, apt, mise) that cannot be made to honor d045
 * themselves, so the wrapping layer owns the line-boundary. tty progress
 * redraw is handled at the SOURCE per tool (Containerfile apt Dpkg::Use-Pty
 * drop-in, MISE_QUIET) with collapseRedrawFrames as wrapper-side
 * defense-in-depth only. stdio:"inherit"
 * was what turned parallel container targets into byte-wise interleaved
 * garbage.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, name?: string }} [opts]
 * @returns {Promise<boolean>} success
 */
async function run(cmd, args, opts = {}) {
	return await new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
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
					// tty-redrawn progress (apt/dpkg spinners) arrives as \r-separated
					// frames in one line; only the final frame carries information.
					const keptLine = collapseRedrawFrames(line);
					if (!keptLine) continue; // null (all-\r) or empty: not a record
					logInfo("command output", {
						...(opts.name ? { target: opts.name } : {}),
						cmd,
						stream,
						line: keptLine,
					});
				}
			});
			child[stream].on("end", () => {
				// A stream ending in \n leaves an empty partial — not a line.
				if (!partial) return;
				const keptPartial = collapseRedrawFrames(partial);
				if (!keptPartial) return;
				logInfo("command output", {
					...(opts.name ? { target: opts.name } : {}),
					cmd,
					stream,
					line: keptPartial,
				});
			});
		}
		child.on("close", (code) => resolve(code === 0));
		child.on("error", () => resolve(false));
	});
}

/** @type {{ name: string, fn: () => Promise<boolean> }[]} */
const targets = [];

// --- coding-agent image (container hosts) ------------------------------------
// Tagged :<date> and :latest; the compile is the image build itself (no host
// toolchain involved).
const codingAgentTag =
	process.env.CODING_AGENT_TAG ?? "localhost/empjustine/coding-agent";
if (containerTool) {
	targets.push({
		name: "coding-agent-image",
		fn: async () => {
			const buildDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
			// --progress=plain (podman/buildah; buildx takes the same flag):
			// default "auto" is tty-detected, and an agent harness often IS a
			// pty — which renders buildah's progress as overlapping redraw
			// frames instead of appendable lines.
			const buildArgs =
				containerTool === "podman"
					? ["image", "build", "--progress=plain"]
					: ["buildx", "build", "--progress=plain"];
			return await run(
				containerTool,
				[
					...buildArgs,
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
					`${codingAgentTag}:${buildDate}`,
					"--tag",
					`${codingAgentTag}:latest`,
					"-f",
					join(repoRoot, "coding-agent", "Containerfile"),
					join(repoRoot, "coding-agent"),
				],
				{ name: "coding-agent-image" },
			);
		},
	});

	// --- llama-swap image (container hosts) ----------------------------------
	// The OCI workflow means there is nothing to compile: pre-pull the
	// unified-vulkan image run.sh will use. Cloud/remote peer relaying is
	// served by ../llm-reverse-proxy; this image only ever serves local GGUF
	// inference — no :cpu peers-only variant, no Termux native cross-build.
	const llamaSwapImage =
		process.env.LLAMA_SWAP_IMAGE ??
		"ghcr.io/mostlygeek/llama-swap:unified-vulkan";
	targets.push({
		name: "llama-swap-image",
		fn: async () =>
			await run(containerTool, ["image", "pull", llamaSwapImage], {
				name: "llama-swap-image",
			}),
	});

	// --- llm-reverse-proxy image (container hosts) ---------------------------
	// Multi-stage Containerfile (golang builder → distroless/static runtime,
	// which ships the CA bundle the proxy's upstream TLS verification
	// requires) — the host needs NO go toolchain for this target.
	// Always builds: unchanged inputs are a layer-cache hit; the former
	// inspect-skip keyed on tag PRESENCE and left a stale image after a
	// main.go edit (see the module header).
	const proxyImage =
		process.env.IMAGE_TAG ?? "localhost/llm-reverse-proxy:latest";
	targets.push({
		name: "llm-reverse-proxy-image",
		fn: async () =>
			await run(
				containerTool,
				[
					"build",
					"--progress=plain",
					...(force ? ["--no-cache"] : []),
					"-f",
					join(repoRoot, "llm-reverse-proxy", "Containerfile"),
					"-t",
					proxyImage,
					join(repoRoot, "llm-reverse-proxy"),
				],
				{ name: "llm-reverse-proxy-image" },
			),
	});
}

// --- llm-reverse-proxy native binary (no container backend available) -------
// Termux: android/arm64 via the lib/go-build.mjs preset (GOOS=android — DNS
// resolver; see the module header). Bare host: the host binary, which
// smoke-test.sh and direct runs use. Needs a WORKING go toolchain either way.
const proxyDir = join(repoRoot, "llm-reverse-proxy");
if (!containerTool) {
	const androidBinary = join(proxyDir, "llm-reverse-proxy-android");
	const hostBinary = join(proxyDir, "llm-reverse-proxy");
	const out = termux ? androidBinary : hostBinary;
	targets.push({
		name: "llm-reverse-proxy-native",
		fn: async () => {
			if (!goToolchainReady()) {
				logError(
					termux
						? "no working go toolchain (on Termux: pkg install golang)"
						: "no working go toolchain (it compiles the host binary — the only thing this host can serve; mise hosts: mise use -g go@1.27)",
				);
				return false;
			}
			// Always builds: go's build cache is content-addressed, so an
			// unchanged tree is a near-instant cache hit and a changed main.go
			// is picked up without a flag — the former file-exists skip had the
			// same stale-presence trap as the image skip (module header).
			const flags = [...(force ? ["-a"] : []), ...commonBuildFlags(termux)];
			const env = termux ? androidBuildEnv(termux) : hostBuildEnv();
			return await run("go", ["build", ...flags, "-o", out, "."], {
				cwd: proxyDir,
				env,
				name: "llm-reverse-proxy-native",
			});
		},
	});
}

// --- termux provisioning (serialized FIRST stage on Termux) -----------------
// lib/provision-termux.sh (d041 renamed the former root build.sh unchanged):
// pkg-installs node/jq and source-builds the infisical CLI. It stays shell on
// purpose — every path in it is Termux-only and cannot be regression-tested
// from a container host (docs/d041).
if (termux) {
	targets.unshift({
		name: "termux-provisioning",
		fn: async () =>
			await run("sh", [join(repoRoot, "lib", "provision-termux.sh")], {
				name: "termux-provisioning",
			}),
	});
}

// --- execution ---------------------------------------------------------------
if (targets.length === 0) {
	logError("nothing to build: no container tool and no native target applies");
	process.exit(91);
}
if (!containerTool) {
	logWarn(
		"no container tool — image targets skipped (coding-agent image, llama-swap pull, llm-reverse-proxy image)",
	);
}
logInfo(
	termux
		? "build plan (termux — strictly serialized: ~1 GB devices cannot parallelize go builds)"
		: "build plan (container host — image targets in parallel)",
	{ targets: targets.map((t) => t.name), force, plan },
);
if (plan) {
	process.exit(0);
}

let failed = 0;
if (termux || !containerTool) {
	// Serialized: Termux capacity (go builds), and the single native target on
	// a bare host anyway.
	for (const target of targets) {
		logInfo("building", { target: target.name });
		if (!(await target.fn())) {
			failed += 1;
			logError("build failed", { target: target.name });
		}
	}
} else {
	// Container host: every base image at once.
	const results = await Promise.all(
		targets.map(async (target) => {
			logInfo("building", { target: target.name });
			return { target: target.name, ok: await target.fn() };
		}),
	);
	for (const r of results) {
		if (!r.ok) {
			failed += 1;
			logError("build failed", { target: r.target });
		}
	}
}

if (failed > 0) {
	process.exit(1);
}
logInfo("build complete", { targets: targets.length });
