// Emit config.d/20-peer-openrouter.yaml — the `peers.openrouter` key, and
// nothing else, so it merges cleanly with the other split files (docs/d018).
//
// Usage: node generate-peer-openrouter.yaml.js
//   Setting OPENROUTER_API_KEY makes the peer carry an ${env.OPENROUTER_API_KEY}
//   apiKey reference; without it the key is omitted.

import { PROVIDERS, fetchPeerModels, peerEntry, writeConfigD } from "./gen-lib.mjs";

async function main() {
  const p = PROVIDERS.openrouter;
  const models = await fetchPeerModels(p);
  if (!models || models.length === 0) {
    console.warn(`  note: no OpenRouter models — skipping ${p.id} peer file`);
    return;
  }
  writeConfigD("20-peer-openrouter.yaml", { peers: { [p.id]: peerEntry(p, models) } });
}

await main();
