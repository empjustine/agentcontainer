/**
 * @fileoverview build.mjs — build estige for THIS host (docs/d041; d083 made
 * the build entry per-unit, docs/d113 folded the root builder away).
 *
 * Three targets, and which one registers is a host fact, not a flag:
 *
 *   - Container host (podman/docker): `estige-image` — the multi-stage
 *     Containerfile (golang builder → scratch runtime that ships the CA
 *     bundle both TLS legs verify against), so the host needs NO go
 *     toolchain. The final stage is scratch on purpose: it pulls from NO
 *     registry, so the image builds even where non-docker.io registries are
 *     blocked (the gcr.io distroless base could not); only golang:1.27 on
 *     docker.io is fetched. Registered only while outbound cloud networking
 *     answers the naive probe (lib/host-capabilities.mjs): the proxy exists to
 *     relay to cloud upstreams, and against a closed network its base-image
 *     --pull would fail anyway — the gate turns that hard failure into a
 *     logged skip.
 *   - No container backend: `estige-native` — the host binary direct runs
 *     use; on Termux the android/arm64 binary through lib/go-build.mjs's
 *     preset (GOOS=android — DNS resolver; see that module's header). Needs a
 *     WORKING go toolchain.
 *   - Every host with a working go toolchain: `estige-packages` — the pure-Go
 *     Termux .deb and Oracle Linux .rpm into packaging/out/. It cross-compiles
 *     the two payload binaries (android/arm64 and linux/amd64), so it does not
 *     depend on this host's OS; no packaging tool is invoked.
 *
 * --pull is load-bearing, not hygiene: the omitted-flag default is the
 * "missing" policy, so a locally-cached golang:1.27 tag is reused even after
 * upstream republishes it — the moving tag the build resolves FROM must be
 * refreshed explicitly (bare --pull = always).
 *
 * Idempotence comes from the CACHES, not from skip checks (docs/d041): a
 * container build on unchanged inputs is a layer-cache hit — seconds, not
 * work — and go's build cache is content-addressed, so an unchanged binary
 * build is near-instant. A registered target therefore always runs and picks
 * up source changes without a flag; only WHICH targets register varies per
 * host. The former skip-if-present checks are gone on purpose: they keyed on
 * tag/file PRESENCE, so editing main.go after a build left the stale
 * image/binary in place unless the operator knew FORCE=1 — a silent-staleness
 * trap of exactly the kind the repo's fail-loudly contract forbids. FORCE=1
 * now means cache-bust: --no-cache for the image build, `-a` for go.
 *
 * argv selects target names (`./build.sh image`); no names builds every
 * registered target. An unknown name is a loud exit 94 with the catalog; a
 * requested-but-gated name logs the gate and is left out.
 *
 * Env overrides: FORCE · IMAGE_TAG · GOFLAGS.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	androidBuildEnv,
	commonBuildFlags,
	estigeVersion,
	goToolchainReady,
	hostBuildEnv,
	isTermux,
} from "./lib/go-build.mjs";
import {
	CLOUD_PROBE_CANARY,
	cloudReachable,
	detectContainerTool,
} from "./lib/host-capabilities.mjs";

// ---------------------------------------------------------------------------
// Structured logging (docs/d045)
// ---------------------------------------------------------------------------
//
// Inlined from the repo's log kernel rather than imported (docs/d113 as
// amended): a copy unit owns what it uses, and this build has exactly one
// consumer shape — four level functions, no stream switching, no debug level.
// The full kernel lives in each unit that needs more of it; when a second
// consumer here wants setLogStream or logDebug, the right move is to extract a
// real library again, not to re-grow a vendored copy.
//
// One JSON object per line on stdout (LOG_FORMAT=logfmt for logfmt), `msg`
// first and this kernel's three fields last: the event is what a truncated
// view keeps. `ts` is Unix epoch MILLISECONDS as a number and
// `severityNumber` is OpenTelemetry's SeverityNumber, so a reader compares
// numbers where it used to match level words (docs/d151 owns the record shape,
// its field order and the canonical ranges; the bands are TRACE 1-4, DEBUG
// 5-8, INFO 9-12, WARN 13-16, ERROR 17-20, FATAL 21-24). Level filtering is
// the consumer's job (docs/d045): no line is ever dropped here. Messages are
// stable labels; fields carry the metadata.

let tool = process.env.LOG_TOOL ?? "node";
/**
 * @param {string} name
 * @returns {void}
 */
function setLogTool(name) {
	tool = name;
}

/**
 * Each level's wire value, as an index into OpenTelemetry's severity bands
 * (docs/d151): the three levels this inline copy emits sit on their band's
 * floor, and the rest are the anchors so a new helper inherits the scale.
 * @type {Record<string, number>}
 */
const SEVERITY_NUMBER = {
	trace: 1,
	debug: 5,
	info: 9,
	warn: 13,
	error: 17,
	fatal: 21,
};

/**
 * A level name as its SeverityNumber. An unknown level fails here rather than
 * serializing to `undefined`: a record with no severity is a record nobody can
 * sort, so the call site that spelled the level wrong is what has to change.
 * @param {string} level
 * @returns {number}
 */
function severityNumber(level) {
	const number = SEVERITY_NUMBER[level];
	if (number === undefined) {
		throw Object.assign(new Error("unknown log level"), { level });
	}
	return number;
}

/**
 * Cause/suppressed chains are user data; a cyclic one must not hang the emit.
 * No real chain here is deeper than a wrapped fetch → wrapped parse → cause.
 * @type {number}
 */
const MAX_SERIALIZATION_DEPTH = 8;

/**
 * Serialize a log field value. Errors become structured objects (name,
 * message, stack, own enumerable properties, plus the explicitly walked
 * non-enumerable `cause`/`errors`/`error`/`suppressed`); plain objects and
 * arrays recurse; primitives pass through.
 * @param {unknown} v
 * @param {number} depth
 * @returns {unknown}
 */
function serialize(v, depth) {
	if (depth >= MAX_SERIALIZATION_DEPTH) {
		return v instanceof Error
			? { name: v.name, message: v.message }
			: Array.isArray(v)
				? "[max depth]"
				: { "[max depth]": true };
	}
	if (v instanceof Error) {
		return serializeError(v, depth);
	}
	if (Array.isArray(v)) {
		return v.map((item) => serialize(item, depth + 1));
	}
	if (v !== null && typeof v === "object") {
		return Object.fromEntries(
			Object.entries(v).map(([k, item]) => [k, serialize(item, depth + 1)]),
		);
	}
	return v;
}

/**
 * `cause`, AggregateError's `errors`, and SuppressedError's `error`/`suppressed`
 * are all NON-enumerable own properties (verified on node 24) — Object.entries
 * misses them, so they are walked explicitly. Attached properties from
 * `Object.assign(err, {...})` ARE enumerable and flow through the general pass.
 * @param {Error} err
 * @param {number} depth
 * @returns {unknown}
 */
function serializeError(err, depth) {
	/** @type {Record<string, unknown>} */
	const out = { name: err.name, message: err.message };
	if (typeof err.stack === "string") {
		out.stack = err.stack;
	}
	for (const [k, v] of Object.entries(err)) {
		out[k] = serialize(v, depth + 1);
	}
	for (const k of ["cause", "errors", "error", "suppressed"]) {
		if (k in out || !(k in err)) {
			continue;
		}
		const v = /** @type {Record<string, unknown>} */ (
			/** @type {unknown} */ (err)
		)[k];
		out[k] = serialize(v, depth + 1);
	}
	return out;
}

/**
 * Logfmt escaping for a field value: objects/arrays (post-serialization) are
 * JSON-encoded inline; scalars are quoted only when whitespace/quotes/`=`/
 * backslashes or empty would otherwise corrupt the line format.
 * @param {unknown} v
 * @returns {string}
 */
function fmtLogfmtValue(v) {
	// Structured fields may be objects/arrays/errors after serialization —
	// JSON-encode those instead of leaking "[object Object]".
	if (v !== null && typeof v === "object") {
		return JSON.stringify(v);
	}
	const s = String(v);
	return /[\s"=\\]/.test(s) || s === "" ? JSON.stringify(s) : s;
}

/**
 * @param {string} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, msg, fields = {}) {
	// The event leads; the three fields this kernel fills in trail it, so a
	// reader skimming raw lines, or a terminal that truncates them, meets what
	// happened before the bookkeeping (docs/d151).
	const trailer = {
		ts: Date.now(),
		severityNumber: severityNumber(level),
		tool,
	};
	if (process.env.LOG_FORMAT === "logfmt") {
		const rest = Object.entries(
			/** @type {Record<string, unknown>} */ (serialize(fields, 0)),
		)
			.map(([k, v]) => `${k}=${fmtLogfmtValue(v)}`)
			.join(" ");
		const msgv = /[\s"=\\]/.test(msg) ? JSON.stringify(msg) : msg;
		process.stdout.write(
			`msg=${msgv}${rest ? ` ${rest}` : ""} ts=${trailer.ts} severityNumber=${trailer.severityNumber} tool=${tool}\n`,
		);
		return;
	}
	process.stdout.write(
		`${JSON.stringify({
			msg,
			.../** @type {Record<string, unknown>} */ (serialize(fields, 0)),
			...trailer,
		})}\n`,
	);
}

/**
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
const logInfo = (msg, fields) => emit("info", msg, fields);
/**
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
const logWarn = (msg, fields) => emit("warn", msg, fields);
/**
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
const logError = (msg, fields) => emit("error", msg, fields);

setLogTool("estige/build");

const estigeRoot = dirname(fileURLToPath(import.meta.url));
const termux = isTermux();
const force = process.env.FORCE === "1";

const containerTool = detectContainerTool();

/**
 * Defense-in-depth line sanitizer (docs/d045). The ROOT cause of tty progress
 * leak is fixed per-tool at the source, only for tools this repo controls: the
 * container builders are upstream, so a redraw chain that survives to this
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
 * @param {string} cmd command label ("go build")
 * @param {number} stream file descriptor the line arrived on
 * @param {string|null} target
 * @param {string} line
 * @returns {void}
 */
function logCommandLine(cmd, stream, target, line) {
	logInfo(line, { ...(target ? { target } : {}), cmd, stream });
}

/**
 * Run one command to completion, capturing stdout+stderr LINE BY LINE and
 * re-emitting each as a structured log record (docs/d045): child processes
 * are upstreams (buildah, go) that cannot be made to honor d045 themselves,
 * so the wrapping layer owns the line-boundary. stdio:"inherit" would turn
 * the parallel coding-agent/estige image builds into byte-wise interleaved
 * garbage when several units build at once.
 * @param {string} executable
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, name?: string, cmd: string }} opts
 * `cmd` is required: the command as a reader names it — executable AND
 * subcommand — because a bare `go` or `podman` label makes every line in a
 * merged stream look alike (docs/d151)
 * @returns {Promise<boolean>} success
 */
async function run(executable, args, opts) {
	return await new Promise((resolve) => {
		const child = spawn(executable, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
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
					logCommandLine(opts.cmd, stream, opts.name ?? null, keptLine);
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
				logCommandLine(opts.cmd, stream, opts.name ?? null, keptPartial);
			});
		}
		child.on("close", (code) => resolve(code === 0));
		child.on("error", () => resolve(false));
	});
}

/** @type {{ name: string, fn: () => Promise<boolean> }[]} */
const targets = [];

/**
 * Names capability gates kept off THIS host. argv selection unions this with
 * the registered names so `./build.sh <name>` can tell "unknown target" from
 * "does not register here" — fail-loudly, not silent-empty.
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
	for (const name of names) {
		gatedOff.add(name);
	}
}

// --- the image (container hosts) ---------------------------------------------
if (containerTool) {
	// Every image build goes through the explicit subcommand (`image build` /
	// `buildx build`) rather than the backend-dependent bare `build` alias, and
	// carries --progress=plain: default progress "auto" is tty-detected, and an
	// agent harness often IS a pty — which renders buildah/buildx progress as
	// overlapping redraw frames instead of appendable lines.
	const imageBuildSubcommand =
		containerTool === "podman" ? ["image", "build"] : ["buildx", "build"];
	const imageBuildArgs = [...imageBuildSubcommand, "--progress=plain"];
	// Derived from the SAME array the build runs, so the `cmd` a line is
	// filed under cannot drift from the command that produced it.
	const imageBuildCmd = [containerTool, ...imageBuildSubcommand].join(" ");
	const imageTag = process.env.IMAGE_TAG ?? "localhost/estige:latest";

	if (await cloudReachable()) {
		targets.push({
			name: "estige-image",
			fn: async () =>
				await run(
					containerTool,
					[
						...imageBuildArgs,
						"--pull",
						...(force ? ["--no-cache"] : []),
						"-f",
						join(estigeRoot, "Containerfile"),
						"-t",
						imageTag,
						estigeRoot,
					],
					{ name: "estige-image", cmd: imageBuildCmd },
				),
		});
	} else {
		noteGated("estige-image");
		logWarn(
			"skipping target — outbound cloud networking unreachable (naive probe)",
			{ target: "estige-image", canary: CLOUD_PROBE_CANARY },
		);
	}
} else {
	noteGated("estige-image");
}

// --- the native binary (no container backend) --------------------------------
if (containerTool) {
	noteGated("estige-native");
} else {
	const out = join(estigeRoot, termux ? "estige-android" : "estige");
	targets.push({
		name: "estige-native",
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
			// unchanged tree is a near-instant cache hit and a changed main.go is
			// picked up without a flag — the former file-exists skip had the same
			// stale-presence trap as the image skip (module header).
			const flags = [...(force ? ["-a"] : []), ...commonBuildFlags(termux)];
			const env = termux ? androidBuildEnv(termux) : hostBuildEnv();
			return await run("go", ["build", ...flags, "-o", out, "."], {
				cwd: estigeRoot,
				env,
				name: "estige-native",
				cmd: "go build",
			});
		},
	});
}

// --- packages (any host with a working go toolchain) ------------------------
if (goToolchainReady()) {
	const outDir = join(estigeRoot, "packaging", "out");
	const staging = join(outDir, ".build");
	targets.push({
		name: "estige-packages",
		fn: async () => {
			// The payload binaries are throwaway build inputs; the artifacts are
			// the target's only output. Clear stale staging so a failed run cannot
			// package yesterday's binary.
			rmSync(staging, { recursive: true, force: true });
			mkdirSync(staging, { recursive: true });
			const flags = [...(force ? ["-a"] : []), ...commonBuildFlags(termux)];
			const base = termux ? androidBuildEnv(termux) : hostBuildEnv();
			const debBinary = join(staging, "estige-android-arm64");
			const rpmBinary = join(staging, "estige-linux-amd64");
			const debEnv = {
				...base,
				CGO_ENABLED: "0",
				GOOS: "android",
				GOARCH: "arm64",
			};
			const rpmEnv = {
				...base,
				CGO_ENABLED: "0",
				GOOS: "linux",
				GOARCH: "amd64",
			};

			const debBuilt = await run(
				"go",
				["build", ...flags, "-o", debBinary, "."],
				{
					cwd: estigeRoot,
					env: debEnv,
					name: "estige-packages",
					cmd: "go build",
				},
			);
			if (!debBuilt) {
				return false;
			}
			const rpmBuilt = await run(
				"go",
				["build", ...flags, "-o", rpmBinary, "."],
				{
					cwd: estigeRoot,
					env: rpmEnv,
					name: "estige-packages",
					cmd: "go build",
				},
			);
			if (!rpmBuilt) {
				return false;
			}

			const packaged = await run(
				"go",
				[
					"run",
					...(force ? ["-a"] : []),
					"./packaging",
					"-version",
					estigeVersion(),
					"-deb-binary",
					debBinary,
					"-rpm-binary",
					rpmBinary,
					"-out",
					outDir,
				],
				{
					cwd: estigeRoot,
					env: hostBuildEnv(),
					name: "estige-packages",
					cmd: "go run ./packaging",
				},
			);
			if (packaged) {
				rmSync(staging, { recursive: true, force: true });
			}
			return packaged;
		},
	});
} else {
	noteGated("estige-packages");
}

// --- termux provisioning (serialized FIRST stage on Termux) ------------------
// Provisions the DEVICE: the infisical CLI (the operator-run env chain), and
// nothing estige itself needs — the binary is self-contained Go and the
// packages carry no node/jq dependency (this change). It stays shell on
// purpose — every path in it is Termux-only and cannot be regression-tested
// from a container host (docs/d041) — and it stays at the REPO root because it
// provisions the device, not this unit (d113): a standalone estige checkout on
// Termux must bring that script along, so a missing one is a loud error rather
// than a silently unprovisioned build.
if (termux) {
	const provisioning = join(estigeRoot, "..", "provision-termux.sh");
	targets.unshift({
		name: "termux-provisioning",
		fn: async () =>
			await run("sh", [provisioning], {
				name: "termux-provisioning",
				cmd: `sh ${basename(provisioning)}`,
			}),
	});
} else {
	noteGated("termux-provisioning");
}

// --- execution ---------------------------------------------------------------
// target selection (docs/d083): no names runs every registered one, names run
// just those. termux-provisioning is NOT selectable — it is environment
// provisioning (d041), not an artifact, and it is the shared Termux
// environment the on-device build runs under, so it runs first regardless of
// selection; packaged artifacts themselves need neither node nor jq.
// Serialized throughout:
// Termux cannot parallelize ~1 GB go builds, and on a container host the image
// is the only registered target anyway.
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
				(t) => t.name !== "termux-provisioning" && requested.includes(t.name),
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
logInfo(
	containerTool
		? "build targets (container host)"
		: "build targets (bare host — serialized)",
	{ targets: selected.map((t) => t.name), force },
);

let failed = 0;
for (const target of selected) {
	logInfo("building", { target: target.name });
	if (!(await target.fn())) {
		failed += 1;
		logError("build failed", { target: target.name });
	}
}

if (failed > 0) {
	process.exit(1);
}
logInfo("build complete", { targets: selected.length });
