// Merge the layered pi model files into one models.json.
// Order: base (00-model-base.json, or {} if absent) then every model-*.json
// (model-<lexorank>-<environ>-<uniquename>.json) in lexical order — the
// zero-padded lexorank makes filename sort equal to merge order.  Each layer
// merges on top of the previous.  Providers deep-merge per id; within a
// provider, objects merge and scalar / array fields are replaced by the later
// layer.  See docs/models-layered-cake.md.
//
// Usage: node merge-models-json.js [out]
//   out defaults to $PI_MODELS_JSON else ./models.json.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = deepMerge(out[key], value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`failed to parse ${path}: ${error.message}`);
  }
}

function main() {
  const basePath = join(scriptDir, "00-model-base.json");
  const base = existsSync(basePath) ? readJson(basePath) : {};
  const overlayNames = readdirSync(scriptDir)
    .filter((name) => /^model-.*\.json$/.test(name))
    .sort();
  const layers = [base, ...overlayNames.map((name) => readJson(join(scriptDir, name)))];
  const out = process.argv[2] ?? process.env.PI_MODELS_JSON ?? join(scriptDir, "models.json");
  writeFileSync(out, `${JSON.stringify(deepMerge(...layers), null, 2)}\n`);
  console.warn(`  merged ${overlayNames.length} overlay(s) -> ${out}`);
}

main();
