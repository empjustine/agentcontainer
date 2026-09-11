/**
 * @fileoverview generate-cloud-alternative-providers.mjs — Emit the pi overlay
 * layers for the cloud ALTERNATIVE providers: the providers pi does NOT ship
 * natively, where this layer is the ONLY source of the full provider
 * definition and is therefore always emitted in full — the opposite of the
 * pi-native override-only semantic in
 * `generate-cloud-pi-native-providers.mjs`.
 *
 * The set is table-driven (PROVIDER_SPECS below; one row = one emitted layer
 * file, numbered after model-012 in the merge order of merge-models-json.mjs):
 *
 *   - `cline-pass` (https://docs.cline.bot/getting-started/clinepass) →
 *     `model-015-cloud-cline-pass.json`
 *   - `hyper` (Charm Hyper, https://hyper.charm.land, key $HYPER_API_KEY) →
 *     `model-016-cloud-hyper.json`
 *
 * Both serve EVERY model over the same single OpenAI-compatible Chat
 * Completions endpoint (ClinePass confirmed by the reference extensions
 * jellydn/pi-clinepass-provider and maxpaulus43/pi-cline, which each register
 * one provider with `api: "openai-completions"` and vary models only by
 * capability + thinking metadata; Hyper exposes the same shape at /v1). So a
 * single provider block covers all models per provider; there is no per-model
 * API divergence (unlike OpenCode Zen/Go, where upstreams keep native
 * protocols).
 *
 * Each block mirrors the provider/compat settings the upstream references
 * register, plus the models.dev catalog metadata:
 *   - api: "openai-completions"
 *   - baseUrl: provider.api            (per-provider, from the vendored catalog)
 *   - apiKey: "$<PROVIDER_KEY_ENV>"    (auth presence gates /model availability)
 *   - authHeader: true                 (Authorization: Bearer)
 *   - compat.supportsDeveloperRole: false — cline-pass ONLY
 *       ClinePass rejects the `developer` role pi-ai emits for reasoning
 *       models; both reference extensions set this. Without it, reasoning
 *       models 400. Hyper is a standard OpenAI-compatible gateway: the
 *       vendor extension (charmbracelet/pi-hyper-provider) does NOT disable
 *       the developer role, so no override is emitted here either.
 *   - per-model thinkingLevelMap derived from models.dev reasoning_options
 *       (provider `reasoning_effort` enum values; effort values map through
 *       EFFORT_TO_PI, so enums that include "minimal" support pi "minimal").
 *
 * Hyper additionally mirrors the per-model compat the vendor extension
 * registers for EVERY model (src/models.ts of
 * github.com/charmbracelet/pi-hyper-provider, mirrored under
 * ~/Downloads/references/github/):
 *   - supportsStore: false           (no OpenAI `store` field)
 *   - maxTokensField: "max_tokens"   (legacy limit field, not max_completion_tokens)
 *   - thinkingFormat: "deepseek"     (thinking: {type: enabled|disabled} [+ effort])
 *   - supportsReasoningEffort: <bool> — true only when the model exposes a
 *       reasoning-effort enum; effort-less reasoning models (glm-5,
 *       kimi-k2-thinking, ...) get false plus the extension's ON_OFF
 *       thinkingLevelMap (off:"off", max:"max", rest null — pi "max" is the
 *       single representative "on" state), which only makes sense paired
 *       with the deepseek thinking format: "off" translates to thinking
 *       disabled, any other level to enabled, with no effort value sent.
 *   - headers: a static User-Agent, mirroring the extension's
 *       "pi-hyper-provider/<version>" (models.json headers are static
 *       literals here; the versioned UA is extension-only).
 *
 * Hyper facts cache (lib/hyper-facts.mjs — see its header for why hyper is
 * the ONLY provider here with a non-models.dev cache): the live /provider
 * catalog is strictly fresher per capability/price field than the models.dev
 * snapshot, and pi has no built-in hyper, so this layer is the only metadata
 * pi ever sees. Direct mode REFRESHES the cache (endpoint reachable) and
 * enriches every model with it; peer mode CONSUMES it stale-tolerantly (peer
 * mode means hyper.charm.land itself is unreachable, so the cache is the
 * only enrichment available). Enrichment is a NARROW per-field whitelist
 * (reasoning, input, costs incl. cached-in/out, limits, thinkingLevelMap,
 * compat.supportsReasoningEffort — all derived from the live record);
 * display names stay models.dev (the catalog's are more descriptive); the
 * wire compat block and the provider route are never touched. Matched
 * records are REBUILT through piModel(), so the effort enum → map/compat
 * derivation and the ON_OFF fallback run on live data.
 *
 * Known models.dev ↔ Hyper /provider drift (verified 2026-09 against the
 * live endpoint, which is the vendor extension's ONLY source): a few
 * reasoning flags and image-input claims disagree (e.g. minimax-m2.7
 * reasoning true in the catalog, can_reason false live; several
 * kimi/glm/qwen models carry catalog image input that live
 * supports_attachments denies), cache prices sit in different catalog slots
 * per model, and the live-only model deepseek-v4.1-flash is absent. This
 * generator stays catalog-driven (the vendored catalog refreshes best-effort
 * each run); install the vendor extension if you need Hyper's own live view.
 *
 * IMPORTANT — unlike the pi-native trio (openrouter/opencode/opencode-go, see
 * generate-cloud-pi-native-providers.mjs), pi has NO native definition for
 * any provider in this table, so this layer is the ONLY source of the provider
 * definition.  An override-style "emit only when something differs / is
 * unreachable" reading (docs/d022) does NOT apply here: every run
 * must emit the FULL provider block (baseUrl, api, key/auth, compat AND the
 * complete models list), whether the endpoint is reachable directly or routed
 * through the peer.  The cascade below only decides WHICH baseUrl/key/auth the
 * full block carries, never whether to emit the block at all — except when
 * neither the real endpoint nor any peer route is usable, in which case that
 * provider is unreachable and its layer is left untouched.
 *
 * Detection cascade (per provider — peer-router, same rule as
 * generate-local-llama-swap.mjs, generate-cloud-pi-native-providers.mjs and
 * generate-opencode.jsonc.mjs):
 *
 *   1. Probe the REAL endpoint (per-provider `api` from the vendored
 *      models.dev catalog). Reachable ⇒ emit the FULL provider routed at the
 *      real baseUrl with the complete models.dev catalog. "Reachable" is
 *      about the NETWORK PATH, not credentials: a 401/403 is what an
 *      OpenAI-compatible endpoint returns to any unauthenticated request (this
 *      generator runs without provider keys by design; pi resolves its own key
 *      at request time), and proves routing to the provider works — it must
 *      NOT trigger a peer override. Only the absence of ANY http response
 *      (DNS failure, connection refused, TLS failure, timeout) justifies
 *      switching to the peer.
 *   2. If unreachable, look for the models behind a llama-swap peer router
 *      ($PEER_BASE_URL, then the shared fallback FQDN — lib/peer-probe.mjs
 *      DEFAULT_PEER_FALLBACK, the world-visible FQDN funnel of the LAN :8080
 *      instance). If the peer serves the provider's models (ids fully
 *      qualified as `<providerId>/<modelId>`, possibly double-prefixed as
 *      `<providerId>/<providerId>/<modelId>` when the peer is itself a relay
 *      chain), emit the same provider routed through the peer: `baseUrl` set
 *      to the winning peer under `/v1`, `apiKey` "$PEER_API_KEY" (the peer's
 *      bearer key), with the catalog limited to the models the peer actually
 *      serves — each still enriched with the models.dev metadata
 *      (`thinkingLevelMap`, `input`, costs, ...) via prefix normalization, so
 *      the richer capability/thinking surface is preserved in peer mode.  A
 *      peer-only model with no models.dev equivalent is published with minimal
 *      fields so it stays usable.
 *   3. If neither the real endpoint nor any peer route is usable, emit nothing
 *      for that provider and leave its existing layer untouched (the provider
 *      is genuinely not reachable from this host).
 *
 * Extension-only ClinePass features that models.json cannot replicate
 * (documented, not emitted here — use
 * pi install git:github.com/jellydn/pi-clinepass-provider if you need them):
 *   - WorkOS device-code OAuth reuse (models.json `oauth` only supports "radius")
 *   - Cline prompt-cache `compat` + before_provider_request normalization
 *   - 403 subscription error surface via a message_end handler
 *
 * Usage: node generate-cloud-alternative-providers.mjs
 *   Writes one layer file per PROVIDERS_SPECS row next to this script (the
 *   generate.sh scratch dir on container/host runs).
 *   Env: PEER_BASE_URL (first peer candidate), PEER_API_KEY (peer bearer),
 *   plus each provider's own key var (read only for the direct probe — the
 *   emitted layer references "$<ENV>" so pi resolves the key at request time).
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
const { loadHyperFacts, refreshHyperFacts } =
	/** @type {typeof import("../lib/hyper-facts.mjs")} */ (
		await import(`${LIB_DIR}/hyper-facts.mjs`)
	);
setLogTool("coding-agent/generate-cloud-alternative");

const OPENAI_COMPLETIONS_API = "openai-completions";
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

/**
 * The alternative-provider table: one row per provider pi does not ship
 * natively. Adding support for a new one is a row here plus a merge-order
 * row in merge-models-json.mjs's header — everything else (catalog load,
 * cascade, peer normalization, layer emission) is generic.
 *
 * `file` numbers the layer into merge-models-json.mjs's lexical merge order
 * (zero-padded, after model-015). `envKey` is the provider's own key variable
 * (from the catalog's `env`) — referenced as `$<envKey>` in the emitted layer
 * and read here only for the direct probe. `compat` is the provider-level
 * compat pi cannot infer (null = no override); `modelCompat` builds the
 * per-model compat mirror (null = none); `onOffThinking` swaps the all-null
 * effort-less map for the ON_OFF representative map (see header); `headers`
 * emits provider-level request headers.
 *
 * @typedef {object} AlternativeProviderSpec
 * @property {string} id models.dev provider key AND pi provider id
 * @property {string} name display name for the pi provider block
 * @property {string} file output layer filename (relative to this script)
 * @property {string} envKey env var holding the provider API key
 * @property {{ supportsDeveloperRole: boolean }|null} compat
 * @property {((m: ModelsDevModel) => Record<string, unknown>|null)|null} modelCompat
 * @property {boolean} onOffThinking
 * @property {boolean} [enrichFromFacts] refresh + consume the lib/hyper-facts
 *   cache (hyper only — the one provider with a non-models.dev cache)
 * @property {Record<string, string>} [headers]
 */

/** @type {AlternativeProviderSpec[]} */
const PROVIDER_SPECS = [
	{
		id: "cline-pass",
		name: "ClinePass",
		file: "model-015-cloud-cline-pass.json",
		envKey: "CLINE_API_KEY",
		// ClinePass rejects the `developer` role pi-ai emits for reasoning
		// models (see header): both reference extensions force it off.
		compat: { supportsDeveloperRole: false },
		modelCompat: null,
		onOffThinking: false,
	},
	{
		id: "hyper",
		name: "Charm Hyper",
		file: "model-016-cloud-hyper.json",
		envKey: "HYPER_API_KEY",
		// Standard OpenAI-compatible gateway: the vendor extension accepts the
		// default role handling, so no provider-level compat override.
		compat: null,
		// Per-model compat mirror of charmbracelet/pi-hyper-provider
		// src/models.ts (see header): the full block on EVERY model, exactly
		// like the extension.
		modelCompat: (m) => ({
			supportsStore: false,
			supportsReasoningEffort: effortValues(m).size > 0,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		}),
		// Pair the deepseek thinking format with the extension's ON_OFF map
		// for effort-less reasoning models — see the header note.
		onOffThinking: true,
		// The one non-models.dev enrichment source: refresh + consume
		// lib/hyper-facts (see header + lib/hyper-facts.mjs).
		enrichFromFacts: true,
		headers: {
			// Mirror of the extension's "pi-hyper-provider/<version>" UA
			// (models.json headers are static literals; versioning is
			// extension-only).
			"User-Agent": "pi-hyper-models-layer/1",
		},
	},
];

// Map models.dev `reasoning_options` effort values onto pi thinking levels
// (off, minimal, low, medium, high, xhigh, max). ClinePass exposes enums like
// ["none","low","medium","high","xhigh"] and Hyper (e.g. inkling) like
// ["none","minimal","low","medium","high","xhigh"]; "none" disables thinking
// (pi "off"), the rest map 1:1. Levels absent from the provider enum are
// marked unsupported (null) so they are hidden in /model and pi never sends
// an out-of-enum value.
/** @type {Record<string, string>} */
const EFFORT_TO_PI = {
	none: "off",
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Thinking map for reasoning models that expose NO effort enum (Hyper's
// glm-5, kimi-k2-thinking, ...): the charmbracelet/pi-hyper-provider
// ON_OFF_THINKING_LEVEL_MAP — pi "max" is the single representative "on"
// state, "off" disables thinking. Only valid for providers that pair it
// with thinkingFormat: "deepseek" + supportsReasoningEffort: false (the
// wire translation then drops efforts entirely).
const ON_OFF_THINKING_LEVEL_MAP = Object.freeze({
	off: "off",
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
});

/**
 * The model's reasoning-effort enum as a lowercase set (empty when the model
 * exposes none).
 * @param {ModelsDevModel} m
 * @returns {Set<string>}
 */
function effortValues(m) {
	const values = new Set();
	for (const opt of m?.reasoning_options ?? []) {
		if (opt?.type === "effort" && Array.isArray(opt.values)) {
			for (const v of opt.values) values.add(String(v).toLowerCase());
		}
	}
	return values;
}

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
 * @typedef {object} PiAlternativeModel
 * @property {string} id
 * @property {boolean} reasoning
 * @property {string[]} input
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number }} [cost]
 * @property {Record<string, string|null>} [thinkingLevelMap]
 * @property {Record<string, unknown>} [compat]
 */

/**
 * A models.json provider layer for one alternative provider.
 * @typedef {object} ProviderBlock
 * @property {Record<string, { name: string, baseUrl: string, api: string, apiKey: string, authHeader?: boolean, headers?: Record<string, string>, compat?: { supportsDeveloperRole: boolean }, models: PiAlternativeModel[] }>} providers
 */

/**
 * @param {Array<{ type?: string, values?: string[] }>} [reasoningOptions]
 * @returns {Record<string, string|null>|null} the map, or null when the model
 *   exposes no effort enum (callers decide the fallback, e.g. ON_OFF thinking)
 */
function buildThinkingLevelMap(reasoningOptions) {
	const values = effortValues({ reasoning_options: reasoningOptions });
	if (values.size === 0) return null;
	/** @type {Record<string, string|null>} */
	const map = {};
	for (const level of PI_LEVELS) {
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
 * @returns {PiAlternativeModel["cost"]}
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
 * Build the pi-shaped model entry for one models.dev model of provider
 * `spec.id`.  `id` is the fully-qualified model id to publish; the default
 * keeps the catalog's own id (ClinePass catalog ids are already
 * `cline-pass/<modelId>`; Hyper's are bare — both are published verbatim in
 * direct mode, since pi namespaces them under the provider id itself).
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @param {ModelsDevModel} m a models.dev model record
 * @param {string} [id] the id to publish (defaults to the record's own id)
 * @returns {PiAlternativeModel} a pi model entry
 */
function piModel(spec, m, id = m.id) {
	/** @type {PiAlternativeModel} */
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
		const map = buildThinkingLevelMap(m.reasoning_options);
		model.thinkingLevelMap =
			map ?? (spec.onOffThinking ? { ...ON_OFF_THINKING_LEVEL_MAP } : map);
	}
	const compat = spec.modelCompat?.(m);
	if (compat) model.compat = compat;
	return model;
}

/**
 * Load one provider's slice of the vendored models.dev catalog.
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @returns {{ api: string, models: Record<string, ModelsDevModel> }} the
 *   models.dev provider record (api endpoint + per-model metadata)
 */
function loadProvider(spec) {
	const catalog = JSON.parse(readFileSync(API_JSON, "utf-8"));
	const provider = catalog[spec.id];
	if (!provider) throw new Error(`provider ${spec.id} not found in ${API_JSON}`);
	return /** @type {{ api: string, models: Record<string, ModelsDevModel> }} */ (
		provider
	);
}

/**
 * Strip any number of repeated `<providerId>/` prefixes from a peer-served
 * id (a peer may serve ids fully qualified once — matching a prefixed
 * models.dev catalog — or, when the peer is itself a relay forwarding to
 * another peer of the same family, doubly qualified).
 * @param {string} providerId
 * @param {string} peerId
 * @returns {string} the bare model id
 */
function stripProviderPrefixes(providerId, peerId) {
	let s = peerId;
	while (s.startsWith(`${providerId}/`)) s = s.slice(providerId.length + 1);
	return s;
}

/**
 * Resolve a peer-served id to the models.dev catalog key it corresponds to.
 * Catalog id conventions differ per provider (ClinePass keys are
 * `cline-pass/<modelId>`, Hyper keys are bare), so both spellings are tried:
 * the id with prefix normalization applied as-is, then re-prefixed once.
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @param {Map<string, ModelsDevModel>} byId the provider's models.dev records, keyed by catalog id
 * @param {string} peerId the id as the peer serves it
 * @returns {ModelsDevModel|null} the matching record, or null when the peer id has no catalog equivalent
 */
function toCatalogRecord(spec, byId, peerId) {
	const bare = stripProviderPrefixes(spec.id, peerId);
	for (const candidate of [bare, `${spec.id}/${bare}`]) {
		const m = byId.get(candidate);
		if (m) return m;
	}
	return null;
}

/**
 * Build the provider block routed at `baseUrl` with the given key/auth.
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @param {string} baseUrl
 * @param {PiAlternativeModel[]} models
 * @param {{ apiKey: string, authHeader?: boolean }} auth
 * @returns {ProviderBlock} a models.json provider layer for the provider
 */
function providerBlock(spec, baseUrl, models, auth) {
	return {
		providers: {
			[spec.id]: {
				name: spec.name,
				baseUrl,
				api: OPENAI_COMPLETIONS_API,
				apiKey: auth.apiKey,
				...(auth.authHeader ? { authHeader: true } : {}),
				...(spec.headers ? { headers: spec.headers } : {}),
				...(spec.compat ? { compat: spec.compat } : {}),
				models,
			},
		},
	};
}

/**
 * Run the per-provider detection cascade and emit that provider's layer.
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @returns {Promise<void>}
 */
/**
 * Rebuild a raw lib/hyper-facts (live /provider) record as a models.dev-shaped
 * model record, so the enrichment reuses piModel()'s full derivation (input,
 * costs, effort-enum → thinkingLevelMap/compat). Fields pi models but the
 * live record lacks stay undefined → piModel()'s defaults; the display name
 * is overridden back to the models.dev one by the enricher (names stay
 * catalog — see the header whitelist note).
 * @param {import("../lib/hyper-facts.mjs").HyperProviderModel} l a raw live /provider record
 * @returns {ModelsDevModel} a models.dev-shaped record with live facts
 */
function liveToCatalogRecord(l) {
	const levels = (l.reasoning_levels ?? []).map((v) => String(v).toLowerCase());
	return {
		id: l.id,
		name: l.name ?? l.id,
		reasoning: l.can_reason === true,
		modalities: {
			input: l.supports_attachments === true ? ["text", "image"] : ["text"],
		},
		limit: {
			context: l.context_window,
			output: l.default_max_tokens,
		},
		// Hyper's /provider prices cached INPUT and cached OUTPUT separately;
		// models.dev files at most one of them per model — the live values win
		// (docs-consistent: cached-in → cache_write, cached-out → cache_read).
		cost: {
			input: l.cost_per_1m_in ?? 0,
			output: l.cost_per_1m_out ?? 0,
			cache_read: l.cost_per_1m_out_cached ?? 0,
			cache_write: l.cost_per_1m_in_cached ?? 0,
		},
		reasoning_options: levels.length
			? [{ type: "effort", values: levels }]
			: [],
	};
}

/**
 * Enrich pi-shaped models with the hyper facts cache: rebuild every model
 * whose (prefix-stripped) id is in the live records through piModel() on
 * LIVE data, keeping the models.dev display name (see the header whitelist).
 * Models absent from the cache pass through untouched; live-only records are
 * returned for the caller to append (direct mode appends them, peer mode
 * appends only ids the peer actually serves).
 * @param {AlternativeProviderSpec} spec the provider spec row
 * @param {PiAlternativeModel[]} models the models to enrich
 * @param {import("../lib/hyper-facts.mjs").LoadedHyperFacts} facts loaded cache
 * @returns {{ enriched: PiAlternativeModel[], liveOnly: ModelsDevModel[], untouched: PiAlternativeModel[] }}
 */
function enrichWithFacts(spec, models, facts) {
	const live = new Map(
		facts.models.map((l) => [stripProviderPrefixes(spec.id, l.id), l]),
	);
	const enriched = [];
	const untouched = [];
	for (const m of models) {
		const l = live.get(stripProviderPrefixes(spec.id, m.id));
		if (!l) {
			untouched.push(m);
			continue;
		}
		const merged = { ...liveToCatalogRecord(l), name: m.name };
		enriched.push(piModel(spec, merged, m.id));
	}
	const servedIds = new Set(
		models.map((m) => stripProviderPrefixes(spec.id, m.id)),
	);
	const liveOnly = facts.models
		.filter((l) => !servedIds.has(stripProviderPrefixes(spec.id, l.id)))
		.map((l) => liveToCatalogRecord(l));
	return { enriched, liveOnly, untouched };
}

async function emitProvider(spec) {
	const provider = loadProvider(spec);
	let allModels = Object.values(provider.models).map((m) => piModel(spec, m));

	// --- 1. real endpoint first -----------------------------------------
	// Any non-unreachable response proves the network path works — including a
	// 401/403 credential-gate (this generator runs without provider keys by
	// design; pi authenticates itself at request time) — so keep the real
	// route.  Only a total absence of http response switches to the peer.
	const real = await probeDirect(
		provider.api,
		bearerHeaders(process.env[spec.envKey]?.trim()),
	);
	if (real.result !== "unreachable") {
		// Direct mode: the endpoint answers — refresh the facts cache
		// (best-effort; a failed refresh keeps the last good copy) and enrich
		// with live records (appends live-only models; keeps catalog-only).
		let facts = null;
		if (spec.enrichFromFacts) {
			await refreshHyperFacts();
			facts = loadHyperFacts();
		}
		let models = allModels;
		if (facts) {
			const { enriched, liveOnly, untouched } = enrichWithFacts(
				spec,
				allModels,
				facts,
			);
			models = [...enriched, ...untouched];
			if (liveOnly.length) {
				models = [...models, ...liveOnly.map((r) => piModel(spec, r))];
			}
			logInfo(`${spec.id} enriched from facts cache`, {
				fetchedAt: facts.fetchedAt,
				ageMs: facts.ageMs,
				enriched: enriched.length,
				liveOnlyAppended: liveOnly.length,
				catalogOnlyKept: untouched.length,
			});
		}
		logInfo(`${spec.id} reachable — emitting real route`, {
			baseUrl: provider.api,
			models: models.length,
			outcome: real.result,
			...(real.error ? { error: real.error } : {}),
		});
		write(
			providerBlock(spec, provider.api, models, {
				apiKey: `$${spec.envKey}`,
				authHeader: true,
			}),
			spec,
		);
		return;
	}

	// --- 2. real endpoint unreachable — try the peer ---------------------
	logInfo(`${spec.id} endpoint unreachable — probing peer route`, {
		error: real.error,
	});
	const peer = await probeCandidates(CLOUD_PEER_CANDIDATES, (ids) =>
		ids.some((id) => id.startsWith(`${spec.id}/`)),
	);
	if (!peer) {
		logWarn(
			`no ${spec.id} peer route visible — emitting nothing, leaving layer untouched`,
		);
		return;
	}

	// Match the peer's served ids against the models.dev catalog to preserve
	// the rich per-model metadata (thinkingLevelMap, input, costs).  A peer
	// id is normalized via toCatalogRecord() (repeated-prefix stripping +
	// bare/prefixed lookup) then looked up against the models.dev keys.
	const byId = new Map(Object.entries(provider.models));
	const peerEntries = peer.entries.filter((e) =>
		e.id.startsWith(`${spec.id}/`),
	);
	const mapped =
		/** @type {{ entry: { id: string }, meta: ModelsDevModel }[]} */ ([]);
	const unmatched = /** @type {{ entry: { id: string } }[]} */ ([]);
	for (const e of peerEntries) {
		const m = toCatalogRecord(spec, byId, e.id);
		if (m) mapped.push({ entry: e, meta: m });
		else unmatched.push({ entry: e });
	}
	const models = [
		// Models with models.dev metadata — publish under the exact peer-returned
		// id, enriched (name, reasoning, input, limits, costs, thinkingLevelMap).
		...mapped.map(({ entry: e, meta }) => piModel(spec, meta, e.id)),
		// Peer-served ids with no models.dev equivalent — publish minimal fields so
		// the route stays usable rather than silently dropping the model.
		...unmatched.map(({ entry: e }) => ({
			id: e.id,
			reasoning: true,
			input: ["text"],
		})),
	];

	// Peer mode CONSUMES the facts cache stale-tolerantly — no refresh here
	// (peer mode means the provider endpoint itself is unreachable, so the
	// cache from the last direct run is the only enrichment available).
	let facts = null;
	if (spec.enrichFromFacts) facts = loadHyperFacts();
	let peerModels = models;
	if (facts) {
		const { enriched, untouched } = enrichWithFacts(spec, models, facts);
		peerModels = [...enriched, ...untouched];
		logInfo(`${spec.id} peer models enriched from facts cache`, {
			fetchedAt: facts.fetchedAt,
			ageMs: facts.ageMs,
			enriched: enriched.length,
			untouched: untouched.length,
		});
	}

	logInfo(`${spec.id} routed through peer`, {
		baseUrl: `${peer.baseUrl}/v1`,
		models: peerModels.length,
	});
	write(
		providerBlock(spec, `${peer.baseUrl}/v1`, peerModels, {
			apiKey: "$PEER_API_KEY",
		}),
		spec,
	);
}

/**
 * @param {ProviderBlock} block
 * @param {AlternativeProviderSpec} spec the provider spec row (owns the filename)
 * @returns {void}
 */
function write(block, spec) {
	const out = join(scriptDir, spec.file);
	const tmp = `${out}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(block, null, 2)}\n`);
	renameSync(tmp, out); // atomic on the same filesystem
	logInfo(`wrote ${spec.name} models`, {
		path: out,
		models: block.providers[spec.id].models.length,
	});
}

for (const spec of PROVIDER_SPECS) {
	await emitProvider(spec);
}
