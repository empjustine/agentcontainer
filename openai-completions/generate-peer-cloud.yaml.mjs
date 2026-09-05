/**
 * @fileoverview generate-peer-cloud.yaml.mjs — Emit config.d/peer-cloud.yaml — one
 * cloud-provider peer per entry in gen-lib's PROVIDERS map (which IS the provider list;
 * adding a provider there is the only change needed). Model-id sources per PROVIDERS flag:
 * - `modelsDev` (opencode, opencode-go): the vendored models.dev catalog, ALL models
 * enumerated unfiltered — the endpoint's own /models listing proved unreliable for
 * tier/availability, and filtering here silently hid models; access is decided at request
 * time by the peer's key. - otherwise (openrouter): the provider's live /models, filtered.
 * One generator per concern-family (cloud peers), one output file; each peer is
 * fetched/skipped independently so a single provider outage or missing key never blanks
 * the others (docs/d018). When no provider answers, a STALE peer-cloud.yaml from an
 * earlier run is removed, so config.d/ only carries layers that work in the current
 * environment.
 *
 * Usage: node generate-peer-cloud.yaml.mjs
 *   Setting OPENROUTER_API_KEY / OPENCODE_API_KEY / CLINE_API_KEY makes the
 *   corresponding peer entries carry ${env.*} apiKey references; without
 *   them the keys are omitted.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	fetchPeerModels,
	logInfo,
	PROVIDERS,
	peerEntry,
	scriptDir,
	writeConfigD,
} from "./gen-lib.mjs";

const OUTPUT_NAME = "peer-cloud.yaml";

async function main() {
	const peers = {};
	for (const p of Object.values(PROVIDERS)) {
		const models = await fetchPeerModels(p);
		if (models && models.length > 0) peers[p.id] = peerEntry(p, models);
	}
	if (Object.keys(peers).length === 0) {
		// Drop a stale output from a previous, cloud-capable run so llama-swap
		// never loads unreachable peers (config.d/ mirrors current reality).
		rmSync(join(scriptDir, "config.d", OUTPUT_NAME), { force: true });
		logInfo("no cloud provider models — skipping peer file");
		return;
	}
	writeConfigD(OUTPUT_NAME, { peers });
}

await main();
