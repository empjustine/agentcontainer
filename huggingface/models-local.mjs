// Resolve llama-server model args against the HF flat-model cache.
//
// Centralized in huggingface/ so the cache-layout knowledge lives with the
// cache tooling (precache.sh, docs/d016) instead of in the config generator.
// Consumed by coding-agent/provider-models/generate-pi-models.js.
//
// See huggingface/docs/d016-flat-model-inside-hf-cache.md for why the flat
// files live at <hf-cache>/hub/models-local/<repo>/<file>.

import { existsSync } from "node:fs";
import { join } from "node:path";

// Path as seen inside the llama-swap container (the HF cache tree is
// mounted read-write at this location; see openai-completions/run.sh).
const CONTAINER_MODELS_LOCAL = "/root/.cache/huggingface/hub/models-local";

/**
 * Returns the llama-server cmd fragment for one model:
 *   --model <flat> [--mmproj <flat>]   when the file is already cached
 *   --hf-repo <repo> --hf-file <file>  otherwise (llama-server downloads)
 *
 * @param {object} m  { repo, file, mmproj } from llamacpp-model-data.json
 * @param {string} home  host home dir (host-side models-local/ lookup)
 */
export function modelArgs({ repo, file, mmproj, home }) {
  const repoDir = repo.split(":")[0];
  const hostModelsLocal = join(home, ".cache", "huggingface", "hub", "models-local");

  // Use --model (fast — no HF metadata resolution) when the flat-model
  // file already exists in models-local/.  Otherwise fall back to
  // --hf-repo/--hf-file (slower — llama-server fetches metadata).
  if (existsSync(join(hostModelsLocal, repoDir, file))) {
    let args = ` --model ${CONTAINER_MODELS_LOCAL}/${repoDir}/${file}`;
    if (mmproj && existsSync(join(hostModelsLocal, repoDir, mmproj))) {
      args += ` --mmproj ${CONTAINER_MODELS_LOCAL}/${repoDir}/${mmproj}`;
    }
    return args;
  }

  // Fall back to HF repo download — llama-server resolves the file and any
  // companion mmproj from the HF repo automatically.
  return ` --hf-repo ${repo} --hf-file ${file}`;
}
