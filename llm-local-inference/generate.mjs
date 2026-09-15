/**
 * @fileoverview generate.mjs — the llm-local-inference generator (d041 folded
 * the former generate.sh, gen-lib.mjs, generate-general.yaml.mjs and
 * generate-local-llm-models.yaml.mjs in): (re)generate the llama-swap config
 * in config.d/ for LOCAL GGUF inference. RUN THIS after a models/args change
 * (active-b.json, ../lib/llamacpp-model-data.json, llama-swap-core.json
 * macros) or when a host's capabilities changed (GPU added/removed, container
 * backend installed).
 *
 * Cloud/remote peer relaying is NOT generated here (nor anywhere): it is
 * served by ../llm-reverse-proxy, the raw passthrough proxy. This module
 * emits only what serves local llama.cpp GGUFs.
 *
 * Layers emitted:
 *   00-general.yaml              always  (globals + macros)
 *   10-local-llm-inference.yaml  only when local inference is viable (container
 *                                backend AND GPU devices), or LOCAL_INFERENCE=1
 *                                to force (debug only; the host HF cache must
 *                                carry every configured GGUF)
 *   10-local-llm-inference.paths sibling manifest of the baked host-side model
 *                                paths — run.sh's staleness preflight input
 *
 * There is NO launch-gguf.sh: snapshot paths are resolved HERE
 * (generation-time baking, docs/d029 option B) and emitted as plain args in
 * each model's cmd; a cache miss is a generation error pointing at
 * ../local-llm/download_models.py. Stale launch-gguf.sh copies from older
 * generate.sh versions are removed below.
 *
 * Merge contract for the fragments (llama-swap's -config-dir loader;
 * docs/d018): identity-keyed maps merge additively and a duplicate key across
 * files is a hard error, while `apiKeys` concatenates and macros/scalars must
 * be single-defined — hence each layer owns a disjoint key set and
 * 00-general.yaml is the only home of the globals.
 *
 * Secrets: none at generation time. This module's generation is fully offline
 * (vendored tables only) and embeds NO keys — the single ${env.*} reference in
 * the generated config (PEER_API_KEY, 00-general.yaml apiKeys) is resolved by
 * llama-swap from ITS OWN environment at load time, which run.sh receives from
 * the explicit chain (./lib/environment.sh ./run.sh). So generation needs no
 * vault round-trip at all.
 *
 * Env overrides:
 *   DRY_RUN           1 = generators do NOT replace the config.d layers —
 *                       each write lands in a sibling <name>.dry-run preview
 *                       for inspection (repo-wide generator standard,
 *                       lib/artifact.mjs)
 *   LOCAL_INFERENCE   1 = force the local-inference layer regardless of the
 *                       capability gate (emits container-side paths; debug)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Structured logger + artifact writer from ../lib (docs/d023), resolved
// through the LIB_DIR convention (default: this folder's sibling lib/).
const LIB_DIR =
	process.env.LIB_DIR ?? fileURLToPath(new URL("../lib", import.meta.url));
const { logError, logInfo, logWarn } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const configD = join(scriptDir, "config.d");

// --- config.d layer writers (folded gen-lib.mjs) ---------------------------

/**
 * Read the general-purpose llama-swap config source.
 * @param {string} [path] defaults to llama-swap-core.json next to this file
 * @returns {Record<string, unknown>}
 */
function loadCore(path = join(scriptDir, "llama-swap-core.json")) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Write an object as pretty JSON into config.d/ (the YAML loader accepts JSON
 * content, and JSON-in-.yaml matches the repo's existing config style). Write
 * contract: lib/artifact.mjs (atomic tmp+rename, replace by default, DRY_RUN=1
 * preview).
 * @param {string} name layer filename (e.g. "10-local-llm-inference.yaml")
 * @param {unknown} obj config object to serialize
 * @returns {void}
 */
function writeConfigD(name, obj) {
	mkdirSync(configD, { recursive: true });
	const path = writeArtifact(
		join(configD, name),
		`${JSON.stringify(obj, null, 2)}\n`,
	);
	logInfo("wrote config.d layer", { path });
}

// --- 00-general.yaml (folded generate-general.yaml.mjs) --------------------
// Per the merge contract (docs/d018) this layer is the ONLY home of scalars /
// macros / ctxWindows / apiKeys; the model layer must not redefine any.
function generateGeneral() {
	const core = loadCore();
	// models/peers belong to the local-inference layer below.
	delete core.models;
	delete core.peers;
	writeConfigD("00-general.yaml", core);
}

// --- 10-local-llm-inference.yaml (folded generate-local-llm-models.yaml.mjs)
// The local llama.cpp GGUF `models` map, plus the sibling .paths manifest
// (host-side paths the run.sh staleness preflight re-checks). Built from
// ../lib/llamacpp-model-data.json (the shared model-data table, docs/d025);
// no network access. The `cmd` strings reference macros defined in
// 00-general.yaml (${LLAMA_SERVER}, ${qwen36}, …) which llama-swap resolves
// after merging config.d/.

// The activeB table (model-name slice -> "b" slug) is split out of the
// generator into its own mini-manifest (active-b.json).
const activeB = JSON.parse(
	readFileSync(join(scriptDir, "active-b.json"), "utf-8"),
);

// llama-swap macro text, kept verbatim so the JS generator never tries to
// interpolate it as a JS variable.  llama-swap expands ${LLAMA_SERVER} (and the
// ${qwen36} family) itself before launching the model.
// biome-ignore lint/suspicious/noTemplateCurlyInString: llama-swap expands ${LLAMA_SERVER} (and the ${qwen36} family) itself before launching; must stay verbatim text.
const LLAMA_SERVER_MACRO = "${LLAMA_SERVER}";

/**
 * Implicit manifest defaults: entries in llamacpp-model-data.json may omit
 * these keys and the generator fills them in. Only deviations (e.g. a
 * --parallel 2 model or a non-65536 context) need to be written out.
 * @type {Record<string, number|string>}
 */
const DEFAULTS = {
	"cache-type-k": "f16",
	"cache-type-v": "f16",
	"ctx-size": 65536,
	parallel: 1,
};

/**
 * Speculative decoding strategy used when an entry carries a "model-draft"
 * drafter GGUF (unsloth ships MTP sidecars under the repo's MTP/ subdir).
 * --model-draft ALONE is a no-op for speculation when the target model is a
 * local path: the server only auto-infers the spec type on the --hf-repo
 * download path, so --spec-type must be emitted explicitly (and a bare
 * --model-draft would still load the drafter into VRAM, wasted).
 * @type {string}
 */
const DEFAULT_SPEC_TYPE = "draft-mtp";

// The ONE home of the container-side hub path (docs/d029 F4): run.sh binds the
// host HF cache here, and the baked cmd paths are written against it. Changing
// this constant means changing run.sh's bind in the same edit.
const HUB_GUEST = "/home/ubuntu/.cache/huggingface/hub";

// Host-side mirror of run.sh's HF_HUB_CACHE default (the same env-override
// chain: HF_HUB_CACHE, else XDG_CACHE_HOME, else ~/.cache). Generation reads
// the cache the serving container later binds, so both sides must compute the
// same directory.
const HUB_HOST =
	process.env.HF_HUB_CACHE ??
	join(
		process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
		"huggingface",
		"hub",
	);

// Sharded GGUF naming, kept in sync with local-llm/download_models.py's
// SPLIT_RE (that script downloads every shard; the generator verifies it did).
const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/;

/**
 * Normalize a (possibly sharded) GGUF filename to its 00001 shard — llama.cpp
 * auto-loads sibling shards when pointed at the first one. Tolerates a
 * non-first shard in the manifest the same way the retired launch-gguf.sh did.
 * @param {string} filename
 * @returns {string} the 00001-shard filename
 */
function shardOne(filename) {
	const m = SPLIT_RE.exec(filename);
	if (!m) return filename;
	return `${filename.slice(0, m.index)}-00001-of-${m[2]}.gguf`;
}

/**
 * Expand a sharded GGUF filename to ALL of its shards (llama-server needs the
 * complete set present, not just shard 1 — download_models.py enforces this at
 * download time, and the generator re-verifies it against the cache).
 * @param {string} filename
 * @returns {string[]} every shard filename
 */
function allShards(filename) {
	const first = shardOne(filename);
	const m = SPLIT_RE.exec(first);
	if (!m) return [first];
	const base = first.slice(0, first.length - m[0].length);
	const width = m[1].length;
	return Array.from(
		{ length: Number(m[2]) },
		(_, i) => `${base}-${String(i + 1).padStart(width, "0")}-of-${m[2]}.gguf`,
	);
}

/**
 * Resolve one manifest entry to ONE HF snapshot dir and bake the final
 * container-side paths. Candidate snapshots: the refs/main revision first —
 * the revision download_models.py pins, so a healthy cache always resolves
 * there — then every snapshot dir (sorted), mirroring the glob order the
 * retired launch-gguf.sh used. The chosen snapshot must carry ALL required
 * files (every model shard, plus the projector/drafter when declared) so
 * --model/--mmproj/--model-draft stay backed by the exact same commit.
 *
 * No candidate qualifies ⇒ generation FAILS (exit 1): provisioning is
 * ../local-llm/download_models.py's job and is not duplicated as a
 * launch-time download fallback.
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @returns {{ modelPath: string, mmprojPath: string|null, draftPath: string|null, hostPaths: string[] }}
 *   container-side paths for the emitted cmd (mmproj/draft null when the entry
 *   omits them) plus the host-side file list for the .paths staleness manifest
 */
function bakeSnapshotPaths(m) {
	const repo = m["hf-repo"].split(":")[0]; // drop :revision; the GGUF filename already pins the quant
	const repoDir = `models--${repo.split("/").join("--")}`;
	const snapshotsDir = join(HUB_HOST, repoDir, "snapshots");

	const candidates = [];
	const refPath = join(HUB_HOST, repoDir, "refs", "main");
	if (existsSync(refPath)) {
		const sha = readFileSync(refPath, "utf-8").trim();
		if (sha) candidates.push(sha);
	}
	if (existsSync(snapshotsDir)) {
		candidates.push(...readdirSync(snapshotsDir).sort());
	}

	const required = allShards(m.model);
	if (m.mmproj) required.push(m.mmproj);
	if (m["model-draft"]) required.push(m["model-draft"]);

	for (const sha of candidates) {
		const snapshot = join(snapshotsDir, sha);
		const missing = required.filter(
			(f) => !existsSync(join(snapshot, f)), // follows the blob symlinks
		);
		if (missing.length > 0) continue;

		const snapGuest = `${HUB_GUEST}/${repoDir}/snapshots/${sha}`;
		const snapHost = `${HUB_HOST}/${repoDir}/snapshots/${sha}`;
		return {
			modelPath: `${snapGuest}/${shardOne(m.model)}`,
			mmprojPath: m.mmproj ? `${snapGuest}/${m.mmproj}` : null,
			draftPath: m["model-draft"] ? `${snapGuest}/${m["model-draft"]}` : null,
			hostPaths: required.map((f) => `${snapHost}/${f}`),
		};
	}

	logError(
		"no HF snapshot carries this entry — run local-llm/download_models.py, then re-run ./generate.sh",
		{
			repo,
			hub: snapshotsDir,
			snapshotsChecked: candidates.length,
			required,
		},
	);
	process.exit(1);
}

/**
 * mmproj models are tripled: one llama-swap model per level of commitment to
 * GPU-offloading the vision projector. The middle slug segment doubles as a
 * llama-swap macro name (llama-swap-core.json):
 *   0text    -> --no-mmproj --ubatch-size 256   (projector never loaded; also
 *              emitted without --mmproj so the projector is never required)
 *   1vision  -> --no-mmproj-offload --ubatch-size 2048  (projector loaded, stays on CPU)
 *   2mmproj  -> --ubatch-size 2048                      (projector offloaded to GPU)
 * The 1vision/2mmproj variants additionally pass --image-min-tokens/
 * --image-max-tokens from the manifest, and advertise the "image" input
 * modality; 0text and non-mmproj models stay text-only.
 * @type {readonly { seg: string|null, vision: boolean }[]}
 */
const MMPROJ_MODES = [
	{ seg: "0text", vision: false },
	{ seg: "1vision", vision: true },
	{ seg: "2mmproj", vision: true },
];

/**
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @returns {string} the active-B slug ("99b" when no slice matches)
 */
function activeSlug(m) {
	for (const slice in activeB) {
		if (m["hf-repo"].indexOf(slice) !== -1) return activeB[slice];
	}
	return "99b";
}

/**
 * @param {number} contextWindow
 * @returns {string} zero-padded context slug for the model id
 */
function ctxSlug(contextWindow) {
	if (contextWindow % 1024 === 0) {
		return String(contextWindow / 1024).padStart(3, "0");
	}
	return String(Math.round(contextWindow / 1000)).padStart(3, "0");
}

// The quant now lives in `hf-repo` as `repo:revision`, and the kv-cache type is
// emitted inline (--cache-type-k/-v), so neither the quant slug nor the
// kv-quant segment appears in the id anymore — just the active slug, the
// context window, the mmproj mode segment ("" for non-mmproj models), and the
// (unique) hf-repo.
/**
 * @param {Record<string, any>} m
 * @param {string|null} modeSeg
 * @returns {string} the derived llama-swap model id
 */
function deriveModelId(m, modeSeg) {
	return `${activeSlug(m)}-ctx${ctxSlug(m["ctx-size"])}-${modeSeg ? `${modeSeg}-` : ""}${m["hf-repo"]}`;
}

function generateLocalInference() {
	// The shared model-data table lives in lib/ (moved there to mark it as
	// explicitly shared with local-llm/ tooling — docs/d025). Same LIB_DIR
	// convention as the log import above.
	const modelData = JSON.parse(
		readFileSync(join(LIB_DIR, "llamacpp-model-data.json"), "utf-8"),
	);

	/** @type {Set<string>} host-side files to re-verify in run.sh's preflight */
	const bakedHostPaths = new Set();
	/** @type {Record<string, unknown>} */
	const models = {};
	for (const raw of modelData.models) {
		const m = { ...DEFAULTS, ...raw };
		const ctxSize = m["ctx-size"]; // AUTHORITATIVE --ctx-size (not --fit-ctx)
		const nPredict = ctxSize;
		// One snapshot resolution per ENTRY (all three mmproj modes share it):
		// refs/main carries the model, its every shard, and the mmproj/drafter
		// at the same commit, or generation fails.
		const baked = bakeSnapshotPaths(m);
		for (const p of baked.hostPaths) bakedHostPaths.add(p);
		const modes = m.mmproj ? MMPROJ_MODES : [{ seg: null, vision: false }];
		for (const mode of modes) {
			const modalities = mode.vision ? ["text", "image"] : ["text"];
			// The family macro reference (${qwen38} etc.) and any literal extra flags
			// live in __argv verbatim; llama-swap expands ${...} at load.  Empty __argv
			// expands to nothing; shlex collapses the gap.  The expanded
			// ${LLAMA_SERVER} must be the FIRST cmd token: shlex argv[0] is the
			// server binary llama-swap resolves on PATH and execs directly.
			let cmd = LLAMA_SERVER_MACRO;
			// The mode slug is verbatim llama-swap macro text (\${0text} etc.),
			// NOT JS interpolation — it expands to the projector-offload flags.
			if (mode.seg) cmd += ` \${${mode.seg}}`;
			if (mode.vision && m["image-min-tokens"] !== undefined) {
				cmd += ` --image-min-tokens ${m["image-min-tokens"]} --image-max-tokens ${m["image-max-tokens"]}`;
			}
			if (m.__argv) cmd += ` ${m.__argv}`;
			cmd += ` --cache-type-k ${m["cache-type-k"]} --cache-type-v ${m["cache-type-v"]}`;
			cmd += ` --ctx-size ${ctxSize} --n-predict ${nPredict}`;
			if (baked.draftPath) {
				// explicit: auto-inference only happened on the retired --hf-repo
				// download path, never for local snapshot paths (see DEFAULT_SPEC_TYPE)
				cmd += ` --spec-type ${m["spec-type"] || DEFAULT_SPEC_TYPE}`;
			}
			if (![1, 2].includes(m.parallel)) {
				throw new Error(
					`model ${m["hf-repo"]} needs --parallel 1 or --parallel 2, got ${JSON.stringify(m.parallel)}`,
				);
			}
			cmd += ` --parallel ${m.parallel}`;
			// Baked snapshot paths last (the order the retired launch-gguf.sh
			// appended them in).  0text omits --mmproj entirely — the projector
			// must not be required for a text-only serving mode.
			cmd += ` --model ${baked.modelPath}`;
			if (mode.seg !== "0text" && baked.mmprojPath) {
				cmd += ` --mmproj ${baked.mmprojPath}`;
			}
			if (baked.draftPath) cmd += ` --model-draft ${baked.draftPath}`;

			const id = deriveModelId(m, mode.seg);
			if (models[id]) {
				logWarn("duplicate derived model id — skipping", {
					id,
					hfRepo: m["hf-repo"],
				});
				continue;
			}
			// capabilities.context enriches llama-swap's served metadata with the
			// context window; the "metadata" key (exact name required by llama-swap)
			// mirrors a pi-coding-agent models.json provider.models[] entry
			// (reasoning / input / contextWindow / maxTokens).
			models[id] = {
				cmd,
				capabilities: { in: modalities, out: ["text"], context: ctxSize },
				metadata: {
					id,
					reasoning: true,
					input: modalities,
					contextWindow: ctxSize,
					maxTokens: Math.min(ctxSize, nPredict),
					cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
				},
			};
		}
	}

	writeConfigD("10-local-llm-inference.yaml", { models });
	// The .paths manifest is the run.sh staleness preflight's input (docs/d029
	// B): pure host-side paths, one per line, re-verified before the serving
	// container starts. llama-swap ignores non-*.yml/*.yaml files in
	// -config-dir (internal/config/merge.go listYAMLFiles), so the companion
	// rides in config.d/ next to the layer it validates.
	writeArtifact(
		join(configD, "10-local-llm-inference.paths"),
		`${[...bakedHostPaths].sort().join("\n")}\n`,
	);
}

// --- orchestration (folded from the former generate.sh) ---------------------

mkdirSync(configD, { recursive: true });
logInfo("generating config.d", { dir: configD });

// 1. general layer: always.
generateGeneral();

// 2. local-inference layer: capability-gated. Requires the container backend
// (the unified-vulkan image runs llama.cpp against the GPU) and at least one
// dedicated inference device. LOCAL_INFERENCE=1 forces the layer regardless
// (debug: the generator still requires every configured GGUF in the host HF
// cache — provision it with ../local-llm/download_models.py first).
// Container-backend detection ports lib/workload-runtime.sh's
// detect_workload_tool; GPU detection ports its detect_gpu_devs.
const containerTool = existsSync("/usr/bin/podman")
	? "podman"
	: existsSync("/usr/bin/docker")
		? "docker"
		: null;
const gpuDevices = [
	existsSync("/dev/kfd") ? "/dev/kfd" : null,
	...(existsSync("/dev/dri")
		? readdirSync("/dev/dri")
				.filter((f) => f.startsWith("renderD"))
				.map((f) => `/dev/dri/${f}`)
		: []),
].filter((d) => d !== null);
const inferenceViable = containerTool !== null && gpuDevices.length > 0;

if (process.env.LOCAL_INFERENCE === "1" || inferenceViable) {
	generateLocalInference();
	// Stale resolver copies from pre-d029 generate.sh versions.
	rmSync(join(configD, "launch-gguf.sh"), { force: true });
	logInfo("local-inference layer generated", {
		containerTool,
		gpuDevices: gpuDevices.length,
	});
} else {
	rmSync(join(configD, "10-local-llm-inference.yaml"), { force: true });
	rmSync(join(configD, "10-local-llm-inference.paths"), { force: true });
	rmSync(join(configD, "launch-gguf.sh"), { force: true });
	logError(
		"no container backend + GPU devices — this host cannot serve local inference (LOCAL_INFERENCE=1 forces generation for debug)",
		{ containerTool, gpuDevices: gpuDevices.length },
	);
	process.exit(94);
}

// --- verify + report ---------------------------------------------------------
logInfo("config.d ready", {
	dir: configD,
	layers: readdirSync(configD).filter((f) => {
		const st = statSync(join(configD, f));
		return st.isFile();
	}),
});
