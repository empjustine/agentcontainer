/**
 * @fileoverview generate-pi-coding-agent.mjs — THE unified pi coding-agent
 * generator: the single entry point that produces every pi artifact — the
 * layered `model-*.json` overlays, the merged `models.json`, and the
 * operator's default-model overlay.
 *
 * Merged by target harness (docs/d037 chose a narrow merge; this is the broad
 * merge by coding agent that supersedes it). The four former stage generators
 * are no longer separate processes; their bodies live here in order:
 *
 *   1. `generateLocalLlamaSwap`  → `model-010-local-default.json`
 *      (ADDS the `llama-swap` provider for local GGUF; pi has no built-in one)
 *   2. `generateCloudProviders`  → `model-012-cloud-pi-native.json`
 *      (override-only: peer reroutes for unreachable endpoints, minimal
 *      models.dev ∪ catwalk id merges otherwise) plus
 *      `model-015/016/017-*.json` (full rows: the sole definition for
 *      providers pi does not ship; docs/d037/d033)
 *   3. `mergeModels`             → `models.json` (lexical layer order, deep
 *      merge)
 *   4. `generateDefaultModel`    → `default-model.json` (the operator's
 *      hardcoded pair — an OPERATOR DECISION, not a probed fact; docs/d036)
 *
 * THE LAYERED CAKE (the merge contract — this header is its single home; the
 * former merge-models-json.mjs header moved here): every `model-*.json` is a
 * `models.json`-shaped layer (`{ "providers": { "<id>": {...} } }`, or `{}`
 * for a no-op), and `mergeModels` reads every `model-*.json` in this script's
 * dir in **lexical filename order** — the zero-padded lexorank (`010`, `012`,
 * `015`, `016`, `017`) makes filename sort equal merge order:
 *
 * ```text
 * model-010-local-default.json
 *   + model-012-cloud-pi-native.json
 *   + model-015-cloud-cline-pass.json
 *   + model-016-cloud-hyper.json
 *   + model-017-cloud-inferx.json
 *   + model-020-peer-default.json   (future / drop-in)
 *   → models.json
 * ```
 *
 * Merge semantics: `providers` merge per provider id; within a provider,
 * objects (e.g. `compat`) recursively merge while scalars and arrays (e.g.
 * `baseUrl`, `models`) are REPLACED by the later layer. So a later layer
 * overrides a scalar and adds/replaces models without the earlier layer
 * knowing about it. A deployment picks its layers simply by placing the files
 * it wants next to this script — the collector reads whatever is present at
 * runtime.
 *
 * Each stage keeps its own failure domain: `runStage` catches a thrown stage
 * and the remaining stages still run, preserving the pre-merge behaviour where
 * `generate.mjs` spawned each stage as a child and warned on non-zero exit.
 *
 * `generate.mjs` (the folder driver) stages this file together with its
 * helper modules into a scratch dir, sets `LIB_DIR`, refreshes the models.dev
 * catalog, then runs this generator once — followed by the separate
 * opencode generator. The per-stage docs these bodies were folded from are
 * `docs/d024`, `docs/d033`, `docs/d037`.
 *
 * Usage: node generate-pi-coding-agent.mjs [models.json] [default-model.json]
 *   models.json defaults to $PI_MODELS_JSON else ./models.json.
 *   default-model.json defaults to $PI_DEFAULT_MODEL_JSON else
 *   ./default-model.json.
 *   Settings source for the default pair: $PI_SETTINGS else ./settings.json.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	bearerHeaders,
	CLOUD_PROVIDERS as CLOUD_PROVIDER_FACTS,
	fetchModelEntries,
	getCatwalkModels,
	loadHyperFacts,
	logInfo,
	logWarn,
	modelsDevCatalogPath,
	PI_NATIVE_CLOUD_IDS,
	peerBaseUrl,
	peerBaseUrls,
	peerProviderUrl,
	peersOnly,
	piModel,
	probeCandidates,
	probeDirect,
	probePeerRoutes,
	providerEntry,
	providerReroute,
	refreshCatwalkFacts,
	refreshHyperFacts,
	scriptDir,
	setLogTool,
	suppressedProbe,
	writeArtifact,
} from "./gen-lib.mjs";

setLogTool("coding-agent/generate-pi-coding-agent");

/**
 * Peer candidates — vault-sourced (peerBaseUrls(); see peer-probe.mjs).
 * Supports multi-hop proxy chains (PEER_BASE_URLS comma/newline delimited);
 * no localhost candidates — the LAN :8080 (proxy) and :8101 (llama-swap)
 * listen addresses are not routable from outside the serving host (docs/d022).
 * @type {readonly string[]}
 */
const CLOUD_PEER_CANDIDATES = peerBaseUrls();

/**
 * Catalog lookup order: a models.dev.api.json next to this script wins — when
 * run from generate.sh's scratch dir that entry is a symlink to the vendored
 * catalog which the best-effort refresh replaces with the freshly fetched
 * copy, so the generator always reads what this run validated. Manual
 * in-place runs fall back to the shared vendored catalog (docs/d023).
 * @type {string}
 */
const API_JSON = modelsDevCatalogPath();

// The vendored models.dev catalog parsed ONCE and shared by both modes
// (override-only uses it for bare-id fallbacks, full mode for the whole
// lineup). Absent ⇒ override-only rows still have catwalk; full rows fail
// their row (logged, layer untouched) exactly as the old generator did.
/** @type {Record<string, { api?: string, models?: Record<string, ModelsDevModel> }>|null} */
let CATALOG = null;
try {
	CATALOG = /** @type {typeof CATALOG} */ (
		JSON.parse(readFileSync(API_JSON, "utf-8"))
	);
} catch (err) {
	logWarn("models.dev catalog unreadable — full-mode rows cannot load", {
		path: API_JSON,
		error: err,
	});
}

/**
 * Per-provider scoping of the override's model list, applied to BOTH sources
 * (live peer listing and catalog fallback). These are the slices this fleet
 * can actually use — the llama-swap era encoded them on the SERVING side
 * (gen-lib's `filter`); with routing per provider the client scopes its own
 * override (docs/d033).
 *
 *   - openrouter: the ":free" slice (the same scope the peer always served).
 *   - mistral: chat-capable only — the catalog/listing also carries
 *     mistral-embed (embeddings) and voxtral-*-tts (speech).
 *   - google: a MODALITY allowlist, not a name denylist — pi drives text
 *     chat (its own input schema is text+image, docs/d046b), so a model
 *     stays iff it takes text in and produces text out. That one rule drops
 *     the image-output generators (out [text,image]), tts/live/lyria
 *     (out [text,audio]), veo/omni (out [video]) and the live-translate
 *     (in [audio]) — categories a name regex could only approximate, which
 *     is why the pre-catalogOnly filter leaked ids d033 claimed to drop.
 *     Two records still need a name check: models.dev labels the embedding
 *     endpoints out ["text"] (they are not chat), so `/embedding/` is
 *     refused before the modality test. No record (live-listing path —
 *     unreachable for a catalogOnly row) falls back to the old regex.
 * @type {Record<string, ((id: string, record?: ModelsDevModel) => boolean)|undefined>}
 */
const PEER_MODEL_FILTERS = {
	openrouter: (id) => id.endsWith(":free"),
	mistral: (id) => !/embed|tts/i.test(id),
	google: (id, record) => {
		if (/embedding/i.test(id)) return false;
		const input = record?.modalities?.input;
		const output = record?.modalities?.output;
		if (!input?.length || !output?.length) {
			return /^gemini-/.test(id) && !/(-image|-tts|-live|-computer-use)/i.test(id);
		}
		return input.includes("text") && output.length === 1 && output[0] === "text";
	},
};

/**
 * Provider spec rows for BOTH modes (docs/d037). One row = one emission
 * unit; adding a provider is a row here (full rows also need a merge-order
 * row in the layered-cake contract above — that contract lives in this file).
 * @typedef {object} CloudProviderSpec
 * @property {string} id models.dev provider key AND pi provider id
 * @property {'override-only'|'full'} mode emission semantic (see header)
 * @property {string} [name] display name for the pi provider block (full)
 * @property {string} [file] output layer filename (full; relative to script)
 * @property {string} envKey the provider's own key variable — read only for
 *   the probes; full rows reference it as `$<envKey>` in the emitted layer
 * @property {((id: string, record?: ModelsDevModel) => boolean)|undefined} [filter]
 *   model-id scoping (gen-lib's `filter`); the models.dev record is passed
 *   through when the source has one (name-only checks ignore it)
 *   (override-only — see PEER_MODEL_FILTERS below)
 * @property {{ supportsDeveloperRole: boolean }|null} compat provider-level
 *   compat pi cannot infer; null = no override (full)
 * @property {((m: ModelsDevModel) => Record<string, unknown>|null)|null} modelCompat
 *   builds the per-model compat mirror; null = none (full)
 * @property {boolean} onOffThinking swaps the all-null effort-less map for
 *   the ON_OFF representative map (full; see that constant)
 * @property {boolean} [enrichFromFacts] refresh + consume the hyper-facts
 *   cache (hyper only — the one provider with a non-models.dev cache)
 * @property {readonly string[]} [modelAllowlist] catalog-namespace model ids
 *   to restrict the catalog lineup to (full; docs/d040)
 * @property {boolean} [catalogOnly] the provider serves no model listing the
 *   probe could ever authenticate (google: /v1beta/models demands its own
 *   api-key parameter, not the bearer the probe sends, so every probe is a
 *   permanent 403) — no probes at all, the models.dev slice is the sole
 *   lineup source, and the catwalk union is skipped (override-only; docs/d033)
 * @property {((modelsDevModels: Record<string, ModelsDevModel>) => ReadonlyMap<string, string>) | undefined}
 *   [modelApiResolver] derives per-model pi `api` overrides from a published
 *   source; only the returned ids get one, every other model keeps the
 *   provider-wide default (full/override-only; docs/d048)
 * @property {((models: Record<string, ModelsDevModel>) => readonly string[]) | undefined}
 *   [modelAllowlistResolver] derives the allowlist from a published source,
 *   cross-checked against the provider's catalog slice; when present it
 *   replaces modelAllowlist at emit time (full; docs/d040)
 * @property {string} [modelIdPrefix] literal prefix every catalog model id
 *   must carry (full). Structural guard, not a scoping choice: models.dev
 *   intermittently mislabels `cline`-provider models under other provider
 *   keys, and the prefix is the provider's own API contract — a cline-pass
 *   id served without it bills at standard API pricing, not the subscription
 *   (docs/d040)
 * @property {boolean} [liveSync] when false, direct mode never syncs the
 *   lineup against the provider's live /models listing (full; docs/d040 —
 *   cline-pass's listing serves the `cline` provider's data)
 * @property {Record<string, string>} [headers] provider-level request headers
 */

/**
 * The ClinePass provider id — simultaneously the pi provider key, the
 * models.dev key, and the model-id namespace prefix the ClinePass API
 * requires to bill the subscription (docs/d040).
 */
const CLINE_PASS_ID = "cline-pass";

/**
 * Committed last-known-good lineup — the fallback for
 * resolveClinePassAllowlist below, transcribed from Cline's published table
 * (`docs/getting-started/clinepass.mdx` in the `~/cline/cline.git` mirror,
 * "Models" section). The live parse is preferred, so this constant only
 * matters on a broken-facts run (no mirror, or a failed agreement check);
 * docs/d040 owns the reconciliation contract.
 * @type {readonly string[]}
 */
const CLINE_PASS_LINEUP = /** @type {readonly string[]} */ (
	Object.freeze([
		"cline-pass/glm-5.3",
		"cline-pass/glm-5.2",
		"cline-pass/kimi-k3",
		"cline-pass/kimi-k2.7-code",
		"cline-pass/kimi-k2.6",
		"cline-pass/deepseek-v4-pro",
		"cline-pass/deepseek-v4-flash",
		"cline-pass/mimo-v2.5",
		"cline-pass/mimo-v2.5-pro",
		"cline-pass/minimax-m3",
		"cline-pass/qwen3.8-max",
		"cline-pass/qwen3.7-max",
		"cline-pass/qwen3.7-plus",
	])
);

/**
 * Minimum fraction of the published docs table that must also appear in the
 * models.dev cline-pass slice before either source is trusted (docs/d040).
 * models.dev intermittently dumps the whole `cline` catalog under
 * `cline-pass` — that collapse (and a reshaped docs table) drives the ratio
 * toward zero, so the committed fallback wins instead of a wrong-priced
 * lineup. Genuine lineup growth keeps the ratio near 1, so it self-adopts.
 */
const CLINE_PASS_MATCH_FLOOR = 0.8;

/**
 * Parse the `## Models` GFM table from Cline's published clinepass.mdx and
 * return the model ids WITH their `cline-pass/` prefix — the catalog
 * namespace and the id the layer publishes, so no consumer re-derives it.
 * Scoped to that section because the later
 * `## Reference pricing` table is a different shape (peak/off-peak and
 * token-tier rows with display-only names). Every accepted id must carry the
 * `cline-pass/` prefix — the published table doubles as the API-namespace
 * assertion. Returns null when the section is absent.
 * @param {string} mdx
 * @returns {string[]|null}
 */
function parseClinePassDocs(mdx) {
	const section = mdx.split(/^## Models\s*$/m)[1]?.split(/^## /m)[0];
	if (!section) return null;
	const ids = [];
	for (const line of section.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		const cells = trimmed
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		const raw = cells[1]?.replace(/`/g, "");
		if (raw?.startsWith(`${CLINE_PASS_ID}/`)) {
			ids.push(raw);
		}
	}
	return ids;
}

/**
 * Read one file out of a bare git-farm mirror, trying the mirror locations in
 * order: the explicit env override, the host machine's
 * `~/Downloads/references/github.com/<org>/<repo>.git` farm layout, then the
 * flat `~/<org>/<repo>.git` mirror. Each candidate gets the same bounded 15s
 * `git show`; the first readable mirror wins. A missing mirror is the normal
 * container case, so candidates are tried silently and only a TOTAL failure
 * warns (once, with every candidate listed).
 * @param {string|undefined} envMirror explicit mirror override (CLINE_MIRROR,
 *   OPENCODE_MIRROR, ...) — tried first, but a broken override still falls
 *   through to the farm defaults rather than failing the read
 * @param {string} orgRepo "<org>/<repo>" both farm layouts key on
 * @param {string} refPath the in-repo path handed to `git show HEAD:`
 * @param {string} warnContext log label on total failure
 * @returns {string|null}
 */
function readMirrorFile(envMirror, orgRepo, refPath, warnContext) {
	const candidates = [
		...(envMirror ? [envMirror] : []),
		join(homedir(), "Downloads", "references", "github.com", `${orgRepo}.git`),
		join(homedir(), `${orgRepo}.git`),
	];
	let lastError;
	for (const mirror of candidates) {
		try {
			return execFileSync(
				"git",
				["-C", mirror, "show", `HEAD:${refPath}`],
				{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
			);
		} catch (err) {
			lastError = err;
		}
	}
	logWarn(`${warnContext} — no mirror location readable`, {
		candidates,
		error: lastError,
	});
	return null;
}

/**
 * Read Cline's published clinepass.mdx. The git farm is machine-specific, so
 * this is best-effort and bounded: a missing mirror (the normal container
 * case) or a blob-less mirror without network fails fast and the caller
 * falls back. CLINE_PASS_MDX points at a plain file when there is no mirror;
 * CLINE_MIRROR overrides the mirror lookup (readMirrorFile: the
 * ~/Downloads/references/github.com farm first, then ~/cline/cline.git).
 * @returns {string|null}
 */
function readClinePassDocs() {
	const explicit = process.env.CLINE_PASS_MDX;
	if (explicit) {
		try {
			return readFileSync(explicit, "utf-8");
		} catch (err) {
			logWarn("cline-pass docs file unreadable", { path: explicit, error: err });
			return null;
		}
	}
	return readMirrorFile(
		process.env.CLINE_MIRROR,
		"cline/cline",
		"docs/getting-started/clinepass.mdx",
		"cline-pass docs mirror unreadable — using committed allowlist",
	);
}

/**
 * The cline-pass allowlist for this run: the UNION of Cline's published docs
 * table and the models.dev cline-pass slice when the two still agree, else
 * the committed fallback. The agreement floor is the self-check — it
 * protects against BOTH failure modes at once: a models.dev pollution dump
 * (docs models vanish from the slice) and a docs-table reshape (ids stop
 * parsing). Union, not docs-only, so catalog-first additions (new models
 * land in models.dev before the docs table updates) self-adopt while the
 * floor still guarantees the two sources describe the same provider. The
 * fallback is safe on top of that because the modelIdPrefix guard still
 * drops unprefixed ids, so a polluted slice yields no layer rather than a
 * wrong-priced one.
 * @param {Record<string, ModelsDevModel>} modelsDevModels the cline-pass slice
 * @returns {readonly string[]} catalog-namespace model ids
 */
function resolveClinePassAllowlist(modelsDevModels) {
	const docs = readClinePassDocs();
	const docsIds = docs ? parseClinePassDocs(docs) : null;
	if (!docsIds?.length) {
		logWarn("cline-pass docs lineup unavailable — using committed allowlist", {
			fallback: CLINE_PASS_LINEUP.length,
		});
		return CLINE_PASS_LINEUP;
	}
	const catalogKeys = new Set(
		Object.keys(modelsDevModels).filter((id) =>
			id.startsWith(`${CLINE_PASS_ID}/`),
		),
	);
	const matched = docsIds.filter((id) => catalogKeys.has(id));
	const ratio = matched.length / docsIds.length;
	if (ratio < CLINE_PASS_MATCH_FLOOR) {
		logWarn("cline-pass docs/models.dev disagree — keeping committed allowlist", {
			docs: docsIds.length,
			matched: matched.length,
			ratio,
			floor: CLINE_PASS_MATCH_FLOOR,
		});
		return CLINE_PASS_LINEUP;
	}
	/**
	 * Union: docs ids first (the published contract), then catalog-only ids
	 * (catalog-first additions the docs table has not caught up to) — the
	 * emitFullAt filter intersects with the catalog anyway, so docs-only ids
	 * simply find no record to emit.
	 */
	const union = [...new Set([...docsIds, ...catalogKeys])];
	logInfo("cline-pass lineup adopted as docs ∪ models.dev union", {
		docs: docsIds.length,
		matched: matched.length,
		catalogOnlyAdopted: catalogKeys.size - matched.length,
		union: union.length,
	});
	return union;
}

/**
 * The opencode-go provider id — simultaneously the pi provider key and the
 * models.dev key (its api.json slice is keyed bare, unlike cline-pass's
 * prefixed keys).
 */
const OPENCODE_GO_ID = "opencode-go";

/**
 * The ai-sdk package each opencode-go endpoint speaks, mapped to the pi api
 * type that requests that wire shape (pi docs/models.md). The go.mdx
 * endpoints table and the models.dev per-model `provider.npm` override use
 * the same package vocabulary, so one table maps both (docs/d048).
 * @type {Readonly<Record<string, string>>}
 */
const OPENCODE_GO_API_BY_PACKAGE = Object.freeze({
	"@ai-sdk/anthropic": "anthropic-messages",
	"@ai-sdk/openai": "openai-responses",
	"@ai-sdk/openai-compatible": "openai-completions",
});

/**
 * Same shape guarantee as CLINE_PASS_MATCH_FLOOR, for the opencode-go
 * endpoints table vs the models.dev opencode-go slice (docs/d048).
 * @type {number}
 */
const OPENCODE_GO_MATCH_FLOOR = 0.8;

/**
 * Parse the `## Endpoints` GFM table from opencode's published go.mdx into
 * bare model id → pi api type. Scoped to that section because the other
 * tables (usage limits, privacy) carry display names only. Cell layout:
 * | Model | Model ID | Endpoint | AI SDK Package | — the endpoint path
 * itself is redundant with the package column for pi's purposes, so only the
 * package is mapped. Returns null when the section is absent.
 * @param {string} mdx
 * @returns {Map<string, string>|null}
 */
function parseOpencodeGoEndpoints(mdx) {
	const section = mdx.split(/^## Endpoints\s*$/m)[1]?.split(/^## /m)[0];
	if (!section) return null;
	/** @type {Map<string, string>} */
	const apiById = new Map();
	for (const line of section.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		const cells = trimmed
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		const id = cells[1]?.replace(/`/g, "");
		const api = cells[3]
			? OPENCODE_GO_API_BY_PACKAGE[cells[3].replace(/`/g, "")]
			: undefined;
		if (id && api) apiById.set(id, api);
	}
	return apiById;
}

/**
 * Read opencode's published go.mdx. Same best-effort contract as
 * readClinePassDocs: OPENCODE_GO_MDX points at a plain file, OPENCODE_MIRROR
 * overrides the mirror lookup (readMirrorFile: the
 * ~/Downloads/references/github.com farm first, then
 * ~/anomalyco/opencode.git; the mirror's HEAD must be the dev branch), and
 * a missing mirror or blob-less mirror without network fails fast into the
 * bounded 15s timeout.
 * @returns {string|null}
 */
function readOpencodeGoDocs() {
	const explicit = process.env.OPENCODE_GO_MDX;
	if (explicit) {
		try {
			return readFileSync(explicit, "utf-8");
		} catch (err) {
			logWarn("opencode-go docs file unreadable", { path: explicit, error: err });
			return null;
		}
	}
	return readMirrorFile(
		process.env.OPENCODE_MIRROR,
		"anomalyco/opencode",
		"packages/web/src/content/docs/go.mdx",
		"opencode-go docs mirror unreadable — no per-model api overrides",
	);
}

/**
 * The per-model pi `api` overrides for opencode-go, whose single base URL
 * serves a MIXED api surface (/chat/completions, /responses, /messages per
 * model) — a provider-wide dialect cannot route the lineup, so models need
 * pi's model-level `api`. Two published sources, self-checked like
 * resolveClinePassAllowlist: opencode's endpoints table (the contract) and
 * the models.dev per-model `provider.npm` override (upstream: the anomalyco
 * models.dev fork's providers/opencode-go/models/*.toml). At or above
 * OPENCODE_GO_MATCH_FLOOR the union is adopted — docs wins on conflict, the
 * catalog npm fills catalog-only ids; below it (or with no docs source at
 * all) the map comes back EMPTY, which is exactly the pre-resolver behavior:
 * every model on pi's provider-wide default. An empty map is the safe
 * failure, not a wrong-shaped request.
 * @param {Record<string, ModelsDevModel>} modelsDevModels the opencode-go slice
 * @returns {ReadonlyMap<string, string>} bare model id → pi api type
 */
function resolveOpencodeGoApi(modelsDevModels) {
	const docs = readOpencodeGoDocs();
	const docsApi = docs ? parseOpencodeGoEndpoints(docs) : null;
	if (!docsApi?.size) {
		logWarn("opencode-go endpoints table unavailable — every model keeps the provider-wide default api", {});
		return new Map();
	}
	const catalogKeys = new Set(Object.keys(modelsDevModels));
	const matched = [...docsApi.keys()].filter((id) => catalogKeys.has(id));
	const ratio = matched.length / docsApi.size;
	if (ratio < OPENCODE_GO_MATCH_FLOOR) {
		logWarn("opencode-go docs/models.dev disagree — no per-model api overrides", {
			docs: docsApi.size,
			matched: matched.length,
			ratio,
			floor: OPENCODE_GO_MATCH_FLOOR,
		});
		return new Map();
	}
	const apiById = new Map(docsApi);
	let catalogOnlyAdopted = 0;
	let conflicts = 0;
	let unmapped = 0;
	for (const [id, m] of Object.entries(modelsDevModels)) {
		const npm = m.provider?.npm;
		const api = npm ? OPENCODE_GO_API_BY_PACKAGE[npm] : undefined;
		if (npm && !api) unmapped++;
		if (docsApi.has(id)) {
			if (api && api !== docsApi.get(id)) conflicts++;
		} else if (api) {
			apiById.set(id, api);
			catalogOnlyAdopted++;
		}
	}
	logInfo("opencode-go per-model api overrides adopted", {
		docs: docsApi.size,
		matched: matched.length,
		catalogOnlyAdopted,
		conflicts,
		unmapped,
		union: apiById.size,
	});
	if (conflicts || unmapped) {
		logWarn("opencode-go api sources disagree — docs table wins", {
			conflicts,
			unmapped,
		});
	}
	return apiById;
}

/**
 * Attach the spec's per-model `api` overrides (when it has a resolver) to
 * already-built model records. Ids the resolver does not know keep pi's
 * provider-wide default — the override-only rows deliberately omit
 * provider-level `api` so pi's built-in dialect stays in charge.
 * @param {CloudProviderSpec} spec
 * @param {import("./gen-lib.mjs").PiModel[]} models
 * @returns {void}
 */
function applyModelApi(spec, models) {
	if (!spec.modelApiResolver) return;
	const apiById = spec.modelApiResolver(CATALOG?.[spec.id]?.models ?? {});
	for (const m of models) {
		const api = apiById.get(m.id);
		if (api) m.api = api;
	}
}

/** @type {CloudProviderSpec[]} */
const PROVIDER_SPECS = [
	// --- override-only: the pi-native set (fact table owns the base URL) ---
	...PI_NATIVE_CLOUD_IDS.map(
		(id) =>
			/** @type {CloudProviderSpec} */ ({
				id,
				mode: "override-only",
				envKey: CLOUD_PROVIDER_FACTS[id].apiKeyEnv,
				filter: PEER_MODEL_FILTERS[id],
				// opencode-go is the one pi-native provider with a MIXED api
				// surface behind one base URL — it needs per-model api overrides
				// from the published endpoints table (docs/d048).
				...(id === OPENCODE_GO_ID
					? { modelApiResolver: resolveOpencodeGoApi }
					: {}),
				// google publishes no models endpoint the probe can authenticate
				// (its /v1beta/models reads an api-key param, not a bearer) — the
				// models.dev google slice is the lineup source, probes are wasted
				// 8s and a misleading "auth" verdict (docs/d033).
				...(id === "google" ? { catalogOnly: true } : {}),
			}),
	),
	// --- full: providers pi does not ship natively (docs/d024) ---
	{
		id: CLINE_PASS_ID,
		mode: "full",
		name: "ClinePass",
		file: "model-015-cloud-cline-pass.json",
		envKey: "CLINE_API_KEY",
		// ClinePass rejects the `developer` role pi-ai emits for reasoning
		// models: both reference extensions force it off (docs/d033).
		compat: { supportsDeveloperRole: false },
		modelCompat: null,
		onOffThinking: false,
		// The live /models listing at api.cline.bot serves the `cline`
		// (usage-billing) provider's catalog — a different provider's data, so
		// syncing against it would prune the real lineup and append 400+ wrong
		// ids. The published ClinePass table is the contract instead (docs/d040).
		modelIdPrefix: `${CLINE_PASS_ID}/`,
		modelAllowlist: CLINE_PASS_LINEUP,
		modelAllowlistResolver: resolveClinePassAllowlist,
		liveSync: false,
	},
	{
		id: "hyper",
		mode: "full",
		name: "Charm Hyper",
		file: "model-016-cloud-hyper.json",
		envKey: "HYPER_API_KEY",
		// Standard OpenAI-compatible gateway: the vendor extension accepts the
		// default role handling, so no provider-level compat override.
		compat: null,
		// Per-model compat mirror of charmbracelet/pi-hyper-provider
		// src/models.ts: the full block on EVERY model, exactly like the
		// extension (docs/d033).
		modelCompat: (m) => ({
			supportsStore: false,
			supportsReasoningEffort: effortValues(m).size > 0,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		}),
		// Pair the deepseek thinking format with the ON_OFF map for
		// effort-less reasoning models — see ON_OFF_THINKING_LEVEL_MAP.
		onOffThinking: true,
		// The one non-models.dev enrichment source: refresh + consume
		// hyper-facts (docs/d033).
		enrichFromFacts: true,
		headers: {
			// Mirror of the extension's "pi-hyper-provider/<version>" UA
			// (models.json headers are static literals; versioning is
			// extension-only).
			"User-Agent": "pi-hyper-models-layer/1",
		},
	},
	{
		id: "inferx",
		mode: "full",
		name: "InferX",
		file: "model-017-cloud-inferx.json",
		envKey: "INFERX_API_KEY",
		// Plain OpenAI-compatible gateway (models.dev:
		// @ai-sdk/openai-compatible): no developer-role quirk (unlike
		// cline-pass), no per-model wire-compat mirror (unlike hyper) — pi's
		// defaults are correct as-is.
		compat: null,
		modelCompat: null,
		// Reasoning models expose only a `toggle` option (no effort enum), so
		// there is nothing to map: no thinkingLevelMap, no ON_OFF fallback —
		// pi's default on/off handling covers them.
		onOffThinking: false,
	},
];

/**
 * Map models.dev `reasoning_options` effort values onto pi thinking levels
 * (off, minimal, low, medium, high, xhigh, max). ClinePass exposes enums like
 * ["none","low","medium","high","xhigh"] and Hyper (e.g. inkling) like
 * ["none","minimal","low","medium","high","xhigh"]; "none" disables thinking
 * (pi "off"), the rest map 1:1. Levels absent from the provider enum are
 * marked unsupported (null) so they are hidden in /model and pi never sends
 * an out-of-enum value (docs/d033).
 * @type {Record<string, string>}
 */
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

/**
 * Thinking map for reasoning models that expose NO effort enum (Hyper's
 * glm-5, kimi-k2-thinking, ...): the charmbracelet/pi-hyper-provider
 * ON_OFF_THINKING_LEVEL_MAP — pi "max" is the single representative "on"
 * state, "off" disables thinking. Only valid for providers that pair it
 * with thinkingFormat: "deepseek" + supportsReasoningEffort: false (the
 * wire translation then drops efforts entirely).
 * @type {Readonly<Record<string, string|null>>}
 */
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
 * exposes none). Accepts any record carrying `reasoning_options` (full
 * models.dev records as well as the bare shape buildThinkingLevelMap passes).
 * @param {{ reasoning_options?: Array<{ type?: string, values?: string[] }> }} m
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
	if (!cost) return { input: 10, output: 50, cacheRead: 1, cacheWrite: 20 };
	return {
		input: cost.input ?? 10,
		output: cost.output ?? 50,
		cacheRead: cost.cache_read ?? 1,
		cacheWrite: cost.cache_write ?? 20,
	};
}

/**
 * A models.dev model record — the subset the full mode reads.
 * @typedef {object} ModelsDevModel
 * @property {string} id
 * @property {string} [name]
 * @property {string} [family]
 * @property {boolean} [reasoning]
 * @property {{ input?: string[], output?: string[] }} [modalities]
 * @property {{ context?: number, output?: number }} [limit]
 * @property {{ input?: number, output?: number, cache_read?: number, cache_write?: number }} [cost]
 * @property {Array<{ type?: string, values?: string[] }>} [reasoning_options]
 * @property {{ npm?: string }|null} [provider] per-model api surface override
 *   (models.dev mirrors the anomalyco fork's providers/<id>/models/*.toml
 *   `[provider] npm = ...`; the package name is the api-shape vocabulary,
 *   docs/d048)
 */

/**
 * A pi-shaped model entry as the full mode publishes it. Only the first
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
 * A models.json provider layer for one full-mode provider.
 * @typedef {object} ProviderBlock
 * @property {Record<string, { name: string, baseUrl: string, api: string, apiKey: string, authHeader?: boolean, headers?: Record<string, string>, compat?: { supportsDeveloperRole: boolean }, models: PiAlternativeModel[] }>} providers
 */

/**
 * Build the pi-shaped model entry for one models.dev model of provider
 * `spec.id`. `id` is the fully-qualified model id to publish; the default
 * keeps the catalog's own id (ClinePass catalog ids are already
 * `cline-pass/<modelId>`; Hyper's are bare — both are published verbatim in
 * direct mode, since pi namespaces them under the provider id itself).
 * Distinct from gen-lib's `piModel` on purpose: that one
 * mirrors a RAW /models entry, this one derives from a full models.dev
 * record incl. thinkingLevelMap/compat (docs/d033).
 * @param {CloudProviderSpec} spec the provider spec row
 * @param {ModelsDevModel} m a models.dev model record
 * @param {string} [id] the id to publish (defaults to the record's own id)
 * @returns {PiAlternativeModel|null} a pi model entry, or null for an
 *   embedding model (pi cannot drive one)
 */
function catalogPiModel(spec, m, id = m.id) {
	if (m.family === "text-embedding" || id.toLowerCase().includes("embedding"))
		return null;
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
		const thinking =
			map ?? (spec.onOffThinking ? { ...ON_OFF_THINKING_LEVEL_MAP } : null);
		if (thinking) model.thinkingLevelMap = thinking;
	}
	const compat = spec.modelCompat?.(m);
	if (compat) model.compat = compat;
	return model;
}

/**
 * Load one full-mode provider's slice of the (once-parsed) models.dev
 * catalog. Catwalk is NOT a fallback here: it carries none of the
 * alternative providers (docs/d028 coverage gap — hyper/cline-pass/inferx
 * are absent).
 * @param {CloudProviderSpec} spec the provider spec row
 * @returns {{ api: string, models: Record<string, ModelsDevModel> }} the
 *   provider record (api endpoint + per-model metadata)
 */
function loadProvider(spec) {
	if (!CATALOG) {
		throw Object.assign(new Error("models.dev catalog unreadable"), {
			path: API_JSON,
		});
	}
	const provider = CATALOG[spec.id];
	if (!provider?.models) {
		throw Object.assign(
			new Error("provider not found in the models.dev catalog"),
			{ provider: spec.id, path: API_JSON },
		);
	}
	return /** @type {{ api: string, models: Record<string, ModelsDevModel> }} */ (
		provider
	);
}

/**
 * Build the provider block routed at `baseUrl` with the given key/auth.
 * @param {CloudProviderSpec} spec the provider spec row
 * @param {string} baseUrl
 * @param {PiAlternativeModel[]} models
 * @param {{ apiKey: string, authHeader?: boolean }} auth
 * @returns {ProviderBlock} a models.json provider layer for the provider
 */
function providerBlock(spec, baseUrl, models, auth) {
	return {
		providers: {
			[spec.id]: {
				name: /** @type {string} */ (spec.name),
				baseUrl,
				api: "openai-completions",
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
 * Rebuild a raw hyper-facts (live /provider) record as a models.dev-shaped
 * model record, so the enrichment reuses catalogPiModel()'s full derivation
 * (input, costs, effort-enum → thinkingLevelMap/compat). Fields pi models but
 * the live record lacks stay undefined → catalogPiModel()'s defaults; the
 * display name is overridden back to the models.dev one by the enricher
 * (names stay catalog — see the header whitelist note).
 * @param {import("./hyper-facts.mjs").HyperProviderModel} l a raw live /provider record
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
 * Enrich pi-shaped models with the provider's live /models listing.
 * This is used to prune models no longer served and add new ones found live
 * but missing from the catalog. Since live entries lack full metadata,
 * new models are published as minimal entries (pi defaults).
 * @param {CloudProviderSpec} spec
 * @param {PiAlternativeModel[]} models the current catalog-derived lineup
 * @param {import("./peer-probe.mjs").RawModelEntry[]} liveEntries the listing from the provider's /models endpoint
 * @returns {PiAlternativeModel[]} the pruned and augmented lineup
 */
function enrichWithLiveListing(spec, models, liveEntries) {
	const liveIds = new Set(liveEntries.map((e) => e.id));
	const catalogIds = new Set(models.map((m) => m.id));

	const pruned = models.filter((m) => liveIds.has(m.id));

	const liveOnly = liveEntries
		.filter((e) => !catalogIds.has(e.id))
		.map((e) => {
			const m = {
				id: e.id,
				name: e.name ?? e.id,
			};
			return catalogPiModel(spec, m);
		})
		.filter((m) => m !== null);

	return [...pruned, ...liveOnly];
}

/**
 * Enrich pi-shaped models with the hyper facts cache: rebuild every model
 * whose id is in the live records through catalogPiModel()
 * on LIVE data, keeping the models.dev display name (see the header
 * whitelist). Models absent from the cache pass through untouched; live-only
 * records are returned for the caller to append (direct mode appends them,
 * peer mode appends only ids the peer actually serves).
 * @param {CloudProviderSpec} spec
 * @param {PiAlternativeModel[]} models the models to enrich
 * @param {import("./hyper-facts.mjs").LoadedHyperFacts} facts loaded cache
 * @returns {{ enriched: PiAlternativeModel[], liveOnly: ModelsDevModel[], untouched: PiAlternativeModel[] }}
 */
function enrichWithFacts(spec, models, facts) {
	const live = new Map(facts.models.map((l) => [l.id, l]));
	/** @type {PiAlternativeModel[]} */
	const enriched = [];
	/** @type {PiAlternativeModel[]} */
	const untouched = [];
	for (const m of models) {
		const l = live.get(m.id);
		if (!l) {
			untouched.push(m);
			continue;
		}
		const merged = { ...liveToCatalogRecord(l), name: m.name };
		const rebuilt = catalogPiModel(spec, merged, m.id);
		if (rebuilt) enriched.push(rebuilt);
	}
	const servedIds = new Set(models.map((m) => m.id));
	const liveOnly = facts.models
		.filter((l) => !servedIds.has(l.id))
		.map((l) => liveToCatalogRecord(l));
	return { enriched, liveOnly, untouched };
}

/**
 * The scoped model-id list for one override-only row from the (once-parsed)
 * models.dev catalog, or null when the catalog has no usable slice for it.
 * Falls back to catwalk when models.dev is stale (docs/d033 model-list
 * priority).
 * @param {CloudProviderSpec} spec
 * @returns {string[]|null}
 */
function catalogModelIds(spec) {
	const models = CATALOG?.[spec.id]?.models ?? {};
	const filter = spec.filter;
	const ids = Object.keys(models).filter(
		(mid) => filter?.(mid, models[mid]) ?? true,
	);
	if (ids.length) return ids;

	/**
	 * Catwalk fallback: openrouter→openrouter, opencode→opencode-zen,
	 * google→gemini. nvidia/mistral have no catwalk entry.
	 */
	const catwalkModels = getCatwalkModels(spec.id);
	if (catwalkModels) {
		const cids = catwalkModels
			.map((m) => m.id)
			.filter((mid) => filter?.(mid) ?? true);
		if (cids.length) {
			logInfo("model IDs from catwalk fallback", {
				provider: spec.id,
				models: cids.length,
			});
			return cids;
		}
	}

	logWarn("no model list available from models.dev or catwalk", {
		provider: spec.id,
	});
	return null;
}

/**
 * The override's models for one row, from the peer route's live listing.
 * Returns null when the listing yields nothing usable (the caller falls back
 * to the catalog).
 * @param {import("./peer-probe.mjs").RawModelEntry[]} entries
 * @param {CloudProviderSpec} spec
 * @returns {import("./gen-lib.mjs").PiModel[]|null}
 */
function listingModels(entries, spec) {
	const filter = spec.filter;
	const models = entries.filter((e) => filter?.(e.id) ?? true).map(piModel);
	return models.length ? models : null;
}

/**
 * The no-reroute override for a reachable (or route-less) pi-native row: the
 * fact-table base URL — identical to pi's built-in, so the built-in dialect
 * and auth carry over — plus the models.dev ∪ catwalk id list as minimal
 * records. Without this, a host that needs no peers writes an empty model-012
 * layer and the merged artifact (and the committed snapshot it writes back)
 * erases the pi-native providers entirely (docs/d033). pi's merge semantics
 * keep it safe: a matching id replaces the built-in record, a new id is
 * added, and the rest of the built-in lineup survives.
 * @param {CloudProviderSpec} spec
 * @param {Record<string, import("./gen-lib.mjs").PiProvider>} providers
 * @returns {void}
 */
function emitMinimalCatalogOverride(spec, providers) {
	const filter = spec.filter;
	const modelsDevModels = CATALOG?.[spec.id]?.models ?? {};
	const ids = new Set(
		Object.keys(modelsDevModels).filter(
			(mid) => filter?.(mid, modelsDevModels[mid]) ?? true,
		),
	);
	// The catwalk union is skipped for catalogOnly rows: their lineup
	// contract is the models.dev slice alone (google, docs/d033) — catwalk's
	// gemini view is a rendering of the same upstream, not an independent
	// source to union in.
	if (!spec.catalogOnly) {
		for (const m of getCatwalkModels(spec.id) ?? []) {
			if (filter?.(m.id) ?? true) ids.add(m.id);
		}
	}
	if (!ids.size) {
		logWarn("no model list available — no minimal override", {
			provider: spec.id,
		});
		return;
	}
	const models = [...ids].map((mid) => piModel({ id: mid }));
	applyModelApi(spec, models);
	providers[spec.id] = providerReroute(
		CLOUD_PROVIDER_FACTS[spec.id].baseUrl,
		models,
	);
	logInfo("minimal catalog override — built-in routing kept, ids merged", {
		provider: spec.id,
		models: ids.size,
	});
}

/**
 * Run the override-only cascade for one pi-native row and record its entry
 * in `providers`: a peer reroute when the direct endpoint is unreachable and
 * a peer path-route is usable, else the minimal catalog override above — a
 * reachable endpoint never erases the provider from the merged artifact
 * (docs/d033).
 * @param {CloudProviderSpec} spec
 * @param {Record<string, import("./gen-lib.mjs").PiProvider>} providers
 * @returns {Promise<void>}
 */
async function emitOverrideOnly(spec, providers) {
	const facts = CLOUD_PROVIDER_FACTS[spec.id];
	const headers = bearerHeaders(process.env[spec.envKey]?.trim());

	// catalogOnly rows never probe (docs/d033): the endpoint cannot
	// authenticate the probe's bearer, so no probe outcome means anything —
	// "credential-gated" would be a misleading verdict for an endpoint that
	// would 403 even with the key in hand. The models.dev slice IS the
	// lineup source.
	if (spec.catalogOnly) {
		logInfo("catalog-only provider — models.dev slice is the lineup source", {
			provider: spec.id,
		});
		emitMinimalCatalogOverride(spec, providers);
		return;
	}

	// PEERS_ONLY=1 (docs/d033): the operator declared the cloud unreachable
	// from this host — never probe the provider's real endpoint (a blocked
	// cloud costs the full 8s probe timeout per provider), go straight to the
	// peer path-route cascade.
	if (peersOnly()) {
		logInfo("PEERS_ONLY — skipping direct probe, probing peer path-route", {
			provider: spec.id,
		});
	} else {
		const direct = await probeDirect(facts.baseUrl, headers);
		if (direct.result !== "unreachable") {
			if (direct.result === "auth") {
				// Not a routing problem: the endpoint answered and refused our
				// (absent) credentials — pi authenticates itself at request time.
				logInfo(
					"default endpoint reachable but credential-gated — keeping built-in routing",
					{ provider: spec.id, error: direct.error },
				);
			} else if (direct.result === "ok") {
				logInfo("default endpoint reachable — keeping built-in routing", {
					provider: spec.id,
				});
			} else {
				// The demotion itself carries the evidence: expectation as the
				// SuppressedError's message label, the probe's failure chained, the
				// classification attached — the record is self-sufficient
				// (docs/d045).
				logWarn(
					"default endpoint reachable but answered unexpectedly — keeping built-in routing",
					{
						provider: spec.id,
						error: suppressedProbe(
							direct,
							"expected a usable /models listing from the default endpoint",
						),
					},
				);
			}
			emitMinimalCatalogOverride(spec, providers);
			return;
		}
		logInfo("default endpoint unreachable — probing peer path-route", {
			provider: spec.id,
			error: direct.error,
		});
	}
	const route = await probePeerRoutes(CLOUD_PEER_CANDIDATES, spec.id, headers);
	if (!route) {
		logWarn("no usable peer path-route — provider left on built-in routing", {
			provider: spec.id,
		});
		emitMinimalCatalogOverride(spec, providers);
		return;
	}
	const models = listingModels(route.entries, spec);
	if (models) {
		applyModelApi(spec, models);
		logInfo("override models from live peer listing", {
			provider: spec.id,
			models: models.length,
		});
		providers[spec.id] = providerReroute(route.url, models);
		return;
	}
	/**
	 * Route proved but not listable (401/403 without a key, or an unexpected
	 * answer): the catalog mirrors the provider's own ids.
	 */
	const ids = catalogModelIds(spec);
	if (!ids) {
		logWarn("no model list available — skipping", { provider: spec.id });
		return;
	}
	logInfo("override models from models.dev catalog fallback", {
		provider: spec.id,
		models: ids.length,
	});
	const fallbackModels = ids.map((mid) => piModel({ id: mid }));
	applyModelApi(spec, fallbackModels);
	providers[spec.id] = providerReroute(route.url, fallbackModels);
}

/**
 * Run the full-mode cascade for one alternative row and write its layer file.
 * The full block is emitted in BOTH modes — direct at the real endpoint
 * (with live-listing sync when the provider's key is in the environment)
 * or peer at the route URL with the catalog lineup; the layer IS the
 * provider definition, an empty layer would leave pi with nothing (docs/d033).
 * @param {CloudProviderSpec} spec
 * @returns {Promise<void>}
 */
async function emitFull(spec) {
	const provider = loadProvider(spec);
	const headers = bearerHeaders(process.env[spec.envKey]?.trim());

	// PEERS_ONLY=1 — same skip as emitOverrideOnly (docs/d033): the full block
	// is emitted at the peer path-route directly, no cloud probe.
	if (peersOnly()) {
		logInfo("PEERS_ONLY — skipping direct probe, probing peer path-route", {
			provider: spec.id,
		});
	} else {
		const direct = await probeDirect(provider.api, headers);
		if (direct.result !== "unreachable") {
			if (direct.result === "auth") {
				// Reachable but refusing our probe credentials: the endpoint is
				// fine — still route direct (pi authenticates at request time).
				logInfo(
					"default endpoint reachable but credential-gated — routing direct",
					{ provider: spec.id, error: direct.error },
				);
			} else if (direct.result === "ok") {
				logInfo("default endpoint reachable — routing direct", {
					provider: spec.id,
				});
			} else {
				// Same SuppressedError composition as the override-only path above.
				logWarn(
					"default endpoint reachable but answered unexpectedly — routing direct",
					{
						provider: spec.id,
						error: suppressedProbe(
							direct,
							"expected a usable /models listing from the default endpoint",
						),
					},
				);
			}
			return emitFullAt(
				spec,
				provider,
				provider.api,
				{ apiKey: `$${spec.envKey}`, authHeader: true },
				true,
			);
		}
		logInfo("default endpoint unreachable — probing peer path-route", {
			provider: spec.id,
			error: direct.error,
		});
	}
	const route = await probePeerRoutes(CLOUD_PEER_CANDIDATES, spec.id, headers);
	if (!route) {
		logWarn("no usable peer path-route — no layer written", {
			provider: spec.id,
		});
		return;
	}
	return emitFullAt(
		spec,
		provider,
		route.url,
		{ apiKey: `$${spec.envKey}`, authHeader: true },
		false,
	);
}

/**
 * Write one full-mode layer at `baseUrl`, shaped by `directMode`:
 * direct mode syncs the lineup against the live listing (when the provider's
 * key is in the environment) and, for hyper, appends live-only records;
 * peer mode keeps the catalog lineup, restricted to the ids the peer route
 * actually serves.
 * @param {CloudProviderSpec} spec
 * @param {{ api: string, models: Record<string, ModelsDevModel> }} provider
 * @param {string} baseUrl
 * @param {{ apiKey: string, authHeader?: boolean }} auth
 * @param {boolean} directMode
 * @returns {Promise<void>}
 */
async function emitFullAt(spec, provider, baseUrl, auth, directMode) {
	const allow = spec.modelAllowlistResolver
		? spec.modelAllowlistResolver(provider.models)
		: spec.modelAllowlist;
	const catalogModels = Object.entries(provider.models)
		.filter(
			([id]) =>
				(!spec.modelIdPrefix || id.startsWith(spec.modelIdPrefix)) &&
				(!allow || allow.includes(id)),
		)
		.map(([, m]) => m);
	/** @type {PiAlternativeModel[]} */
	let models = catalogModels
		.map((m) => catalogPiModel(spec, m))
		.filter((m) => m !== null);

	// Direct mode only: sync the catalog lineup against the live listing when
	// the provider's key is available — prunes retired ids, appends live-only
	// ones (minimal entries; the listing carries no metadata). Peer mode has
	// no lineup source beyond the catalog (the providers' own listings mirror
	// passthrough catalogs that do not match their models.dev lineups).
	if (
		directMode &&
		spec.liveSync !== false &&
		process.env[spec.envKey]?.trim()
	) {
		try {
			const liveEntries = await fetchModelEntries(
				provider.api,
				bearerHeaders(process.env[spec.envKey]?.trim()),
			);
			models = enrichWithLiveListing(spec, models, liveEntries);
			logInfo("lineup synchronized with live /models listing", {
				provider: spec.id,
				liveCount: liveEntries.length,
				finalCount: models.length,
			});
		} catch (err) {
			logWarn("live listing fetch failed — falling back to catalog", {
				provider: spec.id,
				error: err,
			});
		}
	}

	if (spec.enrichFromFacts) {
		// refreshHyperFacts tries the provider endpoint, then every multi-hop
		// peer candidate (docs/d034), then falls back to the last good cache;
		// passing the API url keeps the multi-hop walk pointed at the right
		// provider path. In PEER mode the direct endpoint already proved
		// unreachable — that is why the cascade routed through the peer — so
		// re-probing it in the refresh is just a wasted timeout: skip that leg
		// (peer-only walk).
		await refreshHyperFacts(provider.api, !directMode);
		const facts = loadHyperFacts();
		if (facts) {
			const { enriched, liveOnly, untouched } = enrichWithFacts(
				spec,
				models,
				facts,
			);
			models = [...enriched, ...untouched];
			if (directMode && liveOnly.length) {
				// Direct mode serves everything the provider offers, including
				// records the catalog does not know yet; peer mode stays on the
				// catalog (enriched) — the router does not gate ids, but its
				// upstream may not carry a record the catalog lacks.
				models = [
					...models,
					...liveOnly
						.map((l) => catalogPiModel(spec, l, l.id))
						.filter((m) => m !== null),
				];
			}
			logInfo("enriched from facts cache", {
				provider: spec.id,
				fetchedAt: facts.fetchedAt,
				ageMs: facts.ageMs,
				enriched: enriched.length,
				...(directMode ? { liveOnlyAppended: liveOnly.length } : {}),
				catalogOnlyKept: untouched.length,
			});
		} else {
			logWarn("facts cache unavailable — using catalog metadata", {
				provider: spec.id,
			});
		}
	}

	if (!models.length) {
		logWarn("no models resolved — no layer written", { provider: spec.id });
		return;
	}
	const written = writeArtifact(
		join(scriptDir, /** @type {string} */ (spec.file)),
		`${JSON.stringify(providerBlock(spec, baseUrl, models, auth), null, 2)}\n`,
	);
	logInfo("provider layer written", {
		provider: spec.id,
		path: written,
		baseUrl,
		models: models.length,
		mode: directMode ? "direct" : "peer",
	});
}

/** @returns {Promise<void>} */
async function generateCloudProviders() {
	// Best-effort cache refresh before the cascade reads it (order is
	// irrelevant — it only writes lib caches; a failing refresh must not fail
	// generation). Hyper's refresh is NOT here: it belongs to the hyper row's
	// emit path, which passes the provider's own API url so the multi-hop
	// walk (docs/d034) stays pointed at the right provider path.
	await Promise.allSettled([refreshCatwalkFacts()]);

	/** @type {Record<string, import("./gen-lib.mjs").PiProvider>} */
	const providers = {};
	const results = await Promise.allSettled(
		PROVIDER_SPECS.map((spec) =>
			spec.mode === "full" ? emitFull(spec) : emitOverrideOnly(spec, providers),
		),
	);
	results.forEach((res, i) => {
		if (res.status === "rejected") {
			logWarn("provider spec failed — layer left untouched", {
				provider: PROVIDER_SPECS[i].id,
				error: res.reason,
			});
		}
	});

	if (!Object.keys(providers).length) {
		logInfo("no override-only reroutes needed — model-012 layer written empty");
	}
	const written = writeArtifact(
		join(scriptDir, "model-012-cloud-pi-native.json"),
		`${JSON.stringify({ providers }, null, 2)}\n`,
	);
	logInfo("pi-native override layer written", { path: written });
}

/**
 * @param {string} out
 * @returns {Promise<void>}
 */
async function generateLocalLlamaSwap(out) {
	/**
	 * The peer's funnel base URL — vault-sourced (peerBaseUrl(); see the header
	 * there). No localhost candidates are probed — the LAN :8080 (proxy) and
	 * :8101 (llama-swap) listen addresses are not routable from outside the host
	 * they serve (docs/d022). peerBaseUrl() throws when no peer base is set;
	 * keeping it inside the stage means the other pi stages still run.
	 */
	const LOCAL_SOURCE_CANDIDATES = [
		peerProviderUrl(peerBaseUrl(), "llama-swap"),
	];

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

/**
 * A JSON object node; arrays and scalars are merge leaves (see header).
 * @typedef {Record<string, unknown>} JsonObject
 */

/**
 * @param {unknown} value
 * @returns {value is JsonObject} true for plain objects — arrays and null are
 *   leaves, not merge targets
 */
function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep-merge layers left to right: objects recurse, everything else is
 * replaced by the later layer.
 * @param {...unknown} layers
 * @returns {JsonObject}
 */
function deepMerge(...layers) {
	/** @type {JsonObject} */
	const out = {};
	for (const layer of layers) {
		if (!isPlainObject(layer)) continue;
		for (const [key, value] of Object.entries(layer)) {
			if (isPlainObject(value) && isPlainObject(out[key])) {
				out[key] = deepMerge(out[key], value);
			} else {
				out[key] = value;
			}
		}
	}
	return out;
}

/**
 * @param {string} path
 * @returns {unknown} the parsed document (any shape — layers are validated by
 *   the merge, not here)
 * @throws {Error} when the file is missing or not valid JSON
 */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw Object.assign(new Error("layer file is missing or not valid JSON"), {
			path,
			cause: error,
		});
	}
}

/**
 * @param {string} out
 * @returns {void}
 */
function mergeModels(out) {
	const overlayNames = readdirSync(scriptDir)
		.filter((name) => /^model-.*\.json$/.test(name))
		.sort();
	const layers = overlayNames.map((name) => readJson(join(scriptDir, name)));
	const written = writeArtifact(
		out,
		`${JSON.stringify(deepMerge(...layers), null, 2)}\n`,
	);
	logInfo("merged layers", { overlays: overlayNames.length, path: written });
}

/**
 * The settings source whose defaultProvider/defaultModel this generator
 * returns. generate.sh points $PI_SETTINGS at the file it installs (the
 * agent dir's settings.json after the settings-install stage); manual runs
 * read the repo's committed copy.
 * @returns {string}
 */
function settingsPath() {
	return process.env.PI_SETTINGS ?? join(scriptDir, "settings.json");
}

/**
 * @typedef {object} SettingsSource
 * @property {string} [defaultProvider]
 * @property {string} [defaultModel]
 */

/**
 * @param {string} outPath
 * @returns {void}
 */
function generateDefaultModel(outPath) {
	let settings = /** @type {SettingsSource} */ ({});
	try {
		settings = /** @type {SettingsSource} */ (
			JSON.parse(readFileSync(settingsPath(), "utf-8"))
		);
	} catch (err) {
		logWarn("settings source unreadable — no default model configuration", {
			path: settingsPath(),
			error: err,
		});
	}

	const overlay = {};
	if (settings.defaultProvider)
		overlay.defaultProvider = settings.defaultProvider;
	if (settings.defaultModel) overlay.defaultModel = settings.defaultModel;

	if (overlay.defaultProvider && overlay.defaultModel) {
		logInfo("default model: operator-hardcoded pair returned as is", {
			provider: overlay.defaultProvider,
			model: overlay.defaultModel,
			from: settingsPath(),
		});
	} else {
		logWarn(
			"settings source carries no defaultProvider/defaultModel — empty overlay written (pi's own default will apply)",
			{ path: settingsPath() },
		);
	}
	const written = writeArtifact(
		outPath,
		`${JSON.stringify(overlay, null, 2)}\n`,
	);
	logInfo("default model configuration written", { path: written });
}

/**
 * Run one stage; a thrown stage is logged and the ones after it still run
 * (pre-merge behaviour: generate.mjs spawned each stage as a child and warned
 * on non-zero exit). Keeping that isolation in one process is what makes the
 * broad merge safe.
 * @param {string} name
 * @param {() => void|Promise<void>} run
 * @returns {Promise<void>}
 */
async function runStage(name, run) {
	try {
		await run();
	} catch (err) {
		logWarn("pi stage failed — continuing", {
			stage: name,
			error: err,
		});
	}
}

/** @returns {Promise<void>} */
async function main() {
	const modelsOut =
		process.argv[2] ??
		process.env.PI_MODELS_JSON ??
		join(scriptDir, "models.json");
	const defaultOut =
		process.argv[3] ??
		process.env.PI_DEFAULT_MODEL_JSON ??
		join(scriptDir, "default-model.json");

	await runStage("local-llama-swap", () =>
		generateLocalLlamaSwap(join(scriptDir, "model-010-local-default.json")),
	);
	await runStage("cloud-providers", () => generateCloudProviders());
	await runStage("merge-models", () => mergeModels(modelsOut));
	await runStage("default-model", () => generateDefaultModel(defaultOut));
}

await main();
