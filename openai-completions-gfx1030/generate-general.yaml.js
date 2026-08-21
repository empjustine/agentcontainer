// Emit config.d/00-general.yaml — global settings, `macros`, `ctxWindows` —
// as a straight conversion of llama-swap-core.json (no network).  Per the
// merge contract (docs/d018) this is the ONLY file allowed to define scalars /
// macros / ctxWindows / apiKeys; model and peer generators must not redefine
// any of those.
//
// Usage: node generate-general.yaml.js

import { loadCore, writeConfigD } from "./gen-lib.mjs";

function main() {
  const core = loadCore();
  // models/peers belong to their own dedicated generators.
  delete core.models;
  delete core.peers;
  writeConfigD("00-general.yaml", core);
}

main();
