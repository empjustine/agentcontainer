/**
 * @fileoverview gen-lib.mjs — the shared preamble for the coding-agent
 * pi-layer generators: resolves `scriptDir` / `LIB_DIR`, re-exports the lib/
 * helpers they use, owns the models.dev catalog lookup order, and holds
 * pi's driving-capability declaration — the one allowlist both eligibility
 * (modalitiesEligible) and emission (toInput) derive from (docs/d049). The
 * serving layers' equivalent is ../llm-local-inference/gen-lib.mjs; the
 * LIB_DIR staging convention (and why a scratch copy exists at all) is
 * docs/d023.
 *
 * This module is staged next to the generators (plus its coding-agent/
 * siblings peer-probe.mjs, hyper-facts.mjs, catwalk-facts.mjs and
 * refresh-models-dev.mjs — docs/d039) and a copy of lib/ (see generate.sh),
 * and mounted into the container by run.sh — both lists must carry them.
 * lib/ imports resolve through $LIB_DIR; the coding-agent/ siblings import
 * statically, so the same file works in place and in the scratch dir.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	bearerHeaders,
	fetchModelEntries,
	peerBaseUrl,
	peerBaseUrls,
	peerProviderUrl,
	peersOnly,
	probeCandidates,
	probeDirect,
	probePeerRoutes,
	suppressedProbe,
} from "./peer-probe.mjs";

export { getCatwalkModels, refreshCatwalkFacts } from "./catwalk-facts.mjs";
export { loadHyperFacts, refreshHyperFacts } from "./hyper-facts.mjs";

export const scriptDir = dirname(fileURLToPath(import.meta.url));
export const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");

const logging = /** @type {typeof import("../lib/log.mjs")} */ (
	await import(`${LIB_DIR}/log.mjs`)
);
const artifact = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
const cloudProviders =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);

export const { logInfo, logWarn, setLogTool } = logging;
export const { writeArtifact, writeJsonArtifact } = artifact;
export {
	bearerHeaders,
	fetchModelEntries,
	peerBaseUrl,
	peerBaseUrls,
	peerProviderUrl,
	peersOnly,
	probeCandidates,
	probeDirect,
	probePeerRoutes,
	suppressedProbe,
};
export const { CLOUD_PROVIDERS, PI_NATIVE_CLOUD_IDS } = cloudProviders;

/**
 * pi shaping (folded in from the former lib/pi-models.mjs — docs/d039): shape
 * probe results / catalog records into pi `models.json` entries. The pi
 * generator's local and cloud stages share this shaping: llama-swap serves
 * the SAME metadata shape for local GGUF and for cloud peers routed through
 * it (`meta.llamaswap` on `/v1/models`), so the RawModelEntry → PiModel
 * mapping and the provider wrapper (compat block, `/v1` normalization, the
 * `$PEER_API_KEY` reference) are one implementation (docs/d024).
 */

// Shared /models shapes — the types live next to the probe toolkit.
// Shared /models shapes — the types live next to the probe toolkit.
/** @typedef {import("./peer-probe.mjs").RawModelEntry} RawModelEntry */
/** @typedef {import("./peer-probe.mjs").Cost} Cost */

/**
 * A pi-shaped model entry: what pi needs to route and price a model.
 * @typedef {object} PiModel
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} reasoning
 * @property {string[]} input
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {Cost} cost
 * @property {string} [api] per-model api override (pi docs/models.md) —
 *   set by the generator when the provider serves a MIXED api surface and
 *   the provider-wide dialect cannot route every model (opencode-go,
 *   docs/d048)
 */

/**
 * Provider-level compat shared by every llama-swap-routed model — same block
 * the built-in llama.cpp extension attaches per-model (see pi docs/models.md).
 * @typedef {object} LlmCompat
 * @property {boolean} supportsStore
 * @property {boolean} supportsDeveloperRole
 * @property {boolean} supportsReasoningEffort
 * @property {boolean} supportsUsageInStreaming
 * @property {boolean} supportsStrictMode
 * @property {string} maxTokensField
 */

/**
 * A pi `models.json` provider entry. `api` and `compat` are optional: full
 * entries (providerEntry) always set them; reroute-only overrides for
 * pi-native providers (providerReroute) deliberately omit both so pi's
 * built-in provider definition supplies the dialect.
 * @typedef {object} PiProvider
 * @property {string} baseUrl literal URL — pi does not expand environment
 *   references in baseUrl
 * @property {string} [api]
 * @property {LlmCompat} [compat]
 * @property {string} [apiKey]
 * @property {PiModel[]} models
 */

/** @type {Readonly<LlmCompat>} */
export const LLAMA_SWAP_COMPAT = Object.freeze({
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
});

/**
 * "<slug>-ctx<NNN>-<org>/<repo>[:<quant>]" -> "Qwen3.8-27B UD-Q6_K"
 * @param {string} id
 * @returns {string|undefined} undefined for ids that don't follow the scheme
 *   (pi then falls back to the raw id)
 */
function displayName(id) {
	const m = /^([^-]+)-ctx(\d+)-(.+)$/.exec(id);
	if (!m) return undefined;
	const [, , , repoFull] = m;
	const [repoPath, quant] = repoFull.split(":");
	const base = (repoPath.split("/").pop() ?? "").replace(/-GGUF$/i, "");
	return [base, quant].filter(Boolean).join(" ");
}

/**
 * THE pipeline-wide declaration of what the driving pi client can handle
 * (docs/d049): the input modal pi's own schema accepts, and the output
 * modalities it can consume. Eligibility (`modalitiesEligible`) and
 * projection (`toInput`) both derive from it — admit-but-trim, so the gate
 * and the emission read one source of truth and cannot drift.
 * `input[0]` is the drivable core (text): a client originates chat text, so
 * an input set without it can never be driven whatever else it offers.
 * @type {Readonly<{ input: readonly string[], output: readonly string[] }>}
 */
export const PI_MODALITY_CAPABILITY = Object.freeze({
	input: Object.freeze(["text", "image"]),
	output: Object.freeze(["text"]),
});

/**
 * docs/d049's admit-but-trim GATE: judge only the dimensions the record
 * actually carries. A missing/empty dimension is unjudgeable and PASSES —
 * name exceptions and id-only defaults stay the fallback for records
 * without metadata (non-rich sources are never enriched to become
 * judgeable — d049's scope decision).
 *
 * - input: must include the drivable core; extra entries (audio, video, …)
 *   are fine because `toInput` trims them at emission.
 * - output: every produced modality must be inside the capability — a chat
 *   client cannot consume audio/video/image out, so one foreign entry
 *   refuses the model outright (no trim applies to what comes back).
 * @param {{ input?: string[], output?: string[] }} [modalities]
 * @returns {boolean} false = the client cannot drive this record; drop it
 */
export function modalitiesEligible(modalities) {
	const input = modalities?.input;
	const output = modalities?.output;
	if (input?.length && !input.includes(PI_MODALITY_CAPABILITY.input[0])) {
		return false;
	}
	if (
		output?.length &&
		!output.every((o) => PI_MODALITY_CAPABILITY.output.includes(o))
	) {
		return false;
	}
	return true;
}

/**
 * The ONE shared projection (docs/d049 item 3): intersect the declared
 * input with PI_MODALITY_CAPABILITY — deny-by-absence in capability order,
 * so emitted arrays are always `["text"]` or `["text","image"]`. Covers
 * both callers that used to carry a copy each (catalog records here, raw
 * live listings via piModel).
 *
 * The `[core]` fallback is for metadata-less records (fabricated minimal
 * ids, listings without architecture) — where the gate did not judge and
 * there is nothing to intersect: default to the drivable core rather than
 * emit an empty array the schema rejects.
 * @param {string[]} [modalities]
 * @returns {string[]}
 */
export function toInput(modalities) {
	const input = PI_MODALITY_CAPABILITY.input.filter((m) =>
		modalities?.includes(m),
	);
	return input.length ? input : [PI_MODALITY_CAPABILITY.input[0]];
}

/**
 * Mirror a raw `/models` entry into pi's model shape, preferring llama-swap's
 * own metadata over the llama.cpp fields.
 * @param {RawModelEntry} entry
 * @returns {PiModel}
 */
export function piModel(entry) {
	const meta = entry.meta?.llamaswap;
	const contextWindow =
		meta?.contextWindow ??
		entry.context_length ??
		entry.meta?.n_ctx ??
		undefined;
	/**
	 * Don't trust raw provider listings to stay inside pi's input schema:
	 * openrouter's /v1/models carries architecture.input_modalities with
	 * video/audio/pdf entries (gemma-4-31b-it:free, inkling:free, ...),
	 * and a 3+ element input array fails the strict models.json schema
	 * (const anyOf ["text","image"]) the moment the file is re-read by
	 * cline/other strict consumers — the shared toInput does that filtering
	 * (d049's one projection; catalogPiModel reads through it too).
	 */
	const input = toInput(
		meta?.input ??
			entry.architecture?.input_modalities ??
			(entry.capabilities?.vision ? ["text", "image"] : ["text"]),
	);
	return {
		id: entry.id,
		...(displayName(entry.id) ? { name: displayName(entry.id) } : {}),
		reasoning: meta?.reasoning ?? true,
		input,
		contextWindow,
		maxTokens: meta?.maxTokens ?? contextWindow,
		cost: meta?.cost ?? { input: 10, output: 50, cacheRead: 1, cacheWrite: 20 },
	};
}

/**
 * A provider routed through `baseUrl` (the local llama-swap instance) under
 * the openai-completions protocol. The compat block is set EXPLICITLY: these
 * providers are hand-defined, so pi's provider-composer must not auto-inherit
 * the built-in `llama.cpp` provider's compat — only `api`/`baseUrl` are
 * inherited from built-in defaults. `apiKey` is the literal "$PEER_API_KEY",
 * llama-swap's own client-facing bearer (the cloud path-routes on the
 * simplified proxy do NOT use it — they forward pi's built-in provider auth,
 * see providerReroute, docs/d027); omitted when the generator's own
 * environment has no PEER_API_KEY at all.
 * @param {string} baseUrl
 * @param {PiModel[]} models
 * @returns {PiProvider}
 */
export function providerEntry(baseUrl, models) {
	return {
		baseUrl: `${baseUrl}/v1`,
		api: "openai-completions",
		compat: LLAMA_SWAP_COMPAT,
		...(process.env.PEER_API_KEY?.trim() ? { apiKey: "$PEER_API_KEY" } : {}),
		models,
	};
}

/**
 * A REROUTE-ONLY override for a provider pi ships NATIVELY (the
 * PI_NATIVE_CLOUD_IDS set): carries just the peer host-form route `baseUrl`
 * (`<peerBase>/<upstream-host><base-path>`, peerProviderUrl, docs/d047)
 * and the peer-visible models —
 * deliberately NO `api`, NO `compat`, and NO `apiKey`.
 *
 * Emitting an `api` compatibility key here would blindly pin the dialect for
 * providers whose built-in definition is richer than anything we can infer:
 * opencode registers a per-model api map (anthropic-messages /
 * google-generative-ai / openai-completions / openai-responses), opencode-go
 * a three-way one, mistral speaks its own `mistral-conversations` wire
 * format, google the native `google-generative-ai` one — and the public
 * models.dev API does not expose which model uses which. Omitting the key
 * lets pi's built-in provider definition supply the api implementation and
 * compat, so the override only changes WHERE requests go, never HOW they are
 * encoded. This is exactly what makes mistral's non-completions endpoints
 * and google's native dialect work through the peer (docs/d027/d047): the
 * host-allowlist proxy forwards every path under the upstream host key
 * byte-for-byte, whatever wire format pi speaks.
 *
 * `apiKey` is likewise omitted: llm-reverse-proxy does NO credential
 * handling (requests must already carry valid provider keys), so the
 * credentials are pi's own built-in per-provider auth (env key or OAuth,
 * resolved at request time) forwarded untouched. The former
 * `"$PEER_API_KEY"` reference belonged to llama-swap's gateway auth and has
 * no meaning here — PEER_API_KEY now only guards the LOCAL llama-swap /v1
 * route (docs/d027).
 * @param {string} providerUrl the provider's FULL peer path-route
 *   (peerProviderUrl output — used verbatim; the legacy `\`/v1\`` append
 *   was llama-swap's model-id-magic surface and is gone)
 * @param {PiModel[]} models
 * @returns {PiProvider}
 */
export function providerReroute(providerUrl, models) {
	return {
		baseUrl: providerUrl,
		models,
	};
}

/**
 * The models.dev catalog to read: a `models.dev.api.json` next to this script
 * wins (when staged, that entry is a symlink the best-effort refresh replaces
 * with the freshly fetched copy), else the shared vendored copy under
 * `LIB_DIR`. `MODELS_DEV_JSON` overrides both.
 * @returns {string}
 */
export function modelsDevCatalogPath() {
	return (
		process.env.MODELS_DEV_JSON ??
		(existsSync(join(scriptDir, "models.dev.api.json"))
			? join(scriptDir, "models.dev.api.json")
			: join(LIB_DIR, "models.dev.api.json"))
	);
}
