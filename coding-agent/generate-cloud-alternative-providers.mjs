/**
 * @fileoverview generate-cloud-alternative-providers.mjs — Emit the pi overlay
 * `model-015-cloud-cline-pass.json`: the ClinePass provider
 * (https://docs.cline.bot/getting-started/clinepass) as a single OpenAI-compatible Chat
 * Completions provider.
 *
 * This is the cloud-ALTERNATIVE generator of the per-merge-semantic split
 * (docs/d022, applied in docs/d024; formerly `generate-cline-pass.mjs`): it
 * owns the providers pi does NOT ship natively, where this layer is the ONLY
 * source of the full provider definition and is therefore always emitted in
 * full — the opposite of the pi-native override-only semantic in
 * `generate-cloud-pi-native-providers.mjs`.
 *
 * Source of truth is the vendored models.dev catalog (models.dev.api.json).
 * ClinePass serves EVERY model over the same /api/v1 OpenAI-compatible endpoint
 * — confirmed by both reference extensions (jellydn/pi-clinepass-provider and
 * maxpaulus43/pi-cline), which each register one provider with
 * `api: "openai-completions"` and vary models only by capability + thinking
 * metadata. So a single provider block covers all models; there is no per-model
 * API divergence (unlike OpenCode Zen/Go, where upstreams keep native protocols).
 *
 * The block mirrors the provider/compat settings those extensions register:
 *   - api: "openai-completions"
 *   - baseUrl: provider.api            (https://api.cline.bot/api/v1)
 *   - apiKey: "$CLINE_API_KEY"         (auth presence gates /model availability)
 *   - authHeader: true                 (Authorization: Bearer)
 *   - compat.supportsDeveloperRole: false
 *       ClinePass rejects the `developer` role pi-ai emits for reasoning models;
 *       both reference extensions set this. Without it, reasoning models 400.
 *   - per-model thinkingLevelMap derived from models.dev reasoning_options
 *       (provider `reasoning_effort` enum values).
 *
 * IMPORTANT — unlike the pi-native trio (openrouter/opencode/opencode-go, see
 * generate-cloud-pi-native-providers.mjs), pi has NO native
 * `cline-pass` provider, so this layer is the ONLY source of the provider
 * definition.  An override-style "emit only when something differs / is
 * unreachable" reading (docs/d022) does NOT apply here: every run
 * must emit the FULL provider block (baseUrl, api, key/auth, compat AND the
 * complete models list), whether the endpoint is reachable directly or routed
 * through the peer.  The cascade below only decides WHICH baseUrl/key/auth the
 * full block carries, never whether to emit the block at all — except when
 * neither the real endpoint nor any peer route is usable, in which case
 * cline-pass is unreachable and the layer is left untouched.
 *
 * Detection cascade (peer-router — same rule as generate-local-llama-swap.mjs,
 * generate-cloud-pi-native-providers.mjs and generate-opencode.jsonc.mjs):
 *
 *   1. Probe the REAL endpoint (https://api.cline.bot/api/v1). Reachable ⇒
 *      emit the FULL provider routed at the real baseUrl with the complete
 *      models.dev catalog. "Reachable"
 *      is about the NETWORK PATH, not credentials: a 401/403 is what an
 *      OpenAI-compatible endpoint returns to any unauthenticated request (this
 *      generator runs without provider keys by design; pi resolves its own key
 *      at request time), and proves routing to ClinePass works — it must NOT
 *      trigger a peer override. Only the absence of ANY http response (DNS
 *      failure, connection refused, TLS failure, timeout) justifies switching
 *      to the peer.
 *   2. If unreachable, look for the models behind a llama-swap peer router
 *      ($PEER_BASE_URL, then the shared fallback FQDN — lib/peer-probe.mjs
 *      DEFAULT_PEER_FALLBACK, the world-visible FQDN funnel of the LAN :8080
 *      instance). If the peer serves cline-pass models
 *      (ids fully qualified as `cline-pass/<modelId>`, possibly double-prefixed
 *      as `cline-pass/cline-pass/<modelId>` when the peer is itself a relay
 *      chain), emit the same provider routed through the peer: `baseUrl` set to
 *      the winning peer under `/v1`, `apiKey` "$PEER_API_KEY" (the peer's
 *      bearer key), with the catalog limited to the models the peer actually
 *      serves — each still enriched with the models.dev metadata
 *      (`thinkingLevelMap`, `input`, costs, ...) via prefix normalization, so
 *      the richer capability/thinking surface is preserved in peer mode.  A
 *      peer-only model with no models.dev equivalent is published with minimal
 *      fields so it stays usable.
 *   3. If neither the real endpoint nor any peer route is usable, emit nothing
 *      and leave any existing layer untouched (ClinePass is genuinely not
 *      reachable from this host).
 *
 * Extension-only features that models.json cannot replicate (documented, not
 * emitted here — use pi install git:github.com/jellydn/pi-clinepass-provider
 * if you need them):
 *   - WorkOS device-code OAuth reuse (models.json `oauth` only supports "radius")
 *   - Cline prompt-cache `compat` + before_provider_request normalization
 *   - 403 subscription error surface via a message_end handler
 *
 * Usage: node generate-cloud-alternative-providers.mjs [out]
 *   out defaults to ./model-015-cloud-cline-pass.json.
 *   Env: PEER_BASE_URL (first peer candidate), PEER_API_KEY (peer bearer).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Shared lib/ helpers (docs/d023): the structured logger and the HTTP probe
// toolkit, resolved through the LIB_DIR convention (generate.sh stages them
// into the scratch dir and points LIB_DIR there; manual in-place runs fall
// back to the sibling ../lib).
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { bearerHeaders, DEFAULT_PEER_FALLBACK, probeCandidates, probeDirect } =
	/** @type {typeof import("../lib/peer-probe.mjs")} */ (
		await import(`${LIB_DIR}/peer-probe.mjs`)
	);
setLogTool("coding-agent/generate-cloud-alternative");

const OPENAI_COMPLETIONS_API = "openai-completions";
const PROVIDER_ID = "cline-pass";
// Catalog lookup order: a models.dev.api.json next to this script wins — when
// run from generate.sh's scratch dir that entry is a symlink to the vendored
// catalog which the best-effort refresh replaces with the freshly fetched
// copy, so the generator always reads what this run validated.  Manual
// in-place runs fall back to the shared vendored catalog (docs/d023).
const API_JSON =
	process.env.MODELS_DEV_JSON ??
	(existsSync(join(scriptDir, "models.dev.api.json"))
		? join(scriptDir, "models.dev.api.json")
		: join(LIB_DIR, "models.dev.api.json"));

// Peer candidates: explicit override, then the shared fallback FQDN (see
// DEFAULT_PEER_FALLBACK — no localhost candidates are probed, docs/d022).
const CLOUD_PEER_CANDIDATES = [
	(process.env.PEER_BASE_URL ?? "").replace(/\/+$/, ""),
	DEFAULT_PEER_FALLBACK,
].filter(Boolean);

// Map models.dev `reasoning_options` effort values onto pi thinking levels
// (off, minimal, low, medium, high, xhigh, max). ClinePass exposes enums like
// ["none","low","medium","high","xhigh"]; "none" disables thinking (pi "off"),
// the rest map 1:1. Levels absent from the provider enum are marked unsupported
// (null) so they are hidden in /model and pi never sends an out-of-enum value.
/** @type {Record<string, string>} */
const EFFORT_TO_PI = {
	none: "off",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * A models.dev model record — the subset this generator reads.
 * @typedef {object} ModelsDevModel
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [reasoning]
 * @property {{ input?: string[] }} [modalities]
 * @property {{ context?: number, output?: number }} [limit]
 * @property {{ input?: number, output?: number, cache_read?: number, cache_write?: number }} [cost]
 * @property {Array<{ type?: string, values?: string[] }>} [reasoning_options]
 */

/**
 * A pi-shaped model entry as this generator publishes it.  Only the first
 * three fields are guaranteed: peer-served ids with no models.dev equivalent
 * are published minimal (the rest falls back to pi's defaults).
 * @typedef {object} PiClineModel
 * @property {string} id
 * @property {boolean} reasoning
 * @property {string[]} input
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number }} [cost]
 * @property {Record<string, string|null>} [thinkingLevelMap]
 */

/**
 * A models.json provider layer for cline-pass.
 * @typedef {object} ProviderBlock
 * @property {Record<string, { name: string, baseUrl: string, api: string, apiKey: string, authHeader?: boolean, compat: { supportsDeveloperRole: boolean }, models: PiClineModel[] }>} providers
 */

/**
 * @param {Array<{ type?: string, values?: string[] }>} [reasoningOptions]
 * @returns {Record<string, string|null>}
 */
function buildThinkingLevelMap(reasoningOptions) {
	const values = new Set();
	for (const opt of reasoningOptions ?? []) {
		if (opt?.type === "effort" && Array.isArray(opt.values)) {
			for (const v of opt.values) values.add(String(v).toLowerCase());
		}
	}
	/** @type {Record<string, string|null>} */
	const map = {};
	for (const level of PI_LEVELS) {
		if (level === "minimal") {
			map.minimal = null; // no "minimal" in any ClinePass effort enum
			continue;
		}
		const effort = Object.keys(EFFORT_TO_PI).find(
			(e) => EFFORT_TO_PI[e] === level,
		);
		map[level] = effort && values.has(effort) ? effort : null;
	}
	return map;
}

/**
 * pi's input schema accepts only "text" and "image"; video/audio/... are dropped.
 * @param {string[]} [modalitiesInput]
 * @returns {string[]}
 */
function toInput(modalitiesInput) {
	const set = new Set(modalitiesInput ?? ["text"]);
	const out = [];
	if (set.has("text")) out.push("text");
	if (set.has("image")) out.push("image");
	return out.length ? out : ["text"];
}

/**
 * @param {ModelsDevModel["cost"]} cost
 * @returns {PiClineModel["cost"]}
 */
function toCost(cost) {
	if (!cost) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cache_read ?? 0,
		cacheWrite: cost.cache_write ?? 0,
	};
}

/**
 * Build the pi-shaped model entry for one models.dev ClinePass model.
 * `id` is the fully-qualified model id to publish (models.dev catalog ids are
 * already `cline-pass/<modelId>`; a peer may serve a subset of the same ids).
 * @param {ModelsDevModel} m a models.dev model record
 * @param {string} id the id to publish (defaults to the record's own id)
 * @returns {PiClineModel} a pi model entry
 */
function piModel(m, id = m.id) {
	/** @type {PiClineModel} */
	const model = {
		id,
		name: m.name ?? id,
		reasoning: m.reasoning === true,
		input: toInput(m.modalities?.input),
		contextWindow: m.limit?.context ?? 128000,
		maxTokens: m.limit?.output ?? 16384,
		cost: toCost(m.cost),
	};
	if (model.reasoning) {
		model.thinkingLevelMap = buildThinkingLevelMap(m.reasoning_options);
	}
	return model;
}

function loadProvider() {
	const catalog = JSON.parse(readFileSync(API_JSON, "utf-8"));
	const provider = catalog[PROVIDER_ID];
	if (!provider)
		throw new Error(`provider ${PROVIDER_ID} not found in ${API_JSON}`);
	return /** @type {{ api: string, models: Record<string, ModelsDevModel> }} */ (
		provider
	);
}

/**
 * Normalize a peer-served cline-pass id to the models.dev catalog key it
 * corresponds to.  A peer may serve ids fully qualified once
 * (`cline-pass/<modelId>` — matching models.dev) or, when the peer is itself
 * a relay forwarding to another cline-pass peer, doubly qualified
 * (`cline-pass/cline-pass/<modelId>`).  Strip the repeated `cline-pass/`
 * prefix (any number of hops) and re-add it once, so both forms resolve to
 * the models.dev key `cline-pass/<modelId>`.
 * @param {string} peerId
 * @returns {string}
 */
function toCatalogId(peerId) {
	let s = peerId;
	while (s.startsWith(`${PROVIDER_ID}/`)) s = s.slice(PROVIDER_ID.length + 1);
	return `${PROVIDER_ID}/${s}`;
}

/**
 * Build the provider block routed at `baseUrl` with the given key/auth.
 * @param {string} baseUrl
 * @param {PiClineModel[]} models
 * @param {{ apiKey: string, authHeader?: boolean }} auth
 * @returns {ProviderBlock} a models.json provider layer for cline-pass
 */
function providerBlock(baseUrl, models, auth) {
	return {
		providers: {
			[PROVIDER_ID]: {
				name: "ClinePass",
				baseUrl,
				api: OPENAI_COMPLETIONS_API,
				apiKey: auth.apiKey,
				...(auth.authHeader ? { authHeader: true } : {}),
				compat: { supportsDeveloperRole: false },
				models,
			},
		},
	};
}

async function main() {
	const provider = loadProvider();
	const allModels = Object.values(provider.models).map((m) => piModel(m));

	// --- 1. real endpoint first -----------------------------------------
	// Any non-unreachable response proves the network path works — including a
	// 401/403 credential-gate (this generator runs without provider keys by
	// design; pi authenticates itself at request time) — so keep the real
	// route.  Only a total absence of http response switches to the peer.
	const real = await probeDirect(
		provider.api,
		bearerHeaders(process.env.CLINE_API_KEY?.trim()),
	);
	if (real.result !== "unreachable") {
		logInfo("cline-pass reachable — emitting real route", {
			baseUrl: provider.api,
			models: allModels.length,
			outcome: real.result,
			...(real.error ? { error: real.error } : {}),
		});
		write(
			providerBlock(provider.api, allModels, {
				apiKey: "$CLINE_API_KEY",
				authHeader: true,
			}),
		);
		return;
	}

	// --- 2. real endpoint unreachable — try the peer ---------------------
	logInfo("cline-pass endpoint unreachable — probing peer route", {
		error: real.error,
	});
	const peer = await probeCandidates(CLOUD_PEER_CANDIDATES, (ids) =>
		ids.some((id) => id.startsWith("cline-pass/")),
	);
	if (!peer) {
		logWarn(
			"no cline-pass peer route visible — emitting nothing, leaving layer untouched",
		);
		return;
	}

	// Match the peer's served ids against the models.dev catalog to preserve
	// the rich per-model metadata (thinkingLevelMap, input, costs).  A peer
	// id is normalized via toCatalogId() (`cline-pass/<modelId>`, single or
	// repeated prefix) then looked up against the models.dev keys.
	const byId = new Map(Object.values(provider.models).map((m) => [m.id, m]));
	const clinePeerEntries = peer.entries.filter((e) =>
		e.id.startsWith("cline-pass/"),
	);
	const mapped =
		/** @type {{ entry: { id: string }, meta: ModelsDevModel }[]} */ ([]);
	const unmatched = /** @type {{ entry: { id: string } }[]} */ ([]);
	for (const e of clinePeerEntries) {
		const m = byId.get(toCatalogId(e.id));
		if (m) mapped.push({ entry: e, meta: m });
		else unmatched.push({ entry: e });
	}
	const models = [
		// Models with models.dev metadata — publish under the exact peer-returned
		// id, enriched (name, reasoning, input, limits, costs, thinkingLevelMap).
		...mapped.map(({ entry: e, meta }) => piModel(meta, e.id)),
		// Peer-served ids with no models.dev equivalent — publish minimal fields so
		// the route stays usable rather than silently dropping the model.
		...unmatched.map(({ entry: e }) => ({
			id: e.id,
			reasoning: true,
			input: ["text"],
		})),
	];

	logInfo("cline-pass routed through peer", {
		baseUrl: `${peer.baseUrl}/v1`,
		models: models.length,
	});
	write(
		providerBlock(`${peer.baseUrl}/v1`, models, {
			apiKey: "$PEER_API_KEY",
		}),
	);
}

/**
 * @param {ProviderBlock} block
 * @returns {void}
 */
function write(block) {
	const out =
		process.argv[2] ?? join(scriptDir, "model-015-cloud-cline-pass.json");
	const tmp = `${out}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(block, null, 2)}\n`);
	renameSync(tmp, out); // atomic on the same filesystem
	const id = Object.keys(block.providers)[0];
	logInfo("wrote ClinePass models", {
		path: out,
		models: block.providers[id].models.length,
	});
}

await main();
