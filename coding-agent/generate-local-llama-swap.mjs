/**
 * @fileoverview generate-local-llama-swap.mjs — Emit the pi overlay
 * `model-010-local-default.json`: the `llama-swap` provider for every local
 * GGUF model a reachable llama-swap instance serves (pi has no built-in
 * llama-swap provider, so this layer ADDS one; docs/d024).
 *
 * Detection cascade, reachability rule and emitted wrapper shape: docs/d033.
 * Merge contract: merge-models-json.mjs. Probe toolkit: lib/peer-probe.mjs.
 * The per-model metadata fallback (`meta.llamaswap` → OpenAI-ish fields) lives
 * in lib/pi-models.mjs.
 *
 * Usage: node generate-local-llama-swap.mjs [out]
 *   out defaults to $PI_MODELS_JSON else ./model-010-local-default.json.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Shared lib/ helpers (docs/d023): structured logger, artifact writer, HTTP
// probe toolkit, pi model shaping — via the LIB_DIR convention.
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
const { peerBaseUrl, peerProviderUrl, probeCandidates } =
	/** @type {typeof import("../lib/peer-probe.mjs")} */ (
		await import(`${LIB_DIR}/peer-probe.mjs`)
	);
const { piModel, providerEntry } =
	/** @type {typeof import("../lib/pi-models.mjs")} */ (
		await import(`${LIB_DIR}/pi-models.mjs`)
	);
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
	/** @type {Record<string, import("../lib/pi-models.mjs").PiProvider>} */
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
