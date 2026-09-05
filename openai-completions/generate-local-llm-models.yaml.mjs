/**
 * @fileoverview generate-local-llm-models.yaml.mjs — Emit
 * config.d/10-local-llm-inference.yaml — the local llama.cpp GGUF `models` map. Built from
 * llamacpp-model-data.json; no network access. The `cmd` strings reference macros defined
 * in 00-general.yaml (${LLAMA_SERVER}, ${qwen36}, …) which llama-swap resolves after
 * merging config.d/.
 *
 * Generated ONLY on hosts where local inference is viable (container backend
 * + GPU devices detected by openai-completions/generate.sh); peers-only hosts
 * skip this layer and have no 10-local-llm-inference.yaml.
 *
 * GGUFs (and their mmproj projectors) are read straight from the HF hub cache,
 * mounted into the container at /home/ubuntu/.cache/huggingface/hub (see
 * openai-completions/run.sh); the generated cmd resolves the snapshot
 * dir at launch via config.d/launch-gguf.sh (mounted ro alongside the yaml),
 * so there is no runtime --hf-repo download and no models-local/ pre-cache
 * step.
 *
 * Usage: node generate-local-llm-models.yaml.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logWarn, writeConfigD } from "./gen-lib.mjs";

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

// Implicit manifest defaults: entries in llamacpp-model-data.json may omit
// these keys and the generator fills them in.  Only deviations (e.g. a
// --parallel 2 model or a non-65536 context) need to be written out.
const DEFAULTS = {
	"cache-type-k": "f16",
	"cache-type-v": "f16",
	"ctx-size": 65536,
	parallel: 1,
};

// Speculative decoding strategy used when an entry carries a "model-draft"
// drafter GGUF (unsloth ships MTP sidecars under the repo's MTP/ subdir).
// --model-draft ALONE is a no-op for speculation when the target model is a
// local path: the server only auto-infers the spec type on the --hf-repo
// download path, so --spec-type must be emitted explicitly (and a bare
// --model-draft would still load the drafter into VRAM, wasted).
const DEFAULT_SPEC_TYPE = "draft-mtp";

// The in-container HF hub cache path (/home/ubuntu/.cache/huggingface/hub,
// mounted by openai-completions/run.sh; differs from the host's
// /home/dev/.cache/...) is hardcoded in config.d/launch-gguf.sh, which does
// the snapshot resolution.

// Resolve a model (and, for multimodal models, its projector) at launch to
// paths drawn from ONE HF snapshot dir, so the exact same commit backs both
// --model and --mmproj (a quant/projector mismatch would corrupt vision
// requests).  This CANNOT be inline shell in the cmd string: llama-swap splits
// `cmd` with posix shlex and execs argv[0] directly — no shell runs — and a
// `sh -c '...'` wrapper breaks on the single quotes inside the sampling macros
// (--chat-template-kwargs '{...}').  config.d/launch-gguf.sh therefore does the
// dynamic resolution: it picks the first models--<org>--<repo>/snapshots/<hash>
// dir containing the GGUF (and the projector, when present), aborting the
// launch if none does, normalizes sharded GGUFs to their 00001 shard (llama.cpp
// auto-loads sibling shards), appends --model/--mmproj after the caller's flags
// and execs.  The emitted cmd is plain argv: sh <launcher> <args> -- ${macros}.
const LAUNCHER = "/etc/llama-swap/config.d/launch-gguf.sh";

function cacheResolver(m) {
	const repo = m["hf-repo"].split(":")[0]; // drop :revision; the GGUF filename already pins the quant
	const repoDir = `models--${repo.split("/").join("--")}`;
	// repo-id is passed separately (reversing models--<org>--<repo> is ambiguous
	// when the org itself contains dashes) for launch-gguf.sh's --hf-repo
	// download fallback.  The launcher args below carry ${…} macros that
	// llama-swap expands, not JS (see LLAMA_SERVER_MACRO).
	// The 5th launcher arg is the drafter GGUF ("-" when absent); the launcher
	// requires it in the SAME snapshot and appends --model-draft itself.
	return {
		launcherArgs: `sh ${LAUNCHER} ${repoDir} ${repo} ${m.model} ${m.mmproj || "-"} ${m["model-draft"] || "-"} --`,
	};
}

// Per-model I/O modalities: vision models (mmproj present) also accept images.
function inputModalities(m) {
	return m.mmproj ? ["text", "image"] : ["text"];
}

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
// kv-quant segment appears in the id anymore — just the active slug, the context
// window, and the (unique) hf-repo.
function deriveModelId(m) {
	return `${activeSlug(m)}-ctx${ctxSlug(m["ctx-size"])}-${m["hf-repo"]}`;
}

function main() {
	const modelData = JSON.parse(
		readFileSync(join(scriptDir, "llamacpp-model-data.json"), "utf-8"),
	);

	const models = {};
	for (const raw of modelData.models) {
		const m = { ...DEFAULTS, ...raw }; // explicit keys win over the defaults
		const ctxSize = m["ctx-size"]; // AUTHORITATIVE --ctx-size (not --fit-ctx)
		const modalities = inputModalities(m);
		const nPredict = ctxSize; // --n-predict mirrors the context window
		// The family macro reference (${qwen38} etc.) and any literal extra flags
		// live in __argv verbatim; llama-swap expands ${...} at load.  Empty __argv
		// expands to nothing; shlex collapses the gap.
		// launch-gguf.sh resolves --model/--mmproj from one HF snapshot dir and
		// fails loudly if uncached or not co-located in the same snapshot.  The
		// expanded ${LLAMA_SERVER} must directly follow the `--` separator: its
		// first token ("llama-server") becomes the launcher's server binary, which
		// it resolves via PATH + common install dirs before exec'ing.
		const r = cacheResolver(m);
		let cmd = `${r.launcherArgs} ${LLAMA_SERVER_MACRO}`;
		if (m["__argv"]) cmd += ` ${m["__argv"]}`;
		cmd += ` --cache-type-k ${m["cache-type-k"]} --cache-type-v ${m["cache-type-v"]}`;
		cmd += ` --ctx-size ${ctxSize} --n-predict ${nPredict}`;
		if (m["model-draft"]) {
			// explicit: auto-inference only happens on the --hf-repo path, never for
			// local snapshot paths (see DEFAULT_SPEC_TYPE note above)
			cmd += ` --spec-type ${m["spec-type"] || DEFAULT_SPEC_TYPE}`;
		}
		if (![1, 2].includes(m.parallel)) {
			throw new Error(
				`model ${m["hf-repo"]} needs --parallel 1 or --parallel 2, got ${JSON.stringify(m.parallel)}`,
			);
		}
		cmd += ` --parallel ${m.parallel}`;

		const id = deriveModelId(m);
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

	writeConfigD("10-local-llm-inference.yaml", { models });
}

main();
