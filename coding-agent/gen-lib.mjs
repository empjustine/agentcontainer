/**
 * @fileoverview gen-lib.mjs — the pi shaping shared by the two coding-agent
 * generators: one RawModelEntry → PiModel mapping, the modality gate and
 * projection (docs/d049), and the paths both generators need.
 *
 * PURE BY CONTRACT. Loading this module reads no file and runs nothing; it
 * holds only functions, frozen constants and path strings. Generators import
 * logging, artifacts, provider facts and route probes from their owning
 * modules rather than through this one (docs/d233).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const scriptDir = dirname(fileURLToPath(import.meta.url));

/**
 * The folder's ONE fact table, as a path: the entry point reads it once with
 * readCloudProviders and passes the record down (docs/d024/d102).
 */
export const cloudProvidersPath = join(scriptDir, "lib", "cloud-providers.json");

/**
 * pi shaping (folded in from the former lib/pi-models.mjs — docs/d039): shape
 * probe results and catalog records into pi `models.json` entries. One
 * RawModelEntry → PiModel mapping serves the local farm's `/v1/models`
 * listing and the id-only records a cloud reroute publishes, so both read
 * pi's required fields the same way (docs/d024).
 */

// Shared /models shapes — the types live next to the probe toolkit.
/** @typedef {import("./route-probe.mjs").RawModelEntry} RawModelEntry */
/** @typedef {import("./route-probe.mjs").Cost} Cost */
/**
 * pi's price block: the four required per-million prices plus the
 * context-triggered overrides pi calls cost.tiers (a request whose input
 * exceeds the threshold bills at the higher price for ALL its tokens, which is
 * how a provider's ">200K context" row works).
 * @typedef {Cost & { tiers?: Array<Cost & { inputTokensAbove: number }> }} PiCost
 */

/**
 * A pi-shaped model entry: what pi needs to route and price a model.
 * @typedef {object} PiModel
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} reasoning
 * @property {string[]} input
 * @property {number|undefined} [contextWindow]
 * @property {number|undefined} [maxTokens]
 * @property {PiCost} [cost] absent — the key is DROPPED, never null — when
 *   the listing carries no pricing, and piCost() refuses an empty, partial
 *   or all-zero block for the same reason: pi's schema needs all four price
 *   fields if the key is there at all (committed artifacts contain zero
 *   `"cost": null` entries; `cost: null` would churn every artifact and may
 *   trip strict consumers)
 * @property {string} [api] per-model api override (pi docs/models.md) —
 *   set when the provider serves a MIXED api surface and the provider-wide
 *   dialect cannot route every model (docs/d048)
 * @property {string} [baseUrl] per-model base URL — set together with api
 *   when the listing names one per dialect: a mixed surface lives at a path
 *   per dialect, not at one provider root (docs/d048)
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
 * @property {PiModel[]} [models]
 */

/** @type {Readonly<LlmCompat>} */
const LLAMA_SWAP_COMPAT = Object.freeze({
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
});

/**
 * "[<mmprojMode>-]<org>/<repo>[:<quant>]" -> "Qwen3.8-27B UD-Q6_K"
 * @param {string} id
 * @returns {string|undefined} undefined for ids that don't follow the scheme
 *   (pi then falls back to the raw id)
 */
function displayName(id) {
	const m = /^([^-]+)-ctx(\d+)-(.+)$/.exec(id);
	if (!m) {
		return;
	}
	const [, , , repoFull] = m;
	// A matched line carries the group; the guard is the type gate's form.
	if (repoFull === undefined) {
		return;
	}
	const [repoPathRaw, quant] = repoFull.split(":");
	// split() always yields the first part; the fallback is unreachable.
	const repoPath = repoPathRaw ?? repoFull;
	const base = (repoPath.split("/").pop() ?? "").replace(/-GGUF$/i, "");
	return [base, quant].filter(Boolean).join(" ");
}

/** The one input modality every drivable model must accept (docs/d049). */
const PI_DRIVABLE_CORE = "text";

/**
 * THE pipeline-wide declaration of what the driving pi client can handle
 * (docs/d049): the input modal pi's own schema accepts, and the output
 * modalities it can consume. Eligibility (`modalitiesEligible`) and
 * projection (`toInput`) both derive from it — admit-but-trim, so the gate
 * and the emission read one source of truth and cannot drift.
 * PI_DRIVABLE_CORE is the drivable core: a client originates chat text, so
 * an input set without it can never be driven whatever else it offers.
 * @type {Readonly<{ input: readonly string[], output: readonly string[] }>}
 */
export const PI_MODALITY_CAPABILITY = Object.freeze({
	input: Object.freeze([PI_DRIVABLE_CORE, "image"]),
	output: Object.freeze(["text"]),
});

/**
 * models.dev's own retirement flag: `deprecated` is the one status meaning the
 * provider stopped serving the id, so publishing it offers a dead model.
 * `beta` and `alpha` are availability stages of live models and stay
 * (docs/d048).
 * @param {{ status?: string }|undefined} record
 * @returns {boolean}
 */
export function catalogModelLive(record) {
	return record?.status !== "deprecated";
}

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
 * @param {{ input?: string[]|undefined, output?: string[]|undefined }} [modalities]
 * @returns {boolean} false = the client cannot drive this record; drop it
 */
export function modalitiesEligible(modalities) {
	const input = modalities?.input;
	const output = modalities?.output;
	if (input && input.length > 0 && !input.includes(PI_DRIVABLE_CORE)) {
		return false;
	}
	if (
		output &&
		output.length > 0 &&
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
	return input.length > 0 ? input : [PI_DRIVABLE_CORE];
}

/**
 * THE "complete or absent" cost rule for pi model entries, shared by BOTH
 * price sources (llama-swap metadata through piModel, models.dev records
 * through toCost): pi's ModelCost schema
 * (https://pi.dev/schemas/models.schema.json) makes `cost` OPTIONAL but, the
 * moment it appears, requires all four price fields — so an empty or partial
 * block is a models.json pi refuses to load (the whole file is dropped, local
 * lineup and all), and "priced at nothing" is spelled by OMITTING the block.
 * llama-swap mirrors its config `metadata` verbatim and the local config
 * shipped `cost: {}` (v22.3, the block that replaced the 10/50/1/20
 * placeholder), so an upstream block is judged here rather than trusted:
 * complete the four fields, and publish nothing when no field is priced — an
 * all-zero block asserts a fact pi already assumes (docs/d057: prices are
 * absent, not zero).
 * @param {{input?: number|undefined, output?: number|undefined, cacheRead?: number|undefined, cacheWrite?: number|undefined}} [cost] the price block, if any
 * @returns {Cost|undefined} a complete four-field block, or undefined when
 *   nothing is priced — the caller drops the key
 */
export function piCost(cost) {
	if (!cost) {
		return;
	}
	const price = {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cacheRead ?? 0,
		cacheWrite: cost.cacheWrite ?? 0,
	};
	return Object.values(price).some((value) => value !== 0) ? price : undefined;
}

/**
 * pi's api vocabulary keyed by the DIALECT name a gateway's own model listing
 * uses (`api: { <dialect>: { base_url, sdk } }`). The dialect, not the ai-sdk
 * package, is the wire shape: `@ai-sdk/openai` serves both /chat/completions
 * and /responses, so only the dialect key says which one a model speaks
 * (docs/d048).
 * @type {Readonly<Record<string, string>>}
 */
const PI_API_BY_DIALECT = Object.freeze({
	"chat-completions": "openai-completions",
	responses: "openai-responses",
	messages: "anthropic-messages",
	"generate-content": "google-generative-ai",
});

/**
 * The one wire route a rich listing declares for a model: its pi api plus the
 * base URL that api needs. pi appends the endpoint to a base, so the anthropic
 * base drops the listing's /v1 (pi's own catalogs carry `.../anthropic`, the
 * base of /v1/messages) while the openai and google bases keep their version
 * segment. An absent or multi-dialect `api` block is no answer at all: the
 * model keeps the provider-wide dialect.
 * @param {RawModelEntry} entry
 * @returns {{ api: string, baseUrl: string }|null}
 */
function listingRoute(entry) {
	const dialects = Object.keys(entry.api ?? {});
	if (dialects.length !== 1) {
		return null;
	}
	const [dialect] = dialects;
	if (dialect === undefined) {
		return null;
	}
	const api = PI_API_BY_DIALECT[dialect];
	const baseUrl = entry.api?.[dialect]?.base_url;
	if (!api || !baseUrl) {
		return null;
	}
	return {
		api,
		baseUrl:
			api === "anthropic-messages"
				? baseUrl.replace(/\/v1$/, "")
				: baseUrl,
	};
}

/**
 * The typed input surface a rich listing declares, in pi's capability
 * vocabulary: the listing names MIME types (image/jpeg, application/pdf) while
 * toInput's deny-by-absence projection speaks only text and image. What pi
 * cannot drive (pdf, audio, video) is deliberately left for toInput to drop —
 * mapping is not judgement (docs/d049).
 * @param {string[]} [modalities]
 * @returns {string[]|undefined}
 */
function listingInput(modalities) {
	if (!Array.isArray(modalities) || modalities.length === 0) {
		return;
	}
	return modalities.map((m) => (m.startsWith("image/") ? "image" : m));
}

/**
 * A rich listing's price block in pi's shape: the base tier plus pi's
 * `cost.tiers` for the context-triggered overrides the listing publishes
 * (docs/d048). Completeness stays piCost's judgement, so an unpriced model
 * still publishes no cost block at all.
 * @param {RawModelEntry["cost"]} cost
 * @returns {PiCost|undefined}
 */
function listingCost(cost) {
	const text = cost?.text;
	const price = piCost({
		input: text?.input?.price,
		output: text?.output?.price,
		cacheRead: text?.input?.cache?.read,
		cacheWrite: text?.input?.cache?.write,
	});
	if (!price) {
		return;
	}
	const inputRows = text?.input?.overrides ?? [];
	const outputRows = text?.output?.overrides ?? [];
	const thresholds = [
		...new Set(
			[...inputRows, ...outputRows]
				.map((row) => row?.when?.context?.gt)
				.filter((limit) => typeof limit === "number"),
		),
	].sort((a, b) => a - b);
	if (thresholds.length === 0) {
		return price;
	}
	/** @param {any[]} rows @param {number} limit */
	const rowAt = (rows, limit) =>
		rows.find((row) => row?.when?.context?.gt === limit);
	return {
		...price,
		tiers: thresholds.map((limit) => {
			const inRow = rowAt(inputRows, limit);
			const outRow = rowAt(outputRows, limit);
			return {
				inputTokensAbove: limit,
				input: inRow?.price ?? price.input,
				output: outRow?.price ?? price.output,
				cacheRead: inRow?.cache?.read ?? price.cacheRead,
				cacheWrite: inRow?.cache?.write ?? price.cacheWrite,
			};
		}),
	};
}

/**
 * Mirror a raw /models entry into pi's model shape. Llama-swap's own metadata
 * wins where it speaks (the serving side declaring itself); the rich row a
 * first-party gateway serves fills what llama.cpp fields cannot express —
 * limits, tiers, the per-model wire route (docs/d048).
 * @param {RawModelEntry} entry
 * @returns {PiModel}
 */
export function piModel(entry) {
	const meta = entry.meta?.llamaswap;
	const route = listingRoute(entry);
	const contextWindow =
		meta?.contextWindow ??
		entry.context_length ??
		entry.meta?.n_ctx ??
		entry.limit?.context ??
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
			listingInput(entry.modalities?.input) ??
			(entry.capabilities?.vision ? ["text", "image"] : ["text"]),
	);
	// A price comes ONLY from a rich listing: llama-swap's mirrored metadata
	// carries none by construction (llm-local-inference/30-generate.mjs writes
	// reasoning/input/contextWindow/maxTokens and nothing else), so a cost
	// block there is not a source. Which is why the block is judged rather than
	// copied when it does arrive: an empty or all-zero listing block is the
	// same "no price" (piCost's rule, docs/d057/d190).
	const cost = listingCost(entry.cost);
	// A rich listing publishes the model name; llama-swap names its models in
	// its own metadata, so its entries keep the id-derived display fallback.
	const name = route ? entry.name : displayName(entry.id);
	// capabilities.reasoning is an object in a rich listing ({supported,
	// effort, toggle}) and a boolean on llama-swap metadata: only an explicit
	// supported:false means the model cannot think.
	const listed = entry.capabilities?.reasoning;
	const reasoning =
		meta?.reasoning ??
		(typeof listed === "object" ? listed?.supported : listed) ??
		true;
	return {
		id: entry.id,
		...(name ? { name } : {}),
		reasoning,
		input,
		contextWindow,
		maxTokens: meta?.maxTokens ?? entry.limit?.output ?? contextWindow,
		...(cost ? { cost } : {}),
		...(route ? { api: route.api, baseUrl: route.baseUrl } : {}),
	};
}

/**
 * The pi provider entry for the local farm (`baseUrl` — the tlalocayotl
 * instance's tsnet serve hostname) under the openai-completions protocol. The
 * compat block is set EXPLICITLY: the entry is hand-defined, so pi's
 * provider-composer must not auto-inherit the built-in `llama.cpp` provider's
 * compat — only `api`/`baseUrl` are inherited from builtin defaults.
 * `apiKey` is the literal "$TLALOCAYOTL_API_KEY": the tlalocayotl provider
 * row's own key (fact-table row `llama-swap`, its former name — earlier still
 * `bazzite`), which that instance demands and no cloud row uses. The caller
 * decides whether the reference is emitted (`includeApiKey`), so this builder
 * reads no env and answers only from its arguments.
 * @param {string} baseUrl
 * @param {PiModel[]} models
 * @param {boolean} includeApiKey emit the $TLALOCAYOTL_API_KEY reference
 * @returns {PiProvider}
 */
export function providerEntry(baseUrl, models, includeApiKey) {
	return {
		baseUrl: `${baseUrl}/v1`,
		api: "openai-completions",
		compat: LLAMA_SWAP_COMPAT,
		...(includeApiKey ? { apiKey: "$TLALOCAYOTL_API_KEY" } : {}),
		models,
	};
}

/**
 * A REROUTE-ONLY override for a provider pi ships NATIVELY (the
 * PI_NATIVE_CLOUD_IDS set): carries just the provider's canonical `baseUrl`
 * (the fact table's real upstream, written verbatim — docs/d070, d108) and the
 * models — deliberately NO `api`, NO `compat`, and NO `apiKey`.
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
 * encoded — which is what makes mistral's own wire format and google's native
 * dialect work without this table describing either (docs/d048).
 *
 * `apiKey` is likewise omitted: each provider's credential is pi's own
 * built-in per-provider auth (env key or OAuth, resolved at request time).
 * Only the local farm row carries a key reference, and it is that row's own
 * TLALOCAYOTL_API_KEY (providerEntry) — never a gateway-wide secret.
 * @param {string} providerUrl the provider's canonical upstream URL
 *   (fact table `baseUrl`, docs/d070 — no route form and no `/v1` append, so
 *   pi's own catalogs keep the paths they expect)
 * @param {PiModel[]} [models] the records this override publishes. OMITTED
 *   for a row whose surface no source can describe faithfully: pi's merge
 *   keeps its own built-in records (their api, limits and prices) and the
 *   override only changes WHERE requests go — an id-only record would
 *   replace a described model with a stub (docs/d048)
 * @returns {PiProvider}
 */
export function providerReroute(providerUrl, models) {
	return {
		baseUrl: providerUrl,
		...(models ? { models } : {}),
	};
}

