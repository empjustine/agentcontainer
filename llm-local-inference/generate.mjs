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
 * each model's cmd; a cache miss WARNS and still emits a complete config,
 * because a host that has not pulled yet must generate (the miss surfaces as
 * llama-server's 127 at swap time). Stale launch-gguf.sh copies from older
 * generate.sh versions are removed below.
 *
 * Three inputs are committed facts, never hand-maintained: lib/hf-manifests/
 * (what a repo ships — file validation, projector choice, parameter counts),
 * lib/gguf-facts.json (GGUF header truth: context ceilings, docs/d197) and
 * llama-swap-core.json (macros).
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
 * Implicit entry defaults: keys an entry may omit because the generator owns
 * them. `ctx-size` is NOT one of them — the window comes from the model's own
 * GGUF header via lib/gguf-facts.json (docs/d197). f16 KV is the low-KLD
 * default; only a memory-pressed entry overrides it.
 * @type {Record<string, number|string>}
 */
const DEFAULTS = {
	"cache-type-k": "f16",
	"cache-type-v": "f16",
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
 * No candidate qualifies ⇒ WARN and bake against the best revision a committed
 * source names (refs/main, else the manifest's resolved commit): a host that
 * has not pulled yet must still generate a complete config, and a wrong path
 * is llama-server's documented 127 at swap time, not a generation failure
 * (docs/d197 — the hard-fail blocked first-run and cache-less hosts for a
 * condition download_models.py owns).
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

	const sha = candidates[0] ?? repoManifest(repo).commit;
	if (sha === null) {
		throw new Error(
			`no cached snapshot and no committed manifest commit to bake ${m["hf-repo"]} against`,
		);
	}
	logWarn(
		"no cached HF snapshot carries this entry — run ./download_models.py; baking unverified paths",
		{ repo, sha, snapshotsChecked: candidates.length, required },
	);
	const snapGuest = `${HUB_GUEST}/${repoDir}/snapshots/${sha}`;
	return {
		modelPath: `${snapGuest}/${shardOne(m.model)}`,
		mmprojPath: m.mmproj ? `${snapGuest}/${m.mmproj}` : null,
		draftPath: m["model-draft"] ? `${snapGuest}/${m["model-draft"]}` : null,
	};
}

/**
 * One llama-swap model per level of commitment to GPU-offloading the vision
 * projector — the fan is size-gated, see MMPROJ_OFFLOAD_MAX_VRAM_SHARE. The
 * middle slug segment doubles as a llama-swap macro name
 * (llama-swap-core.json):
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
 * The card every size rule is measured against: the fleet's serving GPU, a
 * 16 GiB-class board (15.98 GiB measured from
 * `/sys/class/drm/card1/device/mem_info_vram_total` on tlalocayotl). A
 * constant, not a probe: `config.d` is a committed artifact, so its contents
 * must not change with the card of whichever host regenerates it (d050). A
 * different fleet card moves this number and the shares below, together.
 * @type {number}
 */
const FLEET_VRAM_GIB = 16;

/**
 * Share of `FLEET_VRAM_GIB` a repo's weights are estimated to occupy when
 * served, i.e. what is left for the KV cache on that card.
 *
 * Total parameters (not active) times the fleet's serving bytes per parameter:
 * the Q4–Q8 ladder this table publishes averages ~1 GiB per billion, the round
 * number every threshold below is set on. Total, not active, on purpose — a
 * 35B-A3B still has to LOAD 35B of weights, and that is what competes with the
 * KV cache for VRAM.
 *
 * Rules quote this share rather than a parameter count so one line reads the
 * same on any card: ~4B ≈ 25%, ~8B ≈ 50%, ~12B ≈ 75% of a 16 GiB board
 * (docs/d199).
 * @param {number} paramsB total parameters, in billions
 * @returns {number} estimated share of the fleet card (1 = the whole card)
 */
function weightsVramShare(paramsB) {
	return paramsB / FLEET_VRAM_GIB;
}

/**
 * Share of the card a FULL-PRECISION copy of the same weights occupies —
 * 2 bytes per parameter, which is what a BF16/F16 GGUF is.
 * @param {number} paramsB total parameters, in billions
 * @returns {number} estimated share of the fleet card (1 = the whole card)
 */
function fullPrecisionVramShare(paramsB) {
	return (2 * paramsB) / FLEET_VRAM_GIB;
}

/**
 * Projector-offload ceiling: d055's gate, re-landed after d170 retired
 * `size-gb`. Above three quarters of the card the weights leave the GPU-resident
 * projector no headroom, so `2mmproj` runs SLOWER than `1vision` — the mode's
 * premise inverts exactly where it is offered. `0text` + `1vision` still cover
 * text and CPU-projector vision, so only the redundant variant goes (d195).
 * @type {number}
 */
const MMPROJ_OFFLOAD_MAX_VRAM_SHARE = 0.75;

/**
 * "Small model" line: weights under a quarter of the card. Both trimming rules
 * read it, because below it nothing needs trimming —
 *  - the quant ladder's cheapest rows are all servable, so they are noise
 *    (CHEAP_QUANT constants), and
 *  - a projector fits alongside the weights comfortably, so `0text` — the
 *    no-projector mode whose whole point is clawing VRAM back — buys a caller
 *    nothing and costs them images (d200).
 * @type {number}
 */
const SMALL_MODEL_VRAM_SHARE = 0.25;

/**
 * The publisher's declared parameter count from the repo slug — `Qwen3.8-27B`,
 * `gemma-4-E2B`, `LFM2.5-VL-3B` — in billions, or null.
 * A name read is needed because 10 of the 18 mmproj repos ship NO full-precision
 * file, so `totalParamsB` is null for exactly the 26B/27B/31B/35B qat, byteshape
 * and JetBrains repos the ceiling exists to catch — and d170's "unsized keeps"
 * stance would then hand them the one mode the ceiling suppresses. The token
 * agrees with the manifest count on every repo where both exist, and the
 * degenerate active-parameter segments (`A3B`, `A4B`) never come first.
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @returns {number|null}
 */
function declaredParamsB(m) {
	const slug = m["hf-repo"].split(":")[0].split("/").pop() ?? "";
	const match = /(?:^|[^0-9])(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/i.exec(slug);
	return match ? Number(match[1]) : null;
}

/**
 * The fan, gated from BOTH ends (docs/d195, d200): the mode set exists to trade
 * VRAM for projector placement, so it only earns its slots where VRAM is
 * actually contested.
 *  - over the ceiling (weights > 75% of the card) the offloaded projector has no
 *    headroom and runs slower than the CPU one: drop `2mmproj`;
 *  - under the small-model line (weights < 25%) the projector fits next to the
 *    weights anyway, so `0text` — the no-projector mode whose only purpose is
 *    clawing VRAM back — is a needlessly compromised candidate: drop it.
 * @param {number|null} paramsB total (not active) parameters, or null when
 * neither the manifest nor the slug declares them
 * @returns {{seg: string|null, vision: boolean}[]} the modes this entry emits —
 * unknown parameters keep all three, the "unsized keeps, never guesses" stance
 * d170 recorded
 */
function mmprojModesFor(paramsB) {
	if (paramsB === null) {
		return MMPROJ_MODES;
	}
	const share = weightsVramShare(paramsB);
	if (share > MMPROJ_OFFLOAD_MAX_VRAM_SHARE) {
		return MMPROJ_MODES.filter((mode) => mode.seg !== "2mmproj");
	}
	if (share < SMALL_MODEL_VRAM_SHARE) {
		return MMPROJ_MODES.filter((mode) => mode.seg !== "0text");
	}
	return MMPROJ_MODES;
}

/**
 * Projector quant preference, best first. BF16 is the fleet ceiling for a
 * projector: the file is tiny, so the F16 half-precision buy is a lossy
 * trade for nothing (docs/d197). F16 stays a valid explicit override; the
 * rest are last resorts for repos that publish nothing better.
 * @type {readonly string[]}
 */
const MMPROJ_QUANT_PRIORITY = ["bf16", "f16", "f32", "q8_0"];

/**
 * @param {string} path a manifest file path
 * @returns {number} index into MMPROJ_QUANT_PRIORITY, or the list length
 */
function mmprojRank(path) {
	const quant = /mmproj-(.+)\.gguf$/i.exec(path)?.[1]?.toLowerCase() ?? "";
	const rank = MMPROJ_QUANT_PRIORITY.indexOf(quant);
	return rank === -1 ? MMPROJ_QUANT_PRIORITY.length : rank;
}

/**
 * The projector a repo should serve, straight from its committed manifest.
 * This is the ONE home of vision capability: a per-entry `mmproj` key drifted
 * (2 of gemma-4-12b's 21 entries carried it) because the capability is a repo
 * fact, not a quant fact (docs/d197).
 * @param {string} repo "org/repo"
 * @returns {string|null} manifest path of the best projector, or null
 */
function repoMmproj(repo) {
	const candidates = repoManifest(repo)
		.files.map((f) => f.path)
		.filter((path) => /(^|\/)mmproj-.*\.gguf$/i.test(path));
	if (candidates.length === 0) {
		return null;
	}
	candidates.sort((a, b) => mmprojRank(a) - mmprojRank(b) || a.localeCompare(b));
	return candidates[0] ?? null;
}

/**
 * Image-token budget declared anywhere in this repo, so an entry that gains
 * vision by the projector fill inherits its family's budget (gemma-4: 1120)
 * instead of silently dropping to the generic default.
 * @type {Map<string, {min: number, max: number}|null>}
 */
const REPO_IMAGE_TOKENS = new Map();

/**
 * @param {Record<string, any>[]} rows the RAW model-data table (the record of
 * every quant, so pruning cannot empty a repo of its declared pair)
 * @returns {void}
 */
function indexImageTokens(rows) {
	for (const row of rows) {
		const repo = row["hf-repo"].split(":")[0];
		const min = row["image-min-tokens"];
		const max = row["image-max-tokens"];
		if (typeof min !== "number" || typeof max !== "number") {
			continue;
		}
		const seen = REPO_IMAGE_TOKENS.get(repo);
		if (seen && (seen.min !== min || seen.max !== max)) {
			logWarn("repo declares two image-token budgets — keeping the first", {
				repo,
				kept: seen,
				ignored: { min, max },
			});
			continue;
		}
		REPO_IMAGE_TOKENS.set(repo, { min, max });
	}
}

/**
 * Validate an entry against its committed manifest, then fill what the
 * manifest proves. A declared file the manifest does not carry is a HARD
 * ERROR: the manifest is committed truth, so a miss is a typo or a stale
 * table, never a host state (docs/d197).
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @returns {void} mutates m: resolves `mmproj`, fills the image-token pair
 */
function resolveEntryFiles(m) {
	const repo = m["hf-repo"].split(":")[0];
	const shipped = new Set(repoManifest(repo).files.map((f) => f.path));
	const declared = [...allShards(m.model)];
	if (m.mmproj) {
		declared.push(m.mmproj);
	}
	if (m["model-draft"]) {
		declared.push(m["model-draft"]);
	}
	for (const file of declared) {
		if (!shipped.has(file)) {
			throw new Error(
				`model ${m["hf-repo"]} declares ${file}, which its committed hf-manifest does not carry (re-run fetch_hf_manifests.py, then fix the table)`,
			);
		}
	}

	const preferred = repoMmproj(repo);
	if (m.mmproj && preferred !== null && m.mmproj !== preferred) {
		logWarn("projector is not this repo's BF16 pick — valid override, kept", {
			repo,
			declared: m.mmproj,
			preferred,
		});
	}
	const projector = m.mmproj ?? preferred;
	if (projector) {
		m.mmproj = projector;
		const tokens = REPO_IMAGE_TOKENS.get(repo);
		m["image-min-tokens"] ??= tokens?.min ?? IMAGE_TOKENS_DEFAULT;
		m["image-max-tokens"] ??= tokens?.max ?? IMAGE_TOKENS_DEFAULT;
	} else {
		delete m.mmproj;
	}
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
 * A repo whose FULL-PRECISION copy would claim more than half the card never
 * displays BF16/F16: half the VRAM on weights alone leaves no room for the KV
 * cache the same model needs, so the variant can only ever bloat the config
 * with a model that cannot load. Below the line a full-precision variant is
 * genuinely useful and stays.
 * @type {number}
 */
const FULL_PRECISION_MAX_VRAM_SHARE = 0.5;

/**
 * The low-quant rule's two numbers. A small model (SMALL_MODEL_VRAM_SHARE) has
 * every quant servable, so its cheapest rows are noise in a catalog this size:
 * cut at most CHEAP_QUANT_DROP_MAX of them, and never below
 * CHEAP_QUANT_KEEP_MIN rows — a repo with few quants must keep a servable
 * ladder, so the floor counts rows, not dropped quants (docs/d200 made this
 * gentler than d170's four/two).
 * @type {number}
 */
const CHEAP_QUANT_DROP_MAX = 3;

/**
 * @type {number}
 */
const CHEAP_QUANT_KEEP_MIN = 3;

/**
 * Fleet context ceiling. Every entry serves its model's NATIVE context up to
 * this line: the fleet's priority is correct behaviour — the widest window the
 * weights and the KV cache can honestly claim — over fast execution, so the
 * old small-model-only raise and the 65k default are gone (docs/d197).
 * `--fit on` in the LLAMA_SERVER macro still reconciles a host too small for
 * the window at launch.
 * @type {number}
 */
const CTX_CAP = 262_144;

/**
 * Context used only when neither the entry pins one nor lib/gguf-facts.json
 * knows the model — a freshly added entry, before `gguf_context_length.py
 * --facts` runs. Conservative on purpose: an unknown window must not claim a
 * bigger one than the fleet default has always served.
 * @type {number}
 */
const CTX_FALLBACK = 65_536;

/**
 * GGUF header truth for the files this table serves, keyed by repo — a repo
 * whose served files disagree drops to a per-file map (`files`). Written by
 * `gguf_context_length.py --facts` from the cached GGUFs' own metadata, pruned
 * to configured files, normalized (sorted, integers, no timestamp) so a refresh
 * re-writes the same bytes. A hand value here would be a second home for a
 * header fact, which is how "marketing" 256K claims leaked into the table
 * (docs/d197).
 * @type {Record<string, Fact|{files: Record<string, Fact>}>}
 * @typedef {{arch?: string, "ctx-native"?: number}} Fact
 */
const GGUF_FACTS = JSON.parse(
	readFileSync(join(LIB_DIR, "gguf-facts.json"), "utf-8"),
);

/**
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @returns {number|null} this entry's file's header `context_length`, or null
 * when the facts file has nothing for it
 */
function factsCtxNative(m) {
	const fact = GGUF_FACTS[m["hf-repo"].split(":")[0]];
	const perFile = fact?.files?.[m.model] ?? fact;
	return typeof perFile?.["ctx-native"] === "number" ? perFile["ctx-native"] : null;
}

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
 * The committed hf-manifest for one repo — the ONE loader for every fact
 * generation takes from it: which files the repo ships (entry validation and
 * the projector choice), the total parameter count (d170's rule) and the
 * resolved commit (the bake fallback when the host cache lacks the entry).
 * Throws when the manifest is absent: a repo with no manifest is a table entry
 * whose files nothing can vouch for.
 * @type {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>}
 */
const MANIFEST_CACHE = new Map();

/**
 * @param {string} repo "org/repo"
 * @returns {{commit: string|null, files: Array<{path: string, size: number}>}}
 */
function repoManifest(repo) {
	const cached = MANIFEST_CACHE.get(repo);
	if (cached) {
		return cached;
	}
	const manifestPath = join(LIB_DIR, "hf-manifests", `${repo.replace("/", "--")}.json`);
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
		const manifest = {
			commit: typeof parsed.commit === "string" ? parsed.commit : null,
			files: parsed.files,
		};
		MANIFEST_CACHE.set(repo, manifest);
		return manifest;
	} catch (err) {
		throw new Error(
			"generation needs the committed hf-manifest for " + repo +
				" (" + manifestPath + "): " + /** @type {Error} */ (err).message,
		);
	}
}

/**
 * @param {string} repo "org/repo"
 * @returns {Map<string, number>} de-sharded main GGUF path -> bytes
 */
function repoGgufSizes(repo) {
	return mainGgufSizes(repoManifest(repo).files);
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
 * The two quant-display rules, both stated as a share of the fleet card rather
 * than a parameter count, so one line reads the same on any card (docs/d199):
 *  - a repo whose full-precision copy would claim more than
 *    FULL_PRECISION_MAX_VRAM_SHARE never displays BF16/F16;
 *  - a repo whose served weights claim less than SMALL_MODEL_VRAM_SHARE drops
 *    up to CHEAP_QUANT_DROP_MAX of its cheapest quants, but always keeps
 *    CHEAP_QUANT_KEEP_MIN rows, so a short quant list can never empty out.
 * Both are measured on TOTAL parameters (not the per-quant footprint, not
 * active parameters): a 35B-A3B must LOAD 35B of weights, and loading is what
 * competes with the KV cache for the card. Repos without a usable parameter
 * estimate pass through unfiltered.
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
		if (fullPrecisionVramShare(paramsB) > FULL_PRECISION_MAX_VRAM_SHARE) {
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
		if (weightsVramShare(paramsB) < SMALL_MODEL_VRAM_SHARE) {
			const bySize = group
				.map((e) => ({
					e,
					size: sizes.get(e.model.replace(GGUF_SHARD_RE, ".gguf")),
				}))
				.sort((a, b) => (a.size ?? Number.POSITIVE_INFINITY) - (b.size ?? Number.POSITIVE_INFINITY));
			const dropCount = Math.min(
				CHEAP_QUANT_DROP_MAX,
				Math.max(0, bySize.length - CHEAP_QUANT_KEEP_MIN),
			);
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
	indexImageTokens(modelData.models);
	const entries = pruneQuantDisplay(modelData.models);

	/** @type {Record<string, unknown>} */
	const models = {};
	for (const raw of entries) {
		const m = { ...DEFAULTS, ...raw };
		resolveEntryFiles(m);
		const paramsB = totalParamsB(repoGgufSizes(m["hf-repo"].split(":")[0]));
		// The window is the GGUF header's `context_length`, capped by the fleet
		// ceiling; an entry may pin a LOWER value but never a higher one, because
		// the header is hardware truth and a pinned value above it is a claim the
		// model cannot serve (docs/d197). Absent facts means the model is newer
		// than the artifact: serve the conservative default and say so.
		const native = factsCtxNative(m);
		let ctxSize = m["ctx-size"] ?? native ?? CTX_FALLBACK;
		if (native === null) {
			logWarn("no GGUF facts for this entry — serving the fallback context (run gguf_context_length.py --facts)", {
				repo: m["hf-repo"],
				model: m.model,
				ctxSize,
			});
		} else if (ctxSize > native) {
			logWarn("pinned ctx-size exceeds the header's context_length — clamping to the header", {
				repo: m["hf-repo"],
				pinned: m["ctx-size"],
				native,
			});
			ctxSize = native;
		}
		ctxSize = Math.min(ctxSize, CTX_CAP);
		const nPredict = ctxSize;
		/**
		 * One snapshot resolution per ENTRY (all mmproj modes share it):
		 * refs/main carries the model, its every shard, and the mmproj/drafter
		 * at the same commit, else the bake warns and names what provisioning owes.
		 */
		const baked = bakeSnapshotPaths(m);
		const modes = m.mmproj
			? mmprojModesFor(paramsB ?? declaredParamsB(m))
			: [{ seg: null, vision: false }];
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
				// A duplicate id is two entries claiming one serving slot: emitting
				// one and dropping the other silently removes a model from the
				// catalog, and the generated layer would no longer be a function of
				// the table (d050). Stop and make the operator choose.
				throw new Error(
					`duplicate derived model id "${id}" — two entries serve the same repo:quant and mode; fix lib/llamacpp-model-data.json`,
				);
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
