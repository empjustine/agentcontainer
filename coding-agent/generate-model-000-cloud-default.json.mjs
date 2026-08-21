// Emit the pi overlay `model-000-cloud-default.json`.  This layer is a no-op:
// for cloud providers all configuration lives in environment variables /
// auth.json (pi auto-detects them), so the overlay carries no providers.  It
// exists only to keep the layer set homogeneous with peer/local overlays.
// Model layers are named model-<lexorank>-<environ>-<uniquename>.json and are
// collected+sorted at merge time (see docs/models-layered-cake.md).
//
// Usage: node generate-model-000-cloud-default.json.mjs [out]
//   out defaults to $PI_MODELS_JSON else ./model-000-cloud-default.json.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

function main() {
  const out = process.argv[2] ?? process.env.PI_MODELS_JSON ?? join(scriptDir, "model-000-cloud-default.json");
  writeFileSync(out, "{}\n");
  console.warn(`  wrote ${out} (cloud overlay: empty)`);
}

main();
