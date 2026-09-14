/**
 * @fileoverview generate-local-llm-models.yaml.mjs — Emit
 * config.d/10-local-llm-inference.yaml — the local llama.cpp GGUF `models` map —
 * plus the sibling 10-local-llm-inference.paths manifest (host-side paths the
 * run.sh staleness preflight re-checks). Built from
 * ../lib/llamacpp-model-data.json (the shared model-data table, docs/d025); no
 * network access. The `cmd` strings reference macros defined in 00-general.yaml
 * (${LLAMA_SERVER}, ${qwen36}, …) which llama-swap resolves after merging
 * config.d/.
 *
 * Generated ONLY on hosts where local inference is viable (container backend
 * + GPU devices detected by llm-local-inference/generate.sh); peers-only hosts
 * skip this layer and have no 10-local-llm-inference.yaml.
 *
 * GENERATION-TIME PATH BAKING (docs/d029 option B): every model is resolved to
 * ONE HF snapshot dir — the refs/main revision first (what
 * ../local-llm/download_models.py pins), falling back to any snapshot dir that
 * carries the entry — and the resolved paths are baked into the emitted `cmd`
 * as plain absolute args (`--model <path>`, `--mmproj`, `--model-draft`). No
 * shell runs at launch: llama-swap splits `cmd` with posix shlex and execs
 * argv directly (internal/config/commands.go SanitizeCommand), so the previous
 * config.d/launch-gguf.sh resolver is retired with this. HF paths contain no
 * spaces/quotes/metacharacters, so baking them into the shlex'd cmd is safe.
 *
 * A cache miss is a GENERATION error, not a launch-time download: model
 * provisioning belongs to ../local-llm/download_models.py and must not be
 * duplicated here — run that, then re-run ./generate.sh.
 *
 * STALENESS: a later download/prune cycle (upkeep.py) can re-point refs/main
 * or delete the generated snapshot; the .paths manifest lets run.sh fail
 * loudly with "re-run ./generate.sh" instead of a llama-server 127 at swap
 * time.
 *
 * Usage: node generate-local-llm-models.yaml.mjs
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logError, logWarn, writeArtifact, writeConfigD } from "./gen-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

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

function activeSlug(m) {
	for (const slice in activeB) {
		if (m["hf-repo"].indexOf(slice) !== -1) return activeB[slice];
	}
	return "99b";
}

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
function deriveModelId(m, modeSeg) {
	return `${activeSlug(m)}-ctx${ctxSlug(m["ctx-size"])}-${modeSeg ? `${modeSeg}-` : ""}${m["hf-repo"]}`;
}

function main() {
	// The shared model-data table lives in lib/ (moved there to mark it as
	// explicitly shared with local-llm/ tooling — docs/d025). Same LIB_DIR
	// convention as gen-lib.mjs.
	const libDir =
		process.env.LIB_DIR ?? fileURLToPath(new URL("../lib", import.meta.url));
	const modelData = JSON.parse(
		readFileSync(join(libDir, "llamacpp-model-data.json"), "utf-8"),
	);

	/** @type {Set<string>} host-side files to re-verify in run.sh's preflight */
	const bakedHostPaths = new Set();
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
		join(scriptDir, "config.d", "10-local-llm-inference.paths"),
		`${[...bakedHostPaths].sort().join("\n")}\n`,
	);
}

main();
