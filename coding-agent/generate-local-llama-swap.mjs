/**
 * @fileoverview generate-local-llama-swap.mjs — Emit the pi overlay
 * `model-010-local-default.json`: the `llama-swap` provider for every local
 * GGUF model a reachable llama-swap instance serves (pi has no built-in
 * llama-swap provider, so this layer ADDS one; docs/d024).
 *
 * Detection cascade, reachability rule and emitted wrapper shape: docs/d033.
 * Merge contract: merge-models-json.mjs. Probe toolkit: peer-probe.mjs (coding-agent/).
 * The per-model metadata fallback (`meta.llamaswap` → OpenAI-ish fields) lives
 * in gen-lib.mjs (folded from the former lib/pi-models.mjs).
 *
 * Usage: node generate-local-llama-swap.mjs [out]
 *   out defaults to $PI_MODELS_JSON else ./model-010-local-default.json.
 */

import { join } from "node:path";

import {
	logInfo,
	logWarn,
	peerBaseUrl,
	peerProviderUrl,
	piModel,
	probeCandidates,
	providerEntry,
	scriptDir,
	setLogTool,
	writeArtifact,
} from "./gen-lib.mjs";

setLogTool("coding-agent/generate-local-llama-swap");

// The peer's funnel base URL — vault-sourced (peerBaseUrl(); see the
// header there). No localhost candidates are probed — the LAN :8080 (proxy)
// and :8101 (llama-swap) listen addresses are not routable from outside the
// host they serve (docs/d022).
const LOCAL_SOURCE_CANDIDATES = [peerProviderUrl(peerBaseUrl(), "llama-swap")];

/** @returns {Promise<void>} */
async function main() {
	const out =
		process.argv[2] ??
		process.env.PI_MODELS_JSON ??
		join(scriptDir, "model-010-local-default.json");

	const local = await probeCandidates(LOCAL_SOURCE_CANDIDATES, (ids) =>
		ids.some((id) => id.includes("-GGUF")),
	);
	/** @type {Record<string, import("./gen-lib.mjs").PiProvider>} */
	const providers = {};
	if (local) {
		const gguf = local.entries.filter((e) => e.id.includes("-GGUF"));
		providers["llama-swap"] = providerEntry(local.baseUrl, gguf.map(piModel));
	} else {
		logInfo("no local GGUF source reachable — omitting llama-swap provider");
	}

	if (Object.keys(providers).length === 0) {
		logWarn("nothing usable detected — output left untouched", { out });
		return;
	}

	const written = writeArtifact(
		out,
		`${JSON.stringify({ providers }, null, 2)}\n`,
	);
	const summary = Object.entries(providers)
		.map(([id, p]) => `${id}=${p.baseUrl}(${p.models.length})`)
		.join(", ");
	logInfo("wrote models layer", { path: written, providers: summary });
}

await main();
