/**
 * @fileoverview generate.mjs — the llm-local-inference generator (d041 folded
 * the former generate.sh, gen-lib.mjs, generate-general.yaml.mjs and
 * generate-local-llm-models.yaml.mjs in): (re)generate the llama-swap config
 * in config.d/ for LOCAL GGUF inference. RUN THIS after a models/args change
 * (lib/llamacpp-model-data.json, llama-swap-core.json macros) or when a
 * host's capabilities changed (GPU added/removed, container backend
 * installed).
 *
 * Cloud/remote relaying is NOT generated here (nor anywhere): it is
 * served by ../estige, the raw passthrough proxy. This module
 * emits only what serves local llama.cpp GGUFs.
 *
 * Layers emitted:
 *   00-general.yaml              always  (globals + macros)
 *   10-local-llm-inference.yaml  only when this host is an inference endpoint
 *                                (container backend AND inference devices AND
 *                                the RAM floor — docs/d087), or LOCAL_INFERENCE=1
 *                                to force (debug only; the host HF cache must
 *                                carry every configured GGUF)
 * There is NO launch-gguf.sh: snapshot paths are resolved HERE
 * (generation-time baking, docs/d029 option B) and emitted as plain args in
 * each model's cmd; a cache miss is a generation error pointing at
 * ./download_models.py. Stale launch-gguf.sh copies from older
 * generate.sh versions are removed below.
 *
 * Layer-merge rules for the fragments (llama-swap's -config-dir loader;
 * docs/d018): identity-keyed maps merge additively and a duplicate key across
 * files is a hard error, while `apiKeys` concatenates and macros/scalars must
 * be single-defined — hence each layer owns a disjoint key set and
 * 00-general.yaml is the only home of the globals.
 *
 * Secrets: none at generation time. This module's generation is fully offline
 * (vendored tables only) and embeds NO keys — the single ${env.*} reference in
 * the generated config (TLALOCAYOTL_API_KEY, 00-general.yaml apiKeys) is resolved by
 * llama-swap from ITS OWN environment at load time, which the runner receives from the explicit
 * chain (./environment.sh ./py-run.sh llm-local-inference/run.py). Generation needs no
 * vault round-trip at all.
 *
 * Env overrides:
 *   LOCAL_INFERENCE   1 = force the local-inference layer regardless of the
 *                       capability gate (emits container-side paths; debug)
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structured logger + artifact writer from this folder's own lib/
 * (docs/d023/d113), resolved through the LIB_DIR convention so a copied-out
 * folder still finds its copy.
 * @type {string}
 */
const LIB_DIR = fileURLToPath(new URL("lib", import.meta.url));
const { logError, logInfo, logWarn } =
	/** @type {typeof import("./lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { writeArtifact } = /** @type {typeof import("./lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const configD = join(scriptDir, "config.d");

// --- config.d layer writers (folded gen-lib.mjs) ---------------------------

/**
 * Read the hand-maintained llama-swap core config (scalars, macros,
 * ctxWindows, apiKeys) that 00-general.yaml is built from.
 * @returns {Record<string, unknown>}
 */
function loadCore() {
	return JSON.parse(
		readFileSync(join(scriptDir, "llama-swap-core.json"), "utf-8"),
	);
}

/**
 * Write an object as pretty JSON into config.d/ (the YAML loader accepts JSON
 * content, and JSON-in-.yaml matches the repo's existing config style). Write
 * contract: lib/artifact.mjs (atomic tmp+rename, replace by default).
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
/**
 * Per d018's layer-merge rules this layer is the ONLY home of scalars /
 * macros / ctxWindows / apiKeys; the model layer must not redefine any.
 * @returns {void}
 */
function generateGeneral() {
	const core = loadCore();
	// models/peers belong to the local-inference layer below.
	delete core.models;
	delete core.peers;
	writeConfigD("00-general.yaml", core);
}

// --- 10-local-llm-inference.yaml (folded generate-local-llm-models.yaml.mjs)
// The local llama.cpp GGUF `models` map. Built from
// lib/llamacpp-model-data.json (this folder's copy of the table, d025/d113);
// no network access. The `cmd` strings reference macros defined in
// 00-general.yaml (${LLAMA_SERVER}, ${qwen36}, …) which llama-swap resolves
// after merging config.d/.

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
	"ctx-size": 65_536,
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

/**
 * The ONE home of the container-side hub path (docs/d029 F4): run.sh binds the
 * host HF cache here, and the baked cmd paths are written against it. Changing
 * this constant means changing run.sh's bind in the same edit.
 * @type {string}
 */
const HUB_GUEST = "/home/ubuntu/.cache/huggingface/hub";

/**
 * Host-side mirror of run.sh's HF_HUB_CACHE default (the same env-override
 * chain: HF_HUB_CACHE, else XDG_CACHE_HOME, else ~/.cache). Generation reads
 * the cache the serving container later binds, so both sides must compute the
 * same directory.
 * @type {string}
 */
const HUB_HOST =
	process.env.HF_HUB_CACHE ??
	join(
		process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
		"huggingface",
		"hub",
	);

/**
 * Sharded GGUF naming, kept in sync with download_models.py's
 * SPLIT_RE (that script downloads every shard; the generator verifies it did).
 * @type {RegExp}
 */
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
	if (!m) {
		return filename;
	}
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
	// SPLIT_RE's groups are all required, so a match carries them — the guard
	// below is the noUncheckedIndexedAccess narrowing of that fact.
	const m = SPLIT_RE.exec(first);
	const width = m?.[1]?.length;
	const total = m?.[2];
	if (m === null || width === undefined || total === undefined) {
		return [first];
	}
	const base = first.slice(0, first.length - m[0].length);
	return Array.from(
		{ length: Number(total) },
		(_, i) => `${base}-${String(i + 1).padStart(width, "0")}-of-${total}.gguf`,
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
 * download_models.py's job and is not duplicated as a
 * launch-time download fallback.
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @returns {{ modelPath: string, mmprojPath: string|null, draftPath: string|null }}
 *   container-side paths for the emitted cmd (mmproj/draft null when the entry
 *   omits them)
 */
function bakeSnapshotPaths(m) {
	const repo = m["hf-repo"].split(":")[0]; // drop :revision; the GGUF filename already pins the quant
	const repoDir = `models--${repo.split("/").join("--")}`;
	const snapshotsDir = join(HUB_HOST, repoDir, "snapshots");

	const candidates = [];
	const refPath = join(HUB_HOST, repoDir, "refs", "main");
	if (existsSync(refPath)) {
		const sha = readFileSync(refPath, "utf-8").trim();
		if (sha) {
			candidates.push(sha);
		}
	}
	if (existsSync(snapshotsDir)) {
		candidates.push(...readdirSync(snapshotsDir).sort());
	}

	const required = allShards(m.model);
	if (m.mmproj) {
		required.push(m.mmproj);
	}
	if (m["model-draft"]) {
		required.push(m["model-draft"]);
	}

	for (const sha of candidates) {
		const snapshot = join(snapshotsDir, sha);
		const missing = required.filter(
			(f) => !existsSync(join(snapshot, f)), // follows the blob symlinks
		);
		if (missing.length > 0) {
			continue;
		}

		const snapGuest = `${HUB_GUEST}/${repoDir}/snapshots/${sha}`;
		return {
			modelPath: `${snapGuest}/${shardOne(m.model)}`,
			mmprojPath: m.mmproj ? `${snapGuest}/${m.mmproj}` : null,
			draftPath: m["model-draft"] ? `${snapGuest}/${m["model-draft"]}` : null,
		};
	}

	logError(
		"no HF snapshot carries this entry — run ./download_models.py, then re-run the generator (./node-run.sh llm-local-inference/generate.mjs)",
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
 *   0text    -> --no-mmproj --ubatch-size 512   (projector never loaded; also
 *              emitted without --mmproj so the projector is never required)
 *   1vision  -> --no-mmproj-offload --ubatch-size 2048  (projector loaded, stays on CPU)
 *   2mmproj  -> --ubatch-size 2048                      (projector offloaded to GPU)
 * The 1vision/2mmproj variants additionally pass --image-min-tokens/
 * --image-max-tokens (the manifest pair when present, else
 * IMAGE_TOKENS_DEFAULT), and advertise the "image" input modality; 0text and
 * non-mmproj models stay text-only.
 * @type {readonly { seg: string|null, vision: boolean }[]}
 */
const MMPROJ_MODES = [
	{ seg: "0text", vision: false },
	{ seg: "1vision", vision: true },
	{ seg: "2mmproj", vision: true },
];

/**
 * Image token budget for vision modes when an entry carries no
 * `image-min-tokens`/`image-max-tokens` pair. The pair sits in the manifest
 * only as a deviation from this value (gemma-4's 1120), so absence stays the
 * compact spelling of "the default" instead of 40 identical rows.
 * @type {number}
 */
const IMAGE_TOKENS_DEFAULT = 1024;

/**
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @returns {{seg: string|null, vision: boolean}[]} the modes this entry emits —
 * every mmproj entry emits all three; swap time pays for the restored downloads
 * on heavy entries (d170: the 14 GB size gate and its `size-gb` input retired)
 */
function mmprojModesFor() {
	return MMPROJ_MODES;
}

/**
 * @param {number} contextWindow
 * @returns {string} zero-padded context slug for the model id
 */
// The quant now lives in `hf-repo` as `repo:revision`, and the kv-cache type is
// emitted inline (--cache-type-k/-v), so neither the quant slug nor the
// kv-quant segment appears in the id anymore — just the mmproj mode segment
// ("" for non-mmproj models) and the (unique) hf-repo. The active-b slug and
// the context slug are gone with their tables (d170): no guard anywhere
// protected either against drift, the tool that refreshed one is gone, and
// the context window a model serves is a property of the entry, not of the
// caller's choice — a second id spelling of the same ctx would only invite
// callers to pin a stale one. hf-repo carries the quant, so ids stay unique
// as long as one entry exists per repo:quant.
/**
 * @param {Record<string, any>} m
 * @param {string|null} modeSeg
 * @returns {string} the derived llama-swap model id
 */
function deriveModelId(m, modeSeg) {
	return `${modeSeg ? `${modeSeg}-` : ""}${m["hf-repo"]}`;
}

/**
 * Generate the 10-local-llm-inference layer.
 * Capability-gated by the CALLER (container backend + GPU devices; see the
 * orchestration block below) — LOCAL_INFERENCE=1 forces generation for debug
 * and the generator itself never re-checks viability.
 * @returns {void}
 */

// --- quant-display pruning ---------------------------------------------------

/**
 * Tail of one shard inside a split GGUF ("...-00001-of-00002.gguf"). Shard
 * groups are summed under the de-sharded name, so a repo's footprint per
 * quant is one number whether or not it was uploaded split.
 */
const GGUF_SHARD_RE = /-\d{5}-of-\d{5}\.gguf$/;

/**
 * Repos at or above this many BILLION total parameters never display BF16/F16:
 * the variant is already outside every footprint this fleet can serve, so it
 * only bloats the config with a model that can never load. Small models keep
 * them — there a full-precision variant is genuinely useful.
 * @type {number}
 */
const BF16_F16_HIDE_ABOVE_PARAMS_B = 4;

/**
 * Repos below this many BILLION total parameters are "low parameter models"
 * for the low-quant rule: their cheapest four quants are noise in the model
 * list, so they are dropped — but never past the top two quants, which a repo
 * with few quants must keep to stay servable at all.
 * @type {number}
 */
const LOW_QUANT_DROP_BELOW_PARAMS_B = 4;

/**
 * Repos below this many BILLION total parameters get their context window
 * raised to SMALL_MODEL_CTX_CAP — never past what the GGUF header declares
 * natively (`ctx-native` in the table; absent means no raise, never a
 * guess — the same stance the unsized-keeps rule takes).
 * @type {number}
 */
const SMALL_MODEL_CTX_RAISE_BELOW_PARAMS_B = 8;

/**
 * The context ceiling a small model is raised to (256k tokens).
 * @type {number}
 */
const SMALL_MODEL_CTX_CAP = 262_144;

/**
 * Bytes of each distinct main GGUF (shard groups summed) keyed by de-sharded
 * path, from one committed hf-manifest. The table entry's `model` field uses
 * the same path, so normalization is the only alignment needed.
 * @param {Array<{path: string, size: number}>} files
 * @returns {Map<string, number>} de-sharded GGUF path -> total bytes
 */
function mainGgufSizes(files) {
	/** @type {Map<string, number>} */
	const sizes = new Map();
	for (const f of files) {
		if (!f.path.endsWith(".gguf")) { continue; }
		// drafter/side builds (the mmproj projector, the MTP drafter, and the
		// partial dflash/dspark artifacts some repos ship beside the main
		// partial dflash/dspark artifacts some repos ship beside the main
		// quants) carry file sizes unrelated to the total parameter count —
		// a dflash bf16 once read a 27B blend as 1.9B
		if (/(^|\/)(mmproj|mtp|dflash|dspark)-/i.test(f.path)) { continue; }
		const key = f.path.replace(GGUF_SHARD_RE, ".gguf");
		sizes.set(key, (sizes.get(key) ?? 0) + f.size);
	}
	return sizes;
}

/**
 * The committed hf-manifest for one repo, main-GGUF sizes only. Throws when
 * the manifest is absent — every consumer (quant display, ctx raise) needs
 * the same file, so one loader keeps one error message.
 * @param {string} repo "org/repo"
 * @returns {Map<string, number>} de-sharded main GGUF path -> bytes
 */
function repoGgufSizes(repo) {
	const manifestPath = join(LIB_DIR, "hf-manifests", `${repo.replace("/", "--")}.json`);
	try {
		return mainGgufSizes(JSON.parse(readFileSync(manifestPath, "utf-8")).files);
	} catch (err) {
		throw new Error(
			"quant-display pruning needs the committed hf-manifest for " + repo +
				" (" + manifestPath + "): " + /** @type {Error} */ (err).message,
		);
	}
}

/**
 * Total parameter count, in billions, derived from a repo's BF16 (fallback
 * F16) main GGUF bytes: at 2 bytes per parameter those file sizes ARE the
 * parameter count, so no separate metadata table is needed. Returns null when
 * neither full-precision file exists. One fallback exists: repos that ship a
 * bare F16 build with no quant tag in the name (Spark's root upload) instead
 * of an F16-suffixed file — without it the small-model rules could not see
 * them at all. A bare build only counts when its name carries no quant tag:
 * the largest low-bit shard of a big model must never pass as full
 * precision, or a 24B repo would read as <8B.
 * @param {Map<string, number>} sizes from mainGgufSizes
 * @returns {number|null}
 */
function totalParamsB(sizes) {
	for (const tag of ["BF16", "F16"]) {
		for (const [key, bytes] of sizes) {
			const base = key.split("/").pop().replace(/\.gguf$/i, "");
			if (base.toLowerCase().endsWith(tag.toLowerCase())) {
				return bytes / 2 / 1e9;
			}
		}
	}
	// No full-precision upload: some repos ship a bare F16 build (no quant tag
	// in the name, e.g. Spark's root upload) instead of an F16-suffixed file.
	// Only those count — the largest low-bit shard of a big model must never
	// pass as "full precision", or a 24B repo would read as <8B.
	let f16Bytes = null;
	for (const [key, bytes] of sizes) {
		const base = key.split("/").pop().replace(/\.gguf$/i, "");
		if (/[.-](UD-|IQ[1-4]_|Q[2-8]_|TQ[1-2]_|BF16|F16|F32|NVFP4|MXFP4|FP8)/i.test(base)) { continue; }
		f16Bytes = Math.max(f16Bytes ?? 0, bytes);
	}
	return f16Bytes === null ? null : f16Bytes / 2 / 1e9;
}

/**
 * The two quant-display rules, both keyed off TOTAL parameters (not the
 * per-quant footprint) because total size is what decides whether a variant
 * can ever fit and whether its fidelity is worth a config slot:
 *  - a repo above BF16_F16_HIDE_ABOVE_PARAMS_B never displays BF16/F16;
 *  - a repo below LOW_QUANT_DROP_BELOW_PARAMS_B drops its four cheapest
 *    quants, but always keeps the top two, so a short quant list can never
 *    empty out.
 * Repos without a usable parameter estimate pass through unfiltered.
 * @param {Record<string, any>[]} entries the flat model-data table
 * @returns {Record<string, any>[]} entries to generate, same order
 */
function pruneQuantDisplay(entries) {
	/** @type {Map<string, Record<string, any>[]>} */
	const byRepo = new Map();
	for (const e of entries) {
		const repo = e["hf-repo"].split(":")[0];
		if (!byRepo.has(repo)) { byRepo.set(repo, []); }
		byRepo.get(repo).push(e);
	}
	const keep = new Set(entries);
	for (const [repo, group] of byRepo) {
		const sizes = repoGgufSizes(repo);
		const paramsB = totalParamsB(sizes);
		if (paramsB === null) {
			logWarn("quant-display pruning skipped — no BF16/F16 in hf-manifest", { repo });
			continue;
		}
		const roundB = Math.round(paramsB * 10) / 10;
		if (paramsB > BF16_F16_HIDE_ABOVE_PARAMS_B) {
			for (const e of group) {
				const quant = e["hf-repo"].split(":")[1];
				// suffix match, not equality: some repos spell the tag
			// "LFM3-1.7B-F16" rather than a bare "F16"
			if (quant && /(bf16|f16)$/i.test(quant)) {
					keep.delete(e);
					logWarn("quant-display: full-precision variant hidden (large model)", {
						repo, quant, paramsB: roundB,
					});
				}
			}
		}
		if (paramsB < LOW_QUANT_DROP_BELOW_PARAMS_B) {
			const bySize = group
				.map((e) => ({
					e,
					size: sizes.get(e.model.replace(GGUF_SHARD_RE, ".gguf")),
				}))
				.sort((a, b) => (a.size ?? Number.POSITIVE_INFINITY) - (b.size ?? Number.POSITIVE_INFINITY));
			const dropCount = Math.min(4, Math.max(0, bySize.length - 2));
			for (const { e } of bySize.slice(0, dropCount)) {
				keep.delete(e);
				logWarn("quant-display: cheap quant dropped (small model)", {
					repo, quant: e["hf-repo"].split(":")[1], paramsB: roundB,
				});
			}
		}
	}
	return entries.filter((e) => keep.has(e));
}


function generateLocalInference() {
	/**
	 * The model-data table lives in this folder's own lib/ (docs/d113: the
	 * copy is owned here, not shared through a repo-level lib/). Same LIB_DIR
	 * convention as the log import above.
	 */
	const modelData = JSON.parse(
		readFileSync(join(LIB_DIR, "llamacpp-model-data.json"), "utf-8"),
	);
	const entries = pruneQuantDisplay(modelData.models);

	/** @type {Record<string, unknown>} */
	const models = {};
	for (const raw of entries) {
		const m = { ...DEFAULTS, ...raw };
		// Small models get their context raised to the fleet cap — but never
		// past what the GGUF header declares natively (`ctx-native`, read per
		// the runbook; absent means "no raise", never a guess — the same
		// stance the unsized-keeps rule takes). The KV cost of 256k on a
		// <8B model is what the small weights left spare.
		const paramsB = totalParamsB(repoGgufSizes(m["hf-repo"].split(":")[0]));
		let ctxSize = m["ctx-size"]; // AUTHORITATIVE --ctx-size (not --fit-ctx)
		if (paramsB !== null && paramsB < SMALL_MODEL_CTX_RAISE_BELOW_PARAMS_B) {
			const native = m["ctx-native"];
			if (typeof native === "number") {
				ctxSize = Math.max(ctxSize, Math.min(SMALL_MODEL_CTX_CAP, native));
			}
		}
		const nPredict = ctxSize;
		/**
		 * One snapshot resolution per ENTRY (all three mmproj modes share it):
		 * refs/main carries the model, its every shard, and the mmproj/drafter
		 * at the same commit, or generation fails.
		 */
		const baked = bakeSnapshotPaths(m);
		const modes = m.mmproj ? mmprojModesFor(m) : [{ seg: null, vision: false }];
		for (const mode of modes) {
			const modalities = mode.vision ? ["text", "image"] : ["text"];
			/**
			 * The family macro reference (${qwen38} etc.) and any literal extra flags
			 * live in __argv verbatim; llama-swap expands ${...} at load. Empty __argv
			 * expands to nothing; shlex collapses the gap. The expanded
			 * ${LLAMA_SERVER} must be the FIRST cmd token: shlex argv[0] is the
			 * server binary llama-swap resolves on PATH and execs directly.
			 * @type {string}
			 */
			let cmd = LLAMA_SERVER_MACRO;
			// The mode slug is verbatim llama-swap macro text (\${0text} etc.),
			// NOT JS interpolation — it expands to the projector-offload flags.
			if (mode.seg) {
				cmd += ` \${${mode.seg}}`;
			}
			if (mode.vision) {
				cmd += ` --image-min-tokens ${m["image-min-tokens"] ?? IMAGE_TOKENS_DEFAULT} --image-max-tokens ${m["image-max-tokens"] ?? IMAGE_TOKENS_DEFAULT}`;
			}
			if (m.__argv) {
				cmd += ` ${m.__argv}`;
			}
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
			if (baked.draftPath) {
				cmd += ` --model-draft ${baked.draftPath}`;
			}

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
				},
			};
		}
	}

	writeConfigD("10-local-llm-inference.yaml", { models });
}

// --- orchestration (folded from the former generate.sh) ---------------------

mkdirSync(configD, { recursive: true });
logInfo("generating config.d", { dir: configD });

// 1. general layer: always.
generateGeneral();

// 2. local-inference layer: capability-gated on being an INFERENCE ENDPOINT
// (docs/d087): the container backend (the unified-vulkan image runs llama.cpp
// against the GPU), at least one dedicated inference device, AND the RAM
// floor — weights plus KV cache do not fit on a low-RAM host no matter what
// accelerators it has. LOCAL_INFERENCE=1 forces the layer regardless
// (debug: the generator still requires every configured GGUF in the host HF
// cache — provision it with ./download_models.py first).
// All probes/thresholds come from lib/host-capabilities.mjs — the SAME
// definitions build.mjs gates its llama-swap pull on (the device probes port
// workload-runtime.sh's detect_workload_tool/detect_gpu_devs), so this
// layer's viability and the builder's target set cannot drift apart.
const {
	detectContainerTool,
	detectGpuDevices,
	totalMemGiB,
	INFERENCE_MIN_RAM_GIB,
} = /** @type {typeof import("./lib/host-capabilities.mjs")} */ (
	await import(`${LIB_DIR}/host-capabilities.mjs`)
);
const containerTool = detectContainerTool();
const gpuDevices = detectGpuDevices();
const hostRamGiB = totalMemGiB();
const inferenceViable =
	containerTool !== null &&
	gpuDevices.length > 0 &&
	hostRamGiB >= INFERENCE_MIN_RAM_GIB;

if (process.env.LOCAL_INFERENCE === "1" || inferenceViable) {
	generateLocalInference();
	// Stale resolver copies from pre-d029 generate.sh versions.
	rmSync(join(configD, "launch-gguf.sh"), { force: true });
	logInfo("local-inference layer generated", {
		containerTool,
		gpuDevices: gpuDevices.length,
		ramGiB: hostRamGiB,
	});
} else {
	rmSync(join(configD, "10-local-llm-inference.yaml"), { force: true });
	rmSync(join(configD, "10-local-llm-inference.paths"), { force: true });
	rmSync(join(configD, "launch-gguf.sh"), { force: true });
	logError(
		"host is not an inference endpoint (no container backend, no inference devices, or RAM below the floor) — cannot serve local inference (LOCAL_INFERENCE=1 forces generation for debug)",
		{
			containerTool,
			gpuDevices: gpuDevices.length,
			ramGiB: hostRamGiB,
			minRamGiB: INFERENCE_MIN_RAM_GIB,
		},
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
