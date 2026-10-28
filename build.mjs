/**
 * @fileoverview build.mjs — build EVERYTHING for THIS host (docs/d041;
 * d041 also converted the per-folder build.sh shells into this one node
 * builder). Dual mode, detected from the environment — not a flag:
 *
 *   - Container host (podman/docker): the REGISTERED image targets run IN
 *     PARALLEL — coding-agent image build, llama-swap image pull,
 *     llm-reverse-proxy multi-stage image build (the proxy compile happens
 *     INSIDE the image, so no host go toolchain is needed). Registration is
 *     capability-gated (lib/host-capabilities.mjs): the llama-swap pull
 *     needs an inference ENDPOINT — render devices AND the RAM floor
 *     (docs/d087) — the proxy image needs outbound cloud networking; a host
 *     lacking a capability skips that target with a loud log and still
 *     builds the rest. The coding-agent image is deliberately UNGATED:
 *     d083's free-disk floor retires with the node:24-trixie base (d087) —
 *     the multi-GB disk consumer on a build host is the llama-swap pull,
 *     now gated at the source where the waste happens.
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
 * build is near-instant. A REGISTERED target therefore always runs and
 * picks up source changes without a flag; only WHICH targets register
 * varies per host — the capability gates above, keyed on hardware/network
 * facts. The former skip-if-present checks (ported from the old
 * llm-reverse-proxy build.sh) are gone on purpose: they keyed on
 * tag/file PRESENCE, so editing main.go after a build left the stale
 * image/binary in place unless the operator knew FORCE=1 — a silent-
 * staleness trap of exactly the kind the repo's fail-loudly contract
 * forbids. FORCE=1 now means cache-bust: --no-cache for image builds,
 * `-a` (rebuild all packages) for go.
 *
 * argv selects ARTIFACT targets (docs/d083): `./build.sh <target>…` builds
 * just the named ones, no names builds every registered target — and each
 * folder's 3-line `build.sh` shim names its unit's targets, so one unit can
 * be requested on a host (a disk-constrained validation VM) without dragging
 * the rest of the fleet in. An unknown name is a loud exit 94 with the
 * catalog; a requested-but-gated name logs the gate and is left out.
 *
 * Env overrides: FORCE · IMAGE_TAG / LLAMA_SWAP_IMAGE /
 * CODING_AGENT_TAG · GOFLAGS · plus lib/provision-termux.sh's own set.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	androidBuildEnv,
	commonBuildFlags,
	goToolchainReady,
	hostBuildEnv,
} from "./lib/go-build.mjs";
import {
	CLOUD_PROBE_CANARY,
	INFERENCE_MIN_RAM_GIB,
	cloudReachable,
	detectContainerTool,
	detectGpuDevices,
	totalMemGiB,
} from "./lib/host-capabilities.mjs";
import { logError, logInfo, logWarn, setLogTool } from "./lib/log.mjs";

setLogTool("build");

const repoRoot = dirname(fileURLToPath(import.meta.url));
const termux = Boolean(process.env.PREFIX?.includes("com.termux"));
const force = process.env.FORCE === "1";

const containerTool = detectContainerTool();

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

/**
 * Names capability gates kept off THIS host (docs/d083). argv selection
 * unions this with the registered names so `./build.sh <name>` can tell
 * "unknown target" from "does not register here" — fail-loudly, not
 * silent-empty.
 * @type {Set<string>}
 */
const gatedOff = new Set();

/**
 * A gate said no; the name stays knowable so an explicit request gets the
 * gate's reason (the logWarn beside each call) instead of a shrug. Probes
 * themselves stay silent — lib/host-capabilities.mjs's contract.
 * @type {(...names: string[]) => void}
 */
function noteGated(...names) {
	for (const name of names) gatedOff.add(name);
}

// --- coding-agent image (container hosts) ------------------------------------
// Tagged :<date> and :latest; the compile is the image build itself (no host
// toolchain involved).
const codingAgentTag =
	process.env.CODING_AGENT_TAG ?? "localhost/empjustine/coding-agent";
if (containerTool) {
	// Every image build goes through the explicit subcommand (`image build` /
	// `buildx build`) rather than the backend-dependent bare `build` alias,
	// and carries --progress=plain: default progress "auto" is tty-detected,
	// and an agent harness often IS a pty — which renders buildah/buildx
	// progress as overlapping redraw frames instead of appendable lines.
	const imageBuildArgs =
		containerTool === "podman"
			? ["image", "build", "--progress=plain"]
			: ["buildx", "build", "--progress=plain"];

	// Ungated since d087: the node:24-trixie base cut the image's own layer
	// footprint enough that d083's free-disk floor (20 GiB) no longer buys
	// survival — the multi-GB consumer on a build host is the llama-swap
	// pull below, and THAT is now gated on inference-endpoint viability.
	targets.push({
		name: "coding-agent-image",
		fn: async () => {
			const buildDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
			return await run(
				containerTool,
				[
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
	// unified-vulkan image run.sh will use. Cloud/remote relaying is
	// served by ../llm-reverse-proxy; this image only ever serves local GGUF
	// inference — no :cpu peers-only variant, no Termux native cross-build.
	//
	// Gated on being an inference ENDPOINT (docs/d087) — render devices AND
	// the RAM floor — the SAME gate llm-local-inference/generate.mjs puts on
	// its serving layer (shared probes, lib/host-capabilities.mjs): against
	// a non-endpoint host the pull is a wasted multi-GB download of an image
	// that cannot serve (no accelerator to run llama.cpp on, or too little
	// RAM for weights + KV cache), and run.sh would refuse to launch anyway
	// (its config.d layer gate dies first). This pull — not the coding-agent
	// image — is what d083's retired free-disk floor was really protecting.
	const llamaSwapImage =
		process.env.LLAMA_SWAP_IMAGE ??
		"ghcr.io/mostlygeek/llama-swap:unified-vulkan";
	const renderDevices = detectGpuDevices();
	const hostRamGiB = totalMemGiB();
	if (renderDevices.length > 0 && hostRamGiB >= INFERENCE_MIN_RAM_GIB) {
		targets.push({
			name: "llama-swap-image",
			fn: async () =>
				await run(containerTool, ["image", "pull", llamaSwapImage], {
					name: "llama-swap-image",
				}),
		});
	} else {
		noteGated("llama-swap-image");
		logWarn("skipping target — host is not an inference endpoint", {
			target: "llama-swap-image",
			renderDevices: renderDevices.length,
			ramGiB: hostRamGiB,
			minRamGiB: INFERENCE_MIN_RAM_GIB,
		});
	}

	// --- llm-reverse-proxy image (container hosts) ---------------------------
	// Multi-stage Containerfile (golang builder → scratch runtime that
	// ships the CA bundle both TLS legs verify against) — the host needs
	// NO go toolchain for this target. The final stage is scratch on
	// purpose: it pulls from NO registry, so the image builds even where
	// non-docker.io registries are blocked (the gcr.io distroless base
	// could not); only golang:1.27 on docker.io is fetched.
	// Registered only while outbound cloud networking answers the naive probe
	// (lib/host-capabilities.mjs): the proxy exists to relay to cloud
	// upstreams, and against a closed network its base-image --pull would
	// fail anyway — the gate turns that hard failure into a logged skip.
	// Once registered it always builds: unchanged inputs are a layer-cache
	// hit, and the retired inspect-skip (tag PRESENCE, stale after a main.go
	// edit — see the module header) stays retired.
	// --pull is load-bearing, not hygiene: the omitted-flag default is the
	// "missing" policy, so a locally-cached golang:1.27 tag is reused even
	// after upstream republishes it — the moving tag the build resolves
	// FROM must be refreshed explicitly (bare --pull = always).
	const proxyImage =
		process.env.IMAGE_TAG ?? "localhost/llm-reverse-proxy:latest";
	if (await cloudReachable()) {
		targets.push({
			name: "llm-reverse-proxy-image",
			fn: async () =>
				await run(
					containerTool,
					[
						...imageBuildArgs,
						"--pull",
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
	} else {
		noteGated("llm-reverse-proxy-image");
		logWarn(
			"skipping target — outbound cloud networking unreachable (naive probe)",
			{ target: "llm-reverse-proxy-image", canary: CLOUD_PROBE_CANARY },
		);
	}
} else {
	noteGated("coding-agent-image", "llama-swap-image", "llm-reverse-proxy-image");
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
} else {
	noteGated("llm-reverse-proxy-native");
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
} else {
	noteGated("termux-provisioning");
}

// --- execution ---------------------------------------------------------------
// argv selects ARTIFACT targets (docs/d083): no names runs every registered
// one, names run just those. termux-provisioning is NOT selectable — it is
// environment provisioning (d041), not an artifact, and every Termux go
// build needs what it installs, so it runs first regardless of selection.
const requested = process.argv.slice(2);
const knownNames = new Set([...gatedOff, ...targets.map((t) => t.name)]);
const unknown = requested.filter((name) => !knownNames.has(name));
if (unknown.length > 0) {
	logError("unknown build target", { unknown, known: [...knownNames] });
	process.exit(94);
}
const selected = [
	...targets.filter((t) => t.name === "termux-provisioning"),
	...(requested.length > 0
		? targets.filter(
				(t) =>
					t.name !== "termux-provisioning" && requested.includes(t.name),
			)
		: targets.filter((t) => t.name !== "termux-provisioning")),
];
const unregistered = requested.filter(
	(name) => !selected.some((t) => t.name === name),
);
if (unregistered.length > 0) {
	logWarn("requested target did not register on this host (gates above)", {
		targets: unregistered,
	});
}
if (selected.length === 0) {
	logError(
		"nothing to build: no registered target (host gates and selection above)",
	);
	process.exit(91);
}
if (!containerTool) {
	logWarn(
		"no container tool — image targets skipped (coding-agent image, llama-swap pull, llm-reverse-proxy image)",
	);
}
logInfo(
	termux
		? "build targets (termux — strictly serialized: ~1 GB devices cannot parallelize go builds)"
		: containerTool
			? "build targets (container host — image targets in parallel)"
			: "build targets (bare host — serialized)",
	{ targets: selected.map((t) => t.name), force },
);

let failed = 0;
if (termux || !containerTool) {
	// Serialized: Termux capacity (go builds), and the single native target on
	// a bare host anyway.
	for (const target of selected) {
		logInfo("building", { target: target.name });
		if (!(await target.fn())) {
			failed += 1;
			logError("build failed", { target: target.name });
		}
	}
} else {
	// Container host: every base image at once.
	const results = await Promise.all(
		selected.map(async (target) => {
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
logInfo("build complete", { targets: selected.length });
