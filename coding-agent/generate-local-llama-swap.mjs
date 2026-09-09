/**
 * @fileoverview generate-local-llama-swap.mjs — Emit the pi overlay
 * `model-010-local-default.json`: the LOCAL half of the layered models.json (the layer
 * contract — naming, order, merge semantics — lives in merge-models-json.mjs), carrying
 * the `llama-swap` provider for every local GGUF model a reachable llama-swap instance
 * serves.
 *
 * This is the local cascade of the former catch-all `generate-models.json.mjs`,
 * split out so each file has one merge semantic (docs/d022, applied in docs/d024):
 * this layer is a pi-shaped *addition* (pi has no built-in llama-swap provider);
 * the pi-native cloud overrides live in
 * `generate-cloud-pi-native-providers.mjs` (layer `model-012-...`), the
 * authoritative non-native cloud provider in
 * `generate-cloud-alternative-providers.mjs` (layer `model-015-...`).
 *
 * Detection cascade:
 *
 *   1. Local inference (provider id `llama-swap`): probe the multipurpose
 *      llama-swap instance — $PEER_BASE_URL, then the shared fallback FQDN
 *      (lib/peer-probe.mjs DEFAULT_PEER_FALLBACK — the world-visible FQDN
 *      funnel that reverse-proxies the LAN :8080 instance, so it serves the
 *      identical catalog).  First candidate serving GGUF models wins; its
 *      model catalog becomes the `llama-swap` provider (pi-shaped metadata
 *      mirrored from meta.llamaswap).  No localhost candidates are probed:
 *      the LAN :8080 instance is only ever a *local* listen address and the
 *      legacy :18080 local-inference port is DEPRECATED, so a co-located peer
 *      is reached via $PEER_BASE_URL or the fallback FQDN instead.
 *
 * "Reachable" is about the NETWORK PATH, not about credentials: a 401/403 is
 * what an OpenAI-compatible endpoint returns to any unauthenticated request,
 * and this generator legitimately runs without provider keys (pi resolves its
 * own key / OAuth login at request time). Same rule as the cloud generators —
 * the canonical wording lives in lib/peer-probe.mjs's header.
 *
 * Emitted layer:
 *
 * - `baseUrl` is a LITERAL url resolved at generation time (pi does not expand
 *   ${vars} in baseUrl) and is normalized to `/v1`; `api` is
 *   `openai-completions` (both from lib/pi-models.mjs providerEntry).
 * - `models` are full pi-shaped entries, deduplicated by id, order preserved,
 *   and ALL are listed — both `loaded` and `unloaded` — because llama-swap
 *   swaps models in/out on demand (unlike pi's built-in llama.cpp provider,
 *   which lists only `status: loaded`).
 * - Per-model metadata mirrors what llama-swap publishes upstream: it serves
 *   each config.d/ entry's `metadata` block on `/v1/models` under
 *   `meta.llamaswap`, which is already pi-shaped, so it is copied field by
 *   field (`reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`). Older
 *   builds without that block fall back to the OpenAI-ish top-level fields
 *   (`context_length`, `architecture.input_modalities`,
 *   `capabilities.vision`). `name` is derived from the model id
 *   (`<repo-basename> <quant>`) purely for display.
 * - If nothing usable is detected, nothing is written and any existing layer is
 *   left untouched.
 *
 * Usage: node generate-local-llama-swap.mjs [out]
 *   out defaults to $PI_MODELS_JSON else ./model-010-local-default.json.
 *   Env: PEER_BASE_URL (first probe candidate), PEER_API_KEY (peer bearer).
 *   Typical run, then merge — see merge-models-json.mjs:
 *     node generate-local-llama-swap.mjs        # -> model-010-local-default.json
 *     node generate-cloud-pi-native-providers.mjs
 *     node merge-models-json.mjs                # -> models.json
 */

import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Shared lib/ helpers (docs/d023): the structured logger, the HTTP probe
// toolkit and the pi model shaping, resolved through the LIB_DIR convention
// (generate.sh stages them into the scratch dir and points LIB_DIR there;
// manual in-place runs fall back to the sibling ../lib).
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { DEFAULT_PEER_FALLBACK, probeCandidates } =
	/** @type {typeof import("../lib/peer-probe.mjs")} */ (
		await import(`${LIB_DIR}/peer-probe.mjs`)
	);
const { piModel, providerEntry } =
	/** @type {typeof import("../lib/pi-models.mjs")} */ (
		await import(`${LIB_DIR}/pi-models.mjs`)
	);
setLogTool("coding-agent/generate-local-llama-swap");

// Ordered best-first: explicit override, then the remote tailscale proxy.
// No localhost candidates are probed — the LAN :8080 listen address and the
// deprecated :18080 local-inference port are not routable from outside the
// host they serve (docs/d022; see DEFAULT_PEER_FALLBACK).
const LOCAL_SOURCE_CANDIDATES = /** @type {string[]} */ (
	[
		process.env.PEER_BASE_URL?.replace(/\/+$/, ""),
		DEFAULT_PEER_FALLBACK,
	].filter(Boolean)
);

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

	const tmp = `${out}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ providers }, null, 2)}\n`);
	renameSync(tmp, out); // atomic on the same filesystem
	const summary = Object.entries(providers)
		.map(([id, p]) => `${id}=${p.baseUrl}(${p.models.length})`)
		.join(", ");
	logInfo("wrote models layer", { path: out, providers: summary });
}

await main();
