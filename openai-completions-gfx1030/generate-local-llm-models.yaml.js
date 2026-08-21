// Emit config.d/10-local-llm-inference.yaml — the local llama.cpp GGUF
// `models` map.  Built from llamacpp-model-data.json; no network access.  The
// `cmd` strings reference macros defined in 00-general.yaml (${LLAMA_SERVER},
// ${qwen36}, ${k80v80}, …) which llama-swap resolves after merging config.d/.
//
// Full-host serving only (gfx1030): peers-only hosts skip this generator and
// have no 10-local-llm-inference.yaml.
//
// llama-server resolves and caches GGUFs from the HF repo at runtime; the
// cache is mounted into the container at /home/ubuntu/.cache/huggingface/hub
// (see openai-completions-gfx1030/run.sh).  No models-local/ layout or
// pre-cache step is used.
//
// Usage: node generate-local-llm-models.yaml.js

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";
import { loadCore, writeConfigD } from "./gen-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// The HF cache is mounted into the llama-swap container at
// /home/ubuntu/.cache/huggingface/hub (see openai-completions-gfx1030/run.sh).
// There is no flat models-local/ layout; llama-server resolves and caches the
// requested GGUF (and its mmproj) from the HF repo at runtime.
function modelArgs({ repo, file }) {
  return ` --hf-repo ${repo} --hf-file ${file}`;
}

const textCapabilities = {
  in: ["text"],
  out: ["text"],
};

const visionCapabilities = {
  in: ["text", "image"],
  out: ["text"],
};

const quantToBits = {
  F32: "32q00", F16: "16q00",
  Q4_0: "04q50", Q4_1: "05q00", Q5_0: "05q50", Q5_1: "06q00",
  Q8_0: "08q50", Q8_1: "09q00",
  Q2_K: "02q62", Q3_K: "03q44", Q4_K: "04q50", Q5_K: "05q50",
  Q6_K: "06q56", Q8_K: "09q12",
  IQ2_XXS: "02q12", IQ2_XS: "02q62", IQ3_XXS: "03q44", IQ1_S: "01q56",
  IQ4_NL: "04q50", IQ3_S: "04q19", IQ2_S: "03q69", IQ4_XS: "02q81",
  IQ1_M: "01q81", BF16: "16q00", TQ1_0: "01q06", TQ2_0: "02q06",
};

const activeB = {
  "Ling-3.0-tiny": "01b", "GLM-4.7-Flash": "03b", "Laguna-XS-2.1": "03b",
  "Qwen3.6-35B-A3B": "03b", "gemma-4-26B-A4B": "04b", "gemma-4-12b": "12b",
  "gemma-4-12B": "12b", "Devstral-Small-2-24B": "24b", "Qwen3.6-27B": "27b",
  "Qwen3.8-27B": "27b", "Muse-Glimmer-30B": "30b", "gemma-4-31B": "31b",
};

function activeSlug(m) {
  for (const slice in activeB) {
    if (m.repo.indexOf(slice) !== -1) return activeB[slice];
  }
  return "99b";
}

function quantSlug(quant) {
  if (!quant.startsWith("UD-")) return `GG-${quant}`;
  return quant;
}

function ctxSlug(contextWindow) {
  if (contextWindow % 1024 === 0) {
    return String(contextWindow / 1024).padStart(3, "0");
  }
  return String(Math.round(contextWindow / 1000)).padStart(3, "0");
}

function deriveModelId(m) {
  return `${activeSlug(m)}-${quantSlug(m.quant)}-${m.cacheType}-ctx${ctxSlug(m.maxDesiredContext)}-${m.repo}:${m.quant}`;
}

function main() {
  const core = loadCore();
  const macroNames = new Set(Object.keys(core.macros || {}));

  const modelData = JSON.parse(
    readFileSync(join(scriptDir, "llamacpp-model-data.json"), "utf-8"),
  );

  const models = {};
  for (const m of modelData.models) {
    for (const key of ["macros", "cacheType"]) {
      if (m[key] && !macroNames.has(m[key])) {
        throw new Error(
          `model ${m.repo} (${m.quant}) references undefined ${key} macro "${m[key]}"`,
        );
      }
    }
    // Empty family macros expand to nothing; shlex collapses the gap.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded at llama-swap level
    let cmd = "${LLAMA_SERVER}";
    if (m.macros) cmd += ` \${${m.macros}}`;
    if (m.cacheType) cmd += ` \${${m.cacheType}}`;
    cmd += ` --fit-ctx ${m.maxDesiredContext}`;
    if (![1, 2].includes(m.parallel)) {
      throw new Error(
        `model ${m.repo} (${m.quant}) needs --parallel 1 or --parallel 2, got ${JSON.stringify(m.parallel)}`,
      );
    }
    cmd += ` --parallel ${m.parallel}`;
    if (m.extraArgs) cmd += ` ${m.extraArgs}`;
    cmd += modelArgs({ repo: `${m.repo}:${m.quant}`, file: m.file, });

    const id = deriveModelId(m);
    if (models[id]) {
      console.warn(`  warning: duplicate derived model id "${id}" (${m.repo}) — skipping`);
      continue;
    }
    models[id] = { cmd, capabilities: m.mmproj ? visionCapabilities : textCapabilities };
  }

  writeConfigD("10-local-llm-inference.yaml", { models });
}

main();
