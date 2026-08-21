// Emit config.d/21-peer-opencode.yaml — `peers.opencode` + `peers.opencode-go`.
// Both share OPENCODE_API_KEY, so one generator writes them into a single file
// (docs/d018).  Owns nothing else.
//
// Usage: node generate-peer-opencode.yaml.js
//   Setting OPENCODE_API_KEY makes the peer entries carry an
//   ${env.OPENCODE_API_KEY} apiKey reference; without it the keys are omitted.

import { PROVIDERS, fetchPeerModels, peerEntry, writeConfigD } from "./gen-lib.mjs";

async function main() {
  const peers = {};
  for (const id of ["opencode", "opencode-go"]) {
    const p = PROVIDERS[id];
    const models = await fetchPeerModels(p);
    if (models && models.length > 0) peers[id] = peerEntry(p, models);
  }
  if (Object.keys(peers).length === 0) {
    console.warn("  note: no OpenCode (Zen/Go) models — skipping peer file");
    return;
  }
  writeConfigD("21-peer-opencode.yaml", { peers });
}

await main();
