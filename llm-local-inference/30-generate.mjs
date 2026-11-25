/**
 * @fileoverview 30-generate.mjs — the llm-local-inference generator (d041 folded
 * the former generate.sh, gen-lib.mjs, generate-general.yaml.mjs and
 * generate-local-llm-models.yaml.mjs in): (re)generate the llama-swap config
 * in config.d/ for LOCAL GGUF inference. RUN THIS after a models/args change
 * (lib/llamacpp-model-data.json, llama-swap-core.json macros) or when a
 * host's capabilities changed (GPU added/removed, container backend
 * installed).
 *
 * Cloud/remote relaying is NOT generated here (nor anywhere): it is
 * served by ../estige, whose tunnel transports carry the client's own CONNECT
 * (the allowlist proxy died with docs/d108). This module
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
 * d232): identity-keyed maps merge additively and a duplicate key across
 * files is a hard error, while `apiKeys` concatenates and macros/scalars must
 * be single-defined — hence each layer owns a disjoint key set and
 * 00-general.yaml is the only home of the globals.
 *
 * Secrets: none at generation time. This module's generation is fully offline
 * (vendored data only) and embeds NO keys — the single ${env.*} reference in
 * the generated config (TLALOCAYOTL_API_KEY, 00-general.yaml apiKeys) is resolved by
 * llama-swap from ITS OWN environment at load time, which the runner receives from the explicit
 * chain (./environment.sh uv run llm-local-inference/run.py). Generation needs no
 * vault round-trip at all.
 *
 * Outputs, both from the same in-memory set so they cannot disagree:
 *   lib/curated/<org>--<repo>.json   one repo's provisioning input (the
 *                                    files its entries need, resolved from
 *                                    the committed repo manifest)
 *   config.d/*.yaml                  the llama-swap rendering
 * The cache scope (lib/cache-scope.json) is checked in both directions before
 * anything is written: an entry without a scope line, a served line without
 * entries and an audit-only line with entries are REPORTED as warnings (the row
 * edit is the decision, the scope line is bookkeeping); an unknown mode stops
 * the run (docs/d212).
 *
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

import { writeArtifact, writeJsonArtifact } from "./lib/artifact.mjs";
import { exitCodeOf, failure } from "./lib/failure.mjs";
import {
	detectContainerTool,
	detectGpuDevices,
	INFERENCE_MIN_RAM_GIB,
	totalMemGiB,
} from "./lib/host-capabilities.mjs";
import { logError, logInfo, logWarn, setLogTool } from "./lib/log.mjs";
import {
	GGUF_SHARD_RE,
	FULL_PRECISION_BYTES_PER_PARAM,
	FULL_PRECISION_NAME_RE,
	allShards,
	fullPrecisionTag,
	mainGgufSizes,
	shardOne,
} from "./lib/model-entries.mjs";

// --- config.d layer writers (folded gen-lib.mjs) ---------------------------

/**
 * Read the hand-maintained llama-swap core config (scalars, macros,
 * ctxWindows, apiKeys) that 00-general.yaml is built from.
 * @param {string} scriptDir this generator's own folder
 * @returns {Record<string, unknown>}
 */
function loadCore(scriptDir) {
	return JSON.parse(
		readFileSync(join(scriptDir, "llama-swap-core.json"), "utf-8"),
	);
}

/**
 * Write an object as pretty JSON into config.d/ (the YAML loader accepts JSON
 * content, and JSON-in-.yaml matches the repo's existing config style). Write
 * contract: lib/artifact.mjs (atomic tmp+rename, replace by default).
 * @param {string} configDir the config.d directory to write into
 * @param {string} name layer filename (e.g. "10-local-llm-inference.yaml")
 * @param {unknown} obj config object to serialize
 * @returns {void}
 */
function writeConfigD(configDir, name, obj) {
	mkdirSync(configDir, { recursive: true });
	const path = writeArtifact(
		join(configDir, name),
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
/**
 * @param {string} scriptDir
 * @param {string} configDir
 */
function generateGeneral(scriptDir, configDir) {
	const core = loadCore(scriptDir);
	// The models map belongs to the local-inference layer below.
	delete core.models;
	writeConfigD(configDir, "00-general.yaml", core);
}

// --- 10-local-llm-inference.yaml (folded generate-local-llm-models.yaml.mjs)
// The local llama.cpp GGUF `models` map. Built from
// lib/llamacpp-model-data.json (this folder's copy of the model manifest, d025/d113);
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
 * GGUF header via lib/gguf-facts.json (docs/d197).
 *
 * There is no `cache-type-k` on purpose: the KEY cache stays at llama.cpp's f16
 * default for every entry, because quantizing keys is the half of the KV-cache
 * trade that moves KLD (docs/d206). Only values may be quantized, and an entry
 * that quantizes them quantizes the drafter's cache with them.
 * @type {Record<string, number|string>}
 */
const DEFAULTS = {
	"cache-type-v": "f16",
	parallel: 1,
};

/**
 * Spec type for an entry that declares a `model-draft` sidecar but no kind of
 * its own (unsloth ships MTP sidecars under the repo's MTP/ subdir). A dflash
 * or dspark sidecar must name its type in the model entry instead: llama.cpp refuses
 * a type that does not match the drafter's head, and a DSpark drafter without a
 * confidence head refuses `--spec-draft-p-min` (docs/d206).
 * --model-draft ALONE is a no-op for speculation when the target model is a
 * local path: the server only auto-infers the spec type on the --hf-repo
 * download path, so --spec-type must be emitted explicitly.
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
 * The hub root must be VISIBLE. Generation verifies every baked path against
 * this directory, so an invisible root disables that verification for the whole
 * catalog at once — indistinguishable from a host that has pulled nothing, which
 * is why it would bake every path unverified and exit 0. A root that EXISTS but
 * lacks one repo stays the warn-and-bake rule (docs/d197); a root that is
 * absent, not a directory, or unreadable is a host/configuration failure and
 * generation stops with exit 95 (docs/d207).
 * @param {string} hubHost the host HF hub cache root
 * @returns {void}
 */
function requireVisibleHub(hubHost) {
	let reason = null;
	try {
		if (statSync(hubHost).isDirectory()) {
			// proves the mount is readable, not merely present
			readdirSync(hubHost);
		} else {
			reason = "not a directory";
		}
	} catch (err) {
		reason = /** @type {NodeJS.ErrnoException} */ (err).code ?? String(err);
	}
	if (reason === null) {
		return;
	}
	throw failure(
		"the HF hub cache is not visible — every baked path would be unverified (point HF_HUB_CACHE at the mount, or provision it with ./40-download-models.py)",
		95,
		{ hub: hubHost, reason },
	);
}

/**
 * Resolve one manifest entry to ONE HF snapshot dir and bake the final
 * container-side paths. Candidate snapshots: the refs/main revision first —
 * the revision 40-download-models.py pins, so a healthy cache always resolves
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
 * condition 40-download-models.py owns).
 * @param {string} hubHost the host HF hub cache root
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @param {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} manifests
 *   the run's manifest cache
 * @param {string} libDir this folder's own lib/
 * @returns {{ modelPath: string, shardPaths: string[], mmprojPath: string|null, draftPath: string|null }}
 *   container-side paths for the emitted cmd (mmproj/draft null when the entry
 *   omits them, shardPaths empty for a single-file model)
 */
function bakeSnapshotPaths(hubHost, m, manifests, libDir) {
	const repo = m["hf-repo"].split(":")[0]; // drop :revision; the GGUF filename already pins the quant
	const repoDir = `models--${repo.split("/").join("--")}`;
	const snapshotsDir = join(hubHost, repoDir, "snapshots");

	const candidates = [];
	// Both candidates lists come from a scan of the cache, and their absence is
	// an ordinary answer (the fallback below bakes the manifest commit): the
	// scan's own ENOENT says so, one syscall later than a probe would and
	// without a window in between (docs/d228).
	try {
		const sha = readFileSync(join(hubHost, repoDir, "refs", "main"), "utf-8").trim();
		if (sha) {
			candidates.push(sha);
		}
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
			throw error;
		}
	}
	try {
		candidates.push(...readdirSync(snapshotsDir).sort());
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
			throw error;
		}
	}

	const required = entryShards(m, manifests, libDir);
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

		return guestPaths(sha);
	}

	const sha = candidates[0] ?? repoManifest(manifests, libDir, repo).commit;
	if (sha === null) {
		throw new Error(
			`no cached snapshot and no committed manifest commit to bake ${m["hf-repo"]} against`,
		);
	}
	logWarn(
		"no cached HF snapshot carries this entry — run ./40-download-models.py; baking unverified paths",
		{ repo, sha, snapshotsChecked: candidates.length, required },
	);
	return guestPaths(sha);

	/**
   * The guest-side paths of ONE snapshot — the shape both the resolved and the
   * unverified branch emit, so a fix to one cannot miss the other.
   * @param {string} sha
   * @returns {{ modelPath: string, shardPaths: string[], mmprojPath: string|null, draftPath: string|null }}
   */
	function guestPaths(sha) {
		const snapGuest = `${HUB_GUEST}/${repoDir}/snapshots/${sha}`;
		return {
			modelPath: `${snapGuest}/${shardOne(m.model)}`,
			// Every extra shard is named explicitly (docs/d210): the server can
			// stitch shards that live anywhere, and relying on the sibling-name
			// convention turns a mis-named upload into a load failure instead of
			// a generation check.
			shardPaths: entryShards(m, manifests, libDir)
				.slice(1)
				.map((shard) => `${snapGuest}/${shard}`),
			mmprojPath: m.mmproj ? `${snapGuest}/${m.mmproj}` : null,
			draftPath: m["model-draft"] ? `${snapGuest}/${m["model-draft"]}` : null,
		};
	}
}

/**
 * Image token budget for vision modes when an entry carries no
 * `image-min-tokens`/`image-max-tokens` pair. The pair sits in the manifest
 * only as a deviation from this value (gemma-4's 1120), so absence stays the
 * compact spelling of "the default" instead of 40 identical entries.
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
 * the Q4–Q8 ladder this manifest publishes averages ~1 GiB per billion, the round
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
 * Share of the card a GGUF of these bytes claims once loaded — the one unit
 * conversion the display rules measure a entry with, so a ceiling and the entry it
 * judges cannot disagree. Decimal GB, the unit `totalParamsB` reports, so the
 * two readings of one file agree.
 * @param {number} bytes
 * @returns {number} share of the fleet card (1 = the whole card)
 */
function bytesVramShare(bytes) {
	return bytes / 1e9 / FLEET_VRAM_GIB;
}

/**
 * "Small model" line: weights under a quarter of the card. The cheap-quant
 * cut reads it: below the line every quant is servable, so the cheapest ones
 * are noise in a catalog this size (docs/d200).
 * @type {number}
 */
const SMALL_MODEL_VRAM_SHARE = 0.25;

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
 * @param {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} manifests
 *   the run's manifest cache
 * @param {string} libDir this folder's own lib/
 * @param {string} repo "org/repo"
 * @returns {string|null} manifest path of the best projector, or null
 */
function repoMmproj(manifests, libDir, repo) {
	const candidates = repoManifest(manifests, libDir, repo)
		.files.map((f) => f.path)
		.filter((path) => /(^|\/)mmproj-.*\.gguf$/i.test(path));
	if (candidates.length === 0) {
		return null;
	}
	candidates.sort((a, b) => mmprojRank(a) - mmprojRank(b) || a.localeCompare(b));
	return candidates[0] ?? null;
}

/**
 * Index the image-token budget declared anywhere in this repo, so an entry
 * that gains vision by the projector fill inherits its family's budget
 * (gemma-4: 1120) instead of silently dropping to the generic default.
 * Returns the index; it is state of the RUN, created and passed by main.
 * @param {Record<string, any>[]} entries the RAW models array (the record of
 * every quant, so pruning cannot empty a repo of its declared pair)
 * @returns {Map<string, {min: number, max: number}>} repo -> budget
 */
function indexImageTokens(entries) {
	/** @type {Map<string, {min: number, max: number}>} */
	const imageTokens = new Map();
	for (const entry of entries) {
		const repo = entry["hf-repo"].split(":")[0];
		const min = entry["image-min-tokens"];
		const max = entry["image-max-tokens"];
		if (typeof min !== "number" || typeof max !== "number") {
			continue;
		}
		const seen = imageTokens.get(repo);
		if (seen && (seen.min !== min || seen.max !== max)) {
			logWarn("repo declares two image-token budgets — keeping the first", {
				repo,
				kept: seen,
				ignored: { min, max },
			});
			continue;
		}
		imageTokens.set(repo, { min, max });
	}
	return imageTokens;
}

/**
 * The shard paths an entry actually serves. Some upstreams upload the final
 * shard under another name (the DeepSeek Coder's Engram table is shard 6); the
 * committed manifest is still the authority, so ONE missing trailing shard
 * falls back to that repo's single Engram GGUF. The emitted --shard is already
 * a comma list of these paths (docs/d210), so no per-entry alias encoding or
 * cache symlink is involved (docs/d197).
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @param {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} manifests
 *   the run's manifest cache
 * @param {string} libDir this folder's own lib/
 * @returns {string[]} repo-relative shard paths in serving order
 */
function entryShards(m, manifests, libDir) {
	const repo = m["hf-repo"].split(":")[0];
	const shipped = repoManifest(manifests, libDir, repo).files.map((f) => f.path);
	const declared = allShards(m.model);
	if (declared.length < 2) {
		return declared;
	}
	const present = new Set(shipped);
	const missing = declared.filter((f) => !present.has(f));
	if (missing.length === 0) {
		return declared;
	}
	const last = declared.at(-1);
	if (missing.length !== 1 || missing[0] !== last || last === undefined) {
		throw new Error(
			`model ${m["hf-repo"]} is missing shards ${missing.join()} from its committed hf-manifest — the Engram fallback replaces one trailing shard only`,
		);
	}
	const engrams = shipped.filter((path) => {
		const base = path.split("/").pop() ?? "";
		return base.toLowerCase().includes("engram") && base.endsWith(".gguf");
	});
	const engram = engrams.at(0);
	if (engrams.length !== 1 || engram === undefined) {
		throw new Error(
			`model ${m["hf-repo"]} needs exactly one Engram GGUF in its hf-manifest to replace missing shard ${last} (found ${engrams.length})`,
		);
	}
	return [...declared.slice(0, -1), engram];
}

/**
 * Validate an entry against its committed manifest, then fill what the
 * manifest proves. A declared file the manifest does not carry is a HARD
 * ERROR — except for one trailing shard that entryShards resolves from the
 * repo's Engram GGUF: the manifest is committed truth, so any other miss is a
 * typo or a stale entry, never a host state (docs/d197).
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @param {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} manifests
 *   the run's manifest cache (main owns it)
 * @param {string} libDir this folder's own lib/
 * @param {Map<string, {min: number, max: number}>} imageTokens repo -> budget
 * @returns {void} mutates m: resolves `mmproj`, fills the image-token pair
 */
function resolveEntryFiles(m, manifests, libDir, imageTokens) {
	const repo = m["hf-repo"].split(":")[0];
	const shipped = new Set(
		repoManifest(manifests, libDir, repo).files.map((f) => f.path),
	);
	const declared = entryShards(m, manifests, libDir);
	const expected = allShards(m.model);
	if (declared.at(-1) !== expected.at(-1)) {
		logWarn("missing trailing shard replaced by the repo's Engram GGUF", {
			repo,
			missing: expected.at(-1),
			engram: declared.at(-1),
		});
	}
	if (m.mmproj) {
		declared.push(m.mmproj);
	}
	if (m["model-draft"]) {
		declared.push(m["model-draft"]);
	}
	for (const file of declared) {
		if (!shipped.has(file)) {
			throw new Error(
				`model ${m["hf-repo"]} declares ${file}, which its committed hf-manifest does not carry (re-run 10-fetch-hf-manifests.py, then fix the model entry)`,
			);
		}
	}

	const preferred = repoMmproj(manifests, libDir, repo);
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
		const tokens = imageTokens.get(repo);
		m["image-min-tokens"] ??= tokens?.min ?? IMAGE_TOKENS_DEFAULT;
		m["image-max-tokens"] ??= tokens?.max ?? IMAGE_TOKENS_DEFAULT;
	} else {
		delete m.mmproj;
	}
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
 * The tag a model entry serves, read from the file it points at and, failing
 * that, from the entry's `:quant` label. The label is not a second derivation of
 * the same fact: some repos upload full precision untagged (Spark's
 * `Spark-X2.6-4B.gguf`, which 10-fetch-hf-manifests.py reports as label-only), and
 * the label is the only place that survives. Reading the file first keeps the
 * label from overriding a name that disagrees (docs/d202).
 * @param {Record<string, any>} e one model entry
 * @returns {string|null}
 */
function entryFullPrecisionTag(e) {
	const label = e["hf-repo"].split(":")[1];
	return fullPrecisionTag(e.model) ?? (label ? fullPrecisionTag(label) : null);
}

/**
 * FULL-PRECISION entries (BF16, F16, F32) are hidden where the entry itself would
 * claim more than half the card: half the VRAM on weights alone leaves no room
 * for the KV cache the same model needs, so the variant can only ever bloat the
 * config. Measured on the entry's OWN bytes, never on a 2-byte-per-parameter
 * estimate — an F32 is twice that size — and never to the point of deleting a
 * repo that publishes nothing else: that repo keeps its smallest such entry.
 * Below the line a full-precision variant is genuinely useful and stays.
 * @type {number}
 */
const FULL_PRECISION_MAX_VRAM_SHARE = 0.5;

/**
 * The low-quant rule's two numbers. A small model (SMALL_MODEL_VRAM_SHARE) has
 * every quant servable, so its cheapest entries are noise in a catalog this size:
 * cut at most CHEAP_QUANT_DROP_MAX of them, and never below
 * CHEAP_QUANT_KEEP_MIN entries — a repo with few quants must keep a servable
 * ladder, so the floor counts entries, not dropped quants (docs/d200 made this
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
 * GGUF header truth for the files these entries serve, keyed by repo — a repo
 * whose served files disagree drops to a per-file map (`files`). Written by
 * `gguf_context_length.py --facts` from the cached GGUFs' own metadata, pruned
 * to configured files, normalized (sorted, integers, no timestamp) so a refresh
 * re-writes the same bytes. A hand value here would be a second home for a
 * header fact, which is how "marketing" 256K claims leaked into the manifest
 * (docs/d197).
 * @type {Record<string, Fact|{files: Record<string, Fact>}>}
 * @typedef {{arch?: string, "ctx-native"?: number}} Fact
 */
/**
 * @param {Record<string, Fact|{files: Record<string, Fact>}>} ggufFacts the
 *   committed GGUF header facts (read by main)
 * @param {Record<string, any>} m one manifest entry (with DEFAULTS applied)
 * @returns {number|null} this entry's file's header `context_length`, or null
 * when the facts file has nothing for it
 */
function factsCtxNative(ggufFacts, m) {
	const fact = ggufFacts[m["hf-repo"].split(":")[0]];
	const perFile = /** @type {any} */ (fact)?.files?.[m.model] ?? fact;
	return typeof perFile?.["ctx-native"] === "number" ? perFile["ctx-native"] : null;
}


/**
 * The committed hf-manifest for one repo — the ONE loader for every fact
 * generation takes from it: which files the repo ships (entry validation and
 * the projector choice), the total parameter count (d170's rule) and the
 * resolved commit (the bake fallback when the host cache lacks the entry).
 * Throws when the manifest is absent: a repo with no manifest is a model entry
 * whose files nothing can vouch for. The cache is the RUN's (main creates it),
 * so a second run never answers from a previous one.
 * @param {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} manifests
 *   the run's manifest cache
 * @param {string} libDir this folder's own lib/
 * @param {string} repo "org/repo"
 * @returns {{commit: string|null, files: Array<{path: string, size: number}>}}
 */
function repoManifest(manifests, libDir, repo) {
	const cached = manifests.get(repo);
	if (cached) {
		return cached;
	}
	const manifestPath = join(libDir, "hf-manifests", `${repo.replace("/", "--")}.json`);
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
		const manifest = {
			commit: typeof parsed.commit === "string" ? parsed.commit : null,
			files: parsed.files,
		};
		manifests.set(repo, manifest);
		return manifest;
	} catch (err) {
		throw new Error(
			"generation needs the committed hf-manifest for " + repo +
				" (" + manifestPath + "): " + /** @type {Error} */ (err).message,
		);
	}
}

/**
 * @param {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} manifests
 *   the run's manifest cache
 * @param {string} libDir this folder's own lib/
 * @param {string} repo "org/repo"
 * @returns {Map<string, number>} de-sharded main GGUF path -> bytes
 */
function repoGgufSizes(manifests, libDir, repo) {
	return mainGgufSizes(repoManifest(manifests, libDir, repo).files);
}

/**
 * Total parameter count, in billions, derived from a repo's main full-precision
 * GGUF bytes: FULL_PRECISION_BYTES_PER_PARAM turns the file size into the count,
 * so per-tag metadata needs no second source. Every tag yields the same count by
 * construction, so the first full-precision file a repo lists wins. Returns null
 * when the repo ships no such file. One fallback exists: repos that ship a bare
 * F16 build with no quant tag in the name (Spark's root upload) instead of an
 * F16-suffixed file — without it the small-model rules could not see them at
 * all. That proxy is the repo's LARGEST main GGUF and nothing else: full
 * precision is the biggest file a repo publishes, so a smaller untagged file is
 * an auxiliary, and the largest tagged file is a quant.
 * @param {Map<string, number>} sizes from mainGgufSizes
 * @returns {number|null}
 */
function totalParamsB(sizes) {
	// The heuristic every branch reads: a repo's full-precision upload is its
	// LARGEST main GGUF. 2 bytes per parameter is the lightest full precision
	// there is, so a smaller file is a quant, a side build, or an auxiliary — and
	// the three readings that need no name at all (totals, not guesses):
	//  - a `dflash`/`dspark`/MTP side build carries a full-precision tag but is
	//    never the biggest file, which is the guard the name filters cannot be;
	//  - an untagged auxiliary (a projector named "<model>-mmproj-bf16.gguf",
	//    which the `mmproj-` prefix exclusion misses) is never read as weights —
	//    one sized a 27B repo as 0B and cut its ladder (docs/d202). The named
	//    sidecars (`imatrix`, the n-gram/Engram table) never reach this loop at
	//    all: mainGgufSizes drops them, so their size cannot even be a candidate
	//    for "largest" (docs/d238);
	//  - the negated quant vocabulary below cannot be complete (it never named
	//    Q1_0), and it does not have to be: a 1-bit build is never the biggest
	//    file in its repo.
	const largest = Math.max(0, ...sizes.values());
	for (const [key, bytes] of sizes) {
		if (bytes !== largest) {
			continue;
		}
		const tag = fullPrecisionTag(key);
		const bytesPerParam =
			tag === null ? undefined : FULL_PRECISION_BYTES_PER_PARAM[tag];
		if (bytesPerParam !== undefined) {
			return bytes / bytesPerParam / 1e9;
		}
		// A bare F16 build with no quant tag in the name (Spark's root upload,
		// reported label-only by 10-fetch-hf-manifests.py): without it the small-model
		// rules could not see that repo at all. The name must still carry no tag,
		// or a full-precision spelling the endsWith test misses would be read as
		// 2-byte weights whatever it is.
		const base = (key.split("/").pop() ?? "").replace(/\.gguf$/i, "");
		if (FULL_PRECISION_NAME_RE.test(base)) { continue; }
		if (/[.-](UD-|IQ[1-4]_|Q[2-8]_|TQ[1-2]_|NVFP4|MXFP4|FP8)/i.test(base)) { continue; }
		return bytes / 2 / 1e9;
	}
	return null;
}

/**
 * The two quant-display rules, both stated as a share of the fleet card rather
 * than a parameter count, so one line reads the same on any card (docs/d199):
 *  - a full-precision ROW (BF16, F16, F32) whose own file claims more than
 *    FULL_PRECISION_MAX_VRAM_SHARE is hidden — but never the last entry a repo
 *    publishes, which keeps its smallest such entry (docs/d202);
 *  - a repo whose served weights claim less than SMALL_MODEL_VRAM_SHARE drops
 *    up to CHEAP_QUANT_DROP_MAX of its cheapest quants, but always keeps
 *    CHEAP_QUANT_KEEP_MIN entries, so a short quant list can never empty out.
 *
 * The size estimate is TOTAL parameters (not active): that is how many bytes a
 * full-precision copy has to hold somewhere. For a MoE it overstates the VRAM
 * penalty — a 35B-A3B streams from RAM with a 3B active slice, so it serves
 * fine on a card the estimate calls full — which is why the second rule keeps a
 * ladder rather than demanding every entry fit (docs/d202). Repos the manifests
 * cannot size keep every entry they publish: unsized keeps, never guesses.
 * Each decision is logged at INFO, not WARN: a healthy run makes a dozen of them,
 * and a warning band that is never empty is not a signal — the operator filters
 * `severityNumber >= 13` to find the states that need them (docs/d208).
 * @param {Record<string, any>[]} entries the flat models array (its objects are
 *   the model entries; nothing in this file is a tabular structure)
 * @param {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} manifests
 *   the run's manifest cache
 * @param {string} libDir this folder's own lib/
 * @param {{quiet?: boolean}} [options] quiet silences the INFO band for
 *   simulated candidates, whose decisions are not this run's decisions
 * @returns {Record<string, any>[]} entries to generate, same order
 */
function pruneQuantDisplay(entries, manifests, libDir, options = {}) {
	// Candidates are simulated entries, not this run's catalog: their decisions are
	// not decisions, so the caller silences the INFO band (docs/d208).
	const note = options.quiet ? () => undefined : logInfo;
	/** @type {Map<string, Record<string, any>[]>} */
	const byRepo = new Map();
	for (const e of entries) {
		const repo = e["hf-repo"].split(":")[0];
		if (!byRepo.has(repo)) { byRepo.set(repo, []); }
		byRepo.get(repo)?.push(e);
	}
	const keep = new Set(entries);
	for (const [repo, group] of byRepo) {
		const sizes = repoGgufSizes(manifests, libDir, repo);
		/** @type {(e: Record<string, any>) => number|undefined} */
		const entryBytes = (e) => sizes.get(e.model.replace(GGUF_SHARD_RE, ".gguf"));

		// Row-level, from the entry's OWN file: the tag set (f32/bf16/f16) and the
		// bytes/parameter of each live in FULL_PRECISION_BYTES_PER_PARAM, so an
		// F32 entry is judged at 4 bytes per parameter instead of passing as a
		// 2-byte copy — or surviving as an unknown tag. A entry the manifest cannot
		// size is kept: dropping it would be a guess.
		const tooBig = group.filter((e) => {
			const bytes = entryBytes(e);
			return (
				entryFullPrecisionTag(e) !== null &&
				bytes !== undefined &&
				bytesVramShare(bytes) > FULL_PRECISION_MAX_VRAM_SHARE
			);
		});
		// A repo that publishes NOTHING but full precision keeps its smallest
		// such entry: hiding all of them would delete the repo from the catalog
		// outright, and the floor is "one servable choice", the same floor
		// CHEAP_QUANT_KEEP_MIN states for the other rule.
		const hide =
			tooBig.length === group.length
				? [...tooBig]
						.sort(
							(a, b) =>
								(entryBytes(a) ?? Number.POSITIVE_INFINITY) -
								(entryBytes(b) ?? Number.POSITIVE_INFINITY),
						)
						.slice(1)
				: tooBig;
		if (hide.length !== tooBig.length) {
			note(
				"quant-display: repo publishes nothing but full precision — keeping its smallest entry",
				{ repo, kept: group.find((e) => !hide.includes(e))?.["hf-repo"] },
			);
		}
		for (const e of hide) {
			const bytes = entryBytes(e) ?? 0;
			keep.delete(e);
			note("quant-display: full-precision variant hidden (large model)", {
				repo,
				quant: e["hf-repo"].split(":")[1],
				sizeGB: Math.round(bytes / 1e8) / 10,
				cardShare: Math.round(bytesVramShare(bytes) * 100) / 100,
			});
		}

		const paramsB = totalParamsB(sizes);
		if (paramsB === null) {
			note("cheap-quant pruning skipped — no full-precision file sizes this repo", { repo });
			continue;
		}
		const roundB = Math.round(paramsB * 10) / 10;
		if (weightsVramShare(paramsB) < SMALL_MODEL_VRAM_SHARE) {
			const bySize = group
				.map((e) => ({ e, size: entryBytes(e) }))
				.sort((a, b) => (a.size ?? Number.POSITIVE_INFINITY) - (b.size ?? Number.POSITIVE_INFINITY));
			const dropCount = Math.min(
				CHEAP_QUANT_DROP_MAX,
				Math.max(0, bySize.length - CHEAP_QUANT_KEEP_MIN),
			);
			for (const { e } of bySize.slice(0, dropCount)) {
				keep.delete(e);
				note("quant-display: cheap quant dropped (small model)", {
					repo, quant: e["hf-repo"].split(":")[1], paramsB: roundB,
				});
			}
		}
	}
	return entries.filter((e) => keep.has(e));
}


// --- curation: scope + repo manifests -> curated model manifests (docs/d212) --
//
// The chain: lib/cache-scope.json (which repos this unit keeps) -> the repo
// manifests it names -> the model manifest's entries -> these curated files.
// A curated file is ONE repo's provisioning input: the entry labels it serves
// and every file they need, resolved from the committed repo manifest.
// 40-download-models.py reads these and nothing else, and config.d is rendered
// from the same in-memory set in the same run, so the two cannot disagree.
//
// WHY files and not a shared library: the provisioner is Python
// (huggingface_hub is the vetted client) and this generator is JS, so the
// interface is committed data — never a mode flag on either tool, and never a
/**
 * The modes a scope line may declare: served (has model entries, downloads its
 * files) or audit-only (verified if already cached, never downloaded).
 * @type {Set<string>}
 */
const SCOPE_MODES = new Set(["served", "audit-only"]);

/**
 * lib/cache-scope.json — the CLOSED inventory: every repo this unit keeps, in
 * exactly one mode. It is the only place in-scope can be stated, so the
 * manifest-refresh step reads it and nothing else, and the checks below make
 * the inventory and the model entries agree in BOTH directions (the pretend
 * scope this replaces was a list of exceptions to an implicit manifest).
 * @param {string} libDir this folder's own lib/
 * @returns {Map<string, string>} repo -> mode
 */
function readScope(libDir) {
	const path = join(libDir, "cache-scope.json");
	let text;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		// The read's errno answers the question the existence test used to ask,
		// and it can also say "unreadable", which the test reported as missing
		// (docs/d228).
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
			throw Object.assign(new Error("lib/cache-scope.json could not be read"), { path });
		}
		throw new Error(
			"lib/cache-scope.json is missing — it is the closed inventory of the repos this unit keeps",
		);
	}
	/** @type {Record<string, string>} */
	const declared = JSON.parse(text);
	for (const [repo, mode] of Object.entries(declared)) {
		if (!SCOPE_MODES.has(mode)) {
			throw new Error(
				`lib/cache-scope.json: ${repo} declares unknown mode ${JSON.stringify(mode)} (known: ${[
					...SCOPE_MODES,
				].join()})`,
			);
		}
	}
	return new Map(Object.entries(declared));
}

/**
 * The model manifest is AUTHORITATIVE about what is served: a repo with rows
 * is served, full stop. lib/cache-scope.json is the inventory — what gets
 * refreshed and audited — plus a keep-only declaration for repos that serve
 * nothing; it cannot veto an entry.
 *
 * WHY nothing here throws except an unknown mode: the scope is a generated
 * snapshot of a manifest that keeps moving (the first version made a stale
 * "served" line a hard error, so curating the manifest DOWN stopped
 * generation — the file outvoted the file it was derived from). Disagreement
 * is reported: the row edit is the decision, the scope line is bookkeeping
 * (docs/d212).
 * @param {Map<string, string>} scope repo -> mode
 * @param {Record<string, any>[]} rows the RAW models array
 * @returns {void}
 */
function validateScope(scope, rows) {
	/** @type {Map<string, number>} */
	const entriesPerRepo = new Map();
	for (const row of rows) {
		const repo = row["hf-repo"].split(":")[0];
		entriesPerRepo.set(repo, (entriesPerRepo.get(repo) ?? 0) + 1);
	}
	for (const repo of entriesPerRepo.keys()) {
		if (!scope.has(repo)) {
			logWarn(
				"the model manifest serves a repo with no cache-scope line — it will not be refreshed or verified",
				{ repo },
			);
		}
	}
	for (const [repo, mode] of scope) {
		const count = entriesPerRepo.get(repo) ?? 0;
		if (mode === "served" && count === 0) {
			logWarn(
				"cache-scope says served but the model manifest has no entries — nothing is curated for it",
				{ repo },
			);
		}
		if (mode === "audit-only" && count > 0) {
			logWarn(
				"cache-scope says audit-only but the model manifest serves it — the manifest wins",
				{ repo, entries: count },
			);
		}
	}
}

/**
 * Fold one entry's BAKED paths into its repo's curated record.
 *
 * WHY the baked paths and not the entry's own keys: they are exactly the files
 * config.d hands llama-server, so the provisioning list and the serving list are
 * ONE derivation. A curated file that re-derived the set from the row would be a
 * second source, and a projector is the case that bites — it is a repo fact
 * (resolveEntryFiles), never a model-manifest key, so an under-derived curated
 * file lets a pruner erase a projector the emitted config requires (docs/d218).
 * @param {Map<string, {entries: Set<string>, files: Set<string>, optional: Set<string>}>} curated
 * @param {Set<string>} shipped the repo's committed manifest paths
 * @param {Record<string, any>} m one entry (label + the split-index probe)
 * @param {{modelPath: string, shardPaths: string[], mmprojPath: string|null, draftPath: string|null}} baked
 * @returns {void}
 */
function noteCurated(curated, shipped, m, baked) {
	const repo = m["hf-repo"].split(":")[0];
	const head = `${HUB_GUEST}/models--${repo.split("/").join("--")}/snapshots/`;
	/** @param {string} guestPath @returns {string} repo-relative file name */
	const rel = (guestPath) =>
		guestPath.slice(head.length).split("/").slice(1).join("/");
	/** @type {string[]} */
	const bakedPaths = [baked.modelPath, ...baked.shardPaths];
	if (baked.mmprojPath) {
		bakedPaths.push(baked.mmprojPath);
	}
	if (baked.draftPath) {
		bakedPaths.push(baked.draftPath);
	}
	const rec = curated.get(repo) ?? { entries: new Set(), files: new Set(), optional: new Set() };
	rec.entries.add(m["hf-repo"]);
	for (const guestPath of bakedPaths) {
		rec.files.add(rel(guestPath));
	}
	const index = `${rel(baked.modelPath)}.index.json`;
	if (shipped.has(index)) {
		rec.optional.add(index);
	}
	curated.set(repo, rec);
}

/**
 * Write one curated manifest per served repo, and delete the ones whose repo
 * left the curated set — a stale file would keep a retired repo in the
 * provisioning loop, which a generated artifact must never do.
 * @param {string} curatedDir the curated-manifest directory
 * @param {Map<string, {entries: Set<string>, files: Set<string>, optional: Set<string>}>} curated
 * @param {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} manifests
 *   the run's manifest cache
 * @param {string} libDir this folder's own lib/
 * @returns {void}
 */
function writeCurated(curatedDir, curated, manifests, libDir) {
	mkdirSync(curatedDir, { recursive: true });
	const written = new Set();
	const ordered = [...curated.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	for (const [repo, rec] of ordered) {
		const manifest = repoManifest(manifests, libDir, repo);
		const sizes = new Map(manifest.files.map((f) => [f.path, f.size ?? 0]));
		const files = [...rec.files].sort();
		const name = `${repo.replace("/", "--")}.json`;
		writeJsonArtifact(join(curatedDir, name), {
			repo,
			manifestCommit: manifest.commit,
			entries: [...rec.entries].sort(),
			files,
			optional: [...rec.optional].sort(),
			bytes: files.reduce((sum, file) => sum + (sizes.get(file) ?? 0), 0),
		});
		written.add(name);
	}
	for (const name of readdirSync(curatedDir)) {
		if (name.endsWith(".json") && !written.has(name)) {
			rmSync(join(curatedDir, name));
			logInfo("curated manifest removed (repo no longer served)", { file: name });
		}
	}
}

/**
 * Generate the 10-local-llm-inference layer. Capability-gated by the CALLER
 * (container backend + GPU devices, in main) — LOCAL_INFERENCE=1 forces
 * generation for debug and this generator never re-checks viability.
 * @param {string} scriptDir this generator's own folder (its own lib/ carries
 *   the model manifest, manifests, GGUF facts and cache scope)
 * @param {string} hubHost the host HF hub cache root
 * @param {Record<string, Fact|{files: Record<string, Fact>}>} ggufFacts the
 *   committed GGUF header facts
 * @param {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} manifests
 *   the run's manifest cache (created by main, shared across this run)
 * @returns {void}
 */
function generateLocalInference(scriptDir, hubHost, ggufFacts, manifests) {
	const libDir = join(scriptDir, "lib");
	const configDir = join(scriptDir, "config.d");
	const curatedDir = join(libDir, "curated");
	// The model manifest lives in this folder's own lib/ (docs/d113: the copy
	// is owned here, not shared through a repo-level lib/).
	// before anything is baked: an invisible hub turns the verification off wholesale
	requireVisibleHub(hubHost);
	const modelData = JSON.parse(
		readFileSync(join(libDir, "llamacpp-model-data.json"), "utf-8"),
	);
	const imageTokens = indexImageTokens(modelData.models);
	const scope = readScope(libDir);
	validateScope(scope, modelData.models);
	const entries = pruneQuantDisplay(modelData.models, manifests, libDir);
	const curated = new Map();

	/** @type {Record<string, unknown>} */
	const models = {};
	for (const raw of entries) {
		const m = { ...DEFAULTS, ...raw };
		resolveEntryFiles(m, manifests, libDir, imageTokens);
		// The window is the GGUF header's `context_length`, capped by the fleet
		// ceiling; an entry may pin a LOWER value but never a higher one, because
		// the header is hardware truth and a pinned value above it is a claim the
		// model cannot serve (docs/d197). Absent facts means the model is newer
		// than the artifact: serve the conservative default and say so.
		const native = factsCtxNative(ggufFacts, m);
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
		 * One snapshot resolution per ENTRY:
		 * refs/main carries the model, its every shard, and the mmproj/drafter
		 * at the same commit, else the bake warns and names what provisioning owes.
		 */
		const baked = bakeSnapshotPaths(hubHost, m, manifests, libDir);
		const repo = m["hf-repo"].split(":")[0];
		noteCurated(
			curated,
			new Set(repoManifest(manifests, libDir, repo).files.map((f) => f.path)),
			m,
			baked,
		);
		// ONE mode per entry (docs/d220): a repo either ships a projector or it does
		// not, so vision is a fact of the manifest rather than a size-gated choice,
		// and the id carries no mode segment for a caller to pick between.
		const vision = baked.mmprojPath !== null;
		const modalities = vision ? ["text", "image"] : ["text"];
		/**
		 * The family macro reference (${qwen38} etc.) and any literal extra flags
		 * live in __argv verbatim; llama-swap expands ${...} at load. Empty __argv
		 * expands to nothing; shlex collapses the gap. The expanded
		 * ${LLAMA_SERVER} must be the FIRST cmd token: shlex argv[0] is the
		 * server binary llama-swap resolves on PATH and execs directly.
		 * @type {string}
		 */
		let cmd = LLAMA_SERVER_MACRO;
		// A text-only row names the one per-mode macro left (--no-mmproj): the
		// projector must not be required, and --ubatch-size/--no-mmproj-offload are
		// LLAMA_SERVER's now, so a vision row adds no macro at all.
		if (!vision) {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: llama-swap expands ${0text}, not JS.
			cmd += " ${0text}";
		}
		if (vision) {
			cmd += ` --image-min-tokens ${m["image-min-tokens"] ?? IMAGE_TOKENS_DEFAULT} --image-max-tokens ${m["image-max-tokens"] ?? IMAGE_TOKENS_DEFAULT}`;
		}
		if (m.__argv) {
			cmd += ` ${m.__argv}`;
		}
		// Keys are never quantized: the key cache is the KLD-bearing half of the
		// trade, so it stays at llama.cpp's f16 default with no flag at all.
		cmd += ` --cache-type-v ${m["cache-type-v"]}`;
		cmd += ` --ctx-size ${ctxSize} --n-predict ${nPredict}`;
		// The spec type is a per-ENTRY fact (docs/d206): a sidecar names its own
		// kind (`draft-mtp` for the MTP sidecars, `draft-dflash` for a dflash
		// one), and a model whose speculator is built into the weights carries
		// the type with no sidecar at all — llama.cpp then drafts against a
		// second context of the TARGET model. Emitted explicitly either way:
		// auto-inference only happened on the retired --hf-repo path.
		const speculates = baked.draftPath !== null || m["spec-type"];
		if (speculates) {
			cmd += ` --spec-type ${m["spec-type"] || DEFAULT_SPEC_TYPE}`;
			// The drafter's cache follows the entry's value quant (docs/d206): one
			// entry decides both contexts, and a entry left at f16 needs no flag
			// because llama.cpp's draft default is f16 too. Self-speculation gets
			// this as well — the draft context exists either way.
			if (m["cache-type-v"] !== "f16") {
				cmd += ` --spec-draft-type-v ${m["cache-type-v"]}`;
			}
		}
		if (![1, 2].includes(m.parallel)) {
			throw new Error(
				`model ${m["hf-repo"]} needs --parallel 1 or --parallel 2, got ${JSON.stringify(m.parallel)}`,
			);
		}
		cmd += ` --parallel ${m.parallel}`;
		// Baked snapshot paths last (the order the retired launch-gguf.sh
		// appended them in). A text-only row never passes --mmproj: the projector
		// must not be required for a mode that has none.
		cmd += ` --model ${baked.modelPath}`;
		if (baked.shardPaths.length > 0) {
			cmd += ` --shard ${baked.shardPaths.join(",")}`;
		}
		if (vision) {
			cmd += ` --mmproj ${baked.mmprojPath}`;
		}
		if (baked.draftPath) {
			cmd += ` --model-draft ${baked.draftPath}`;
		}

		// The id IS the manifest key (docs/d220): the mode segment left with the fan,
		// and d210 drops the quant label where a repo serves one row, so a caller's
		// id names the repo:quant its cache directory does.
		const id = m["hf-repo"];
		if (models[id]) {
			// A duplicate id is two entries claiming one serving slot: emitting
			// one and dropping the other silently removes a model from the
			// catalog, and the generated layer would no longer be a function of
			// the model manifest (d050). Stop and make the operator choose.
			throw new Error(
				`duplicate derived model id "${id}" — two entries serve the same repo:quant; fix lib/llamacpp-model-data.json`,
			);
		}
		// capabilities.context enriches llama-swap's served metadata with the
		// context window; the "metadata" key (exact name required by llama-swap)
		// mirrors a pi-coding-agent models.json provider.models[] entry
		// (reasoning / input / contextWindow / maxTokens).
		//
		// NO cost key, and that absence is deliberate: this farm bills nothing
		// per token, and a placeholder block is what once invalidated the whole
		// installed models.json (pi's schema requires all four price fields the
		// moment the key appears — docs/d057, coding-agent/tests/pi-cost.test.mjs).
		// A consumer therefore fills zeros on its side; do not reintroduce one
		// here to "complete" the metadata mirror.
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

	writeConfigD(configDir, "10-local-llm-inference.yaml", { models });
	writeCurated(curatedDir, curated, manifests, libDir);
	logInfo("curated manifests written", { dir: curatedDir, repos: curated.size });
}

// --- orchestration (folded from the former generate.sh) ---------------------

/**
 * THE entry point: reads the environment and argv, resolves every path and
 * fact source ONCE, and hands them to the layer generators. Nothing above
 * this function runs at import.
 * @returns {void}
 */
function main() {
	setLogTool("llm-local-inference/generate");
	// d215: no accepted arguments. Ignoring argv would run the full effect
	// anyway: a stray --help once provisioned the whole catalog.
	if (process.argv.length > 2) {
		throw failure("usage: 30-generate.mjs   # takes no arguments", 64);
	}

	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const libDir = join(scriptDir, "lib");
	const configDir = join(scriptDir, "config.d");
	const hubHost =
		process.env.HF_HUB_CACHE ??
		join(
			process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
			"huggingface",
			"hub",
		);
	const ggufFacts = JSON.parse(
		readFileSync(join(libDir, "gguf-facts.json"), "utf-8"),
	);
	/** @type {Map<string, {commit: string|null, files: Array<{path: string, size: number}>}>} */
	const manifests = new Map();

	// 1. general layer: always.
	generateGeneral(scriptDir, configDir);

	// 2. local-inference layer: capability-gated on being an INFERENCE ENDPOINT
	// (docs/d087): the container backend (the unified-vulkan image runs llama.cpp
	// against the GPU), at least one dedicated inference device, AND the RAM
	// floor — weights plus KV cache do not fit on a low-RAM host no matter what
	// accelerators it has. LOCAL_INFERENCE=1 forces the layer regardless
	// (debug: the generator still requires every configured GGUF in the host HF
	// cache — provision it with ./40-download-models.py first).
	// All probes/thresholds come from lib/host-capabilities.mjs — the SAME
	// definitions build.mjs gates its llama-swap pull on (the device probes port
	// workload-runtime.sh's detect_workload_tool/detect_gpu_devs), so this
	// layer's viability and the builder's target set cannot drift apart.
	const containerTool = detectContainerTool();
	const gpuDevices = detectGpuDevices();
	const hostRamGiB = totalMemGiB();
	const inferenceViable =
		containerTool !== null &&
		gpuDevices.length > 0 &&
		hostRamGiB >= INFERENCE_MIN_RAM_GIB;

	if (process.env.LOCAL_INFERENCE === "1" || inferenceViable) {
		generateLocalInference(scriptDir, hubHost, ggufFacts, manifests);
		// Stale resolver copies from pre-d029 generate.sh versions.
		rmSync(join(configDir, "launch-gguf.sh"), { force: true });
		logInfo("local-inference layer generated", {
			containerTool,
			gpuDevices: gpuDevices.length,
			ramGiB: hostRamGiB,
		});
	} else {
		rmSync(join(configDir, "10-local-llm-inference.yaml"), { force: true });
		rmSync(join(configDir, "10-local-llm-inference.paths"), { force: true });
		rmSync(join(configDir, "launch-gguf.sh"), { force: true });
		throw failure(
			"host is not an inference endpoint (no container backend, no inference devices, or RAM below the floor) — cannot serve local inference (LOCAL_INFERENCE=1 forces generation for debug)",
			94,
			{
				containerTool,
				gpuDevices: gpuDevices.length,
				ramGiB: hostRamGiB,
				minRamGiB: INFERENCE_MIN_RAM_GIB,
			},
		);
	}

	// --- verify + report -------------------------------------------------------
	logInfo("config.d ready", {
		dir: configDir,
		layers: readdirSync(configDir).filter((f) => {
			const st = statSync(join(configDir, f));
			return st.isFile();
		}),
	});
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		// One handler (docs/d225 R3): log once, set the status, return.
		const exitCode = exitCodeOf(error);
		if (exitCode === undefined) {
			logError("local-inference generation failed", {
				error: String(
					error instanceof Error ? (error.stack ?? error.message) : error,
				),
			});
			process.exitCode = 1;
		} else {
			// exitCodeOf only answers for this tree's own Error construct (d045).
			const failure = /** @type {{message: string, fields?: Record<string, unknown>}} */ (
				error
			);
			logError(failure.message, failure.fields ?? {});
			process.exitCode = exitCode;
		}
	}
}
