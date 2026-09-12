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
 *   1. Local inference (provider id `llama-swap`): probe the LOCAL GGUF
 *      llama-swap instance — the vault-sourced peer base (lib/peer-probe.mjs
 *      peerBaseUrl()), each as the llama-swap
 *      PATH-ROUTE of the funnel: peerProviderUrl(base, "llama-swap") —
 *      llm-reverse-proxy (host port 8080, the funnel front, docs/d027)
 *      strips the `/llama-swap` prefix and forwards to the local instance
 *      on loopback :8101. First candidate serving GGUF models wins; its
 *      model catalog becomes the `llama-swap` provider (pi-shaped metadata
 *      mirrored from meta.llamaswap).  No localhost candidates are probed:
 *      the LAN :8080 (proxy) and :8101 (llama-swap) listen addresses are
 *      only ever *local* listen addresses, so a co-located peer is reached
 *      via the vault-sourced peer base instead.
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
 *   Env: PEER_BASE_URL — vault-sourced peer base (peerBaseUrl(); required),
 *   PEER_API_KEY (peer bearer).
 *   Typical run, then merge — see merge-models-json.mjs:
 *     node generate-local-llama-swap.mjs        # -> model-010-local-default.json
 *     node generate-cloud-pi-native-providers.mjs
 *     node merge-models-json.mjs                # -> models.json
 */

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

// Ordered best-first: explicit override, then the remote tailscale proxy —
// each addressed as the llama-swap PATH-ROUTE of the funnel front
// The peer's funnel base URL — vault-sourced (peerBaseUrl(); see the
// header there).  No localhost candidates are probed — the LAN :8080 (proxy)
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

	// lib/artifact.mjs write contract: atomic tmp+rename, replace by default,
	// DRY_RUN=1 leaves the layer untouched and writes a preview.
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
