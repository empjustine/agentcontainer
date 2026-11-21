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
 *   2. `generateOverrideLayers` / `generateFullLayers` → `model-012-cloud-pi-native.json`
 *      (override-only: EVERY pi-native provider emitted at its canonical
 *      fact-table upstream URL (docs/d070) — the probe only picks the
 *      lineup source, live listing vs models.dev ∪ catwalk ids, docs/d063 —
 *      with docs/d064's tiering deciding whether a row is probed at all) plus
 *      `model-015/016/017/018/019-*.json` (full rows: the sole definition for
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
 *   + model-018-cloud-verboo.json
 *   + model-019-cloud-synthetic.json
 *   + model-020-reverse-proxy-default.json   (future / drop-in)
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
 * Failure domains (docs/d063): `runStage` still catches a thrown LOCAL or
 * default-model stage and the remaining stages run — but the CLOUD stage is
 * fatal by design: an omitted cloud provider would fall back to pi's
 * built-in DIRECT routing, so a failed cloud stage fails the generator and
 * `generate.mjs` treats a non-zero exit as fatal. Generation needs no
 * reverse-proxy base (docs/d108): probes address canonical upstreams, and a
 * probe that cannot answer only degrades that row's lineup to the
 * catalog/facts cache.
 *
 * `generate.mjs` (the folder driver) refreshes the models.dev catalog, then
 * runs this generator once — followed by the separate opencode generator —
 * in place, from this directory (docs/d072 retired the d023 scratch staging
 * that used to copy these sources elsewhere). The per-stage docs these
 * bodies were folded from are `docs/d024`, `docs/d033`, `docs/d037`,
 * `docs/d057`.
 *
 * Usage: node generate-pi-coding-agent.mjs [models.json] [default-model.json]
 *   models.json defaults to $PI_MODELS_JSON else ./models.json.
 *   default-model.json defaults to $PI_DEFAULT_MODEL_JSON else
 *   ./default-model.json.
 *   Settings source for the default pair: $PI_SETTINGS else ./settings.json.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	bearerHeaders,
	catalogModelLive,
	cloudProvidersPath,
	fetchCatwalkFacts,
	fetchProviderFacts,
	getCatwalkModels,
	logError,
	logInfo,
	logWarn,
	modalitiesEligible,
	PI_NATIVE_CLOUD_IDS,
	piCost,
	piModel,
	probeCandidates,
	probeEndpoint,
	providerEntry,
	providerFacts,
	providerReroute,
	scriptDir,
	setLogTool,
	toInput,
	writeArtifact,
	writeJsonArtifact,
} from "./gen-lib.mjs";
import { readCloudProviders } from "./lib/cloud-providers.mjs";

/**
 * The models.dev catalog this run fetched, or null when it is absent (the
 * manual-run case). Parsed once by main and passed to the stages that read it.
 * @typedef {Record<string, { models?: Record<string, ModelsDevModel> }>|null} CatalogDoc
 */

/**
 * One provider row as this run sees it: the three facts every emission stage
 * needs about ONE provider — its spec (what to emit), its fact-table row (the
 * canonical upstream and key env) and the key resolved from the environment.
 * They travel together because each stage emits one provider, and three
 * parallel arguments would let a call site drift onto another row.
 * @typedef {object} ProviderRow
 * @property {CloudProviderSpec} spec
 * @property {import("./lib/cloud-providers.mjs").CloudProviderFacts} facts
 * @property {string|undefined} apiKey the key resolved from facts.apiKeyEnv
 */
/**
 * Per-provider scoping of the override's model list, applied to BOTH sources
 * (the live listing and catalog fallback). These are the slices this fleet
 * can actually use — the llama-swap era encoded them on the SERVING side
 * (gen-lib's `filter`); with routing per provider the client scopes its own
 * override (docs/d033).
 *
 *   - openrouter: the ":free" slice (the scope the local gateway always served).
 *   - mistral: chat-capable only — the catalog/listing also carries
 *     mistral-embed (embeddings) and voxtral-*-tts (speech).
 *   - google: a MODALITY allowlist, not a name denylist — pi drives text
 *     chat (its own input schema is text+image, docs/d115), so a model
 *     stays iff it takes text in and produces text out. That one rule drops
 *     the image-output generators (out [text,image]), tts/live/lyria
 *     (out [text,audio]), veo/omni (out [video]) and the live-translate
 *     (in [audio]) — categories a name regex could only approximate, which
 *     is why the pre-catalogOnly filter leaked ids d033 claimed to drop.
 *     Two records still need a name check: models.dev labels the embedding
 *     endpoints out ["text"] (they are not chat), so `/embedding/` is
 *     refused before the modality test. No record (live-listing path —
 *     unreachable for a catalogOnly row) falls back to the old regex.
 * docs/d049: the modality gate itself moved to gen-lib
 * (`modalitiesEligible`, the one capability declaration) and runs FIRST at
 * every record-backed call site — what stays in this table are the
 * documented name exceptions and the access scopes. google keeps its full
 * predicate (same rule as the gate) so it stays correct even when called
 * without the gate composition.
 * @type {Record<string, ((id: string, record?: ModelsDevModel) => boolean)|undefined>}
 */
const MODEL_SCOPES = {
	// Access scope, not a modality rule (d049: price/access stays orthogonal
	// and runs after the gate) — the slice the local gateway always served.
	openrouter: (id) => id.endsWith(":free"),
	// Documented name exception (d049): models.dev lies about embedding
	// endpoints' output like google's — `/embed/` papers over it; `/tts/` is
	// kept as part of the reviewed exception set (redundant with the gate,
	// which refuses voxtral's [text,audio] output too).
	mistral: (id) => !/embed|tts/i.test(id),
	google: (id, record) => {
		// Documented name exception (d049): the gate trusts models.dev's
		// `output:["text"]` label on embedding endpoints — this id check is
		// what drops them.
		if (/embedding/i.test(id)) {
			return false;
		}
		const input = record?.modalities?.input;
		const output = record?.modalities?.output;
		if (!input || input.length === 0 || !output || output.length === 0) {
			return (
				id.startsWith('gemini-') && !/(-image|-tts|-live|-computer-use)/i.test(id)
			);
		}
		return (
			input.includes("text") && output.length === 1 && output[0] === "text"
		);
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
 *   (override-only — see MODEL_SCOPES below)
 * @property {{ supportsDeveloperRole: boolean }|null} compat provider-level
 *   compat pi cannot infer; null = no override (full)
 * @property {((m: ModelsDevModel) => Record<string, unknown>|null)|null} modelCompat
 *   builds the per-model compat mirror; null = none (full)
 * @property {boolean} onOffThinking swaps the all-null effort-less map for
 *   the ON_OFF representative map (full; see that constant)
 * @property {{ path: string, listKey?: string }|undefined} [facts] the
 *   provider's OWN rich model endpoint, relative to its base URL: refreshed
 *   and cached (catalog-facts.mjs), then read back through factsMapper. Its
 *   role follows the catalog: a lineupFromFacts row publishes exactly what it
 *   answered, a catalog-less provider's cache is the only lineup there is
 *   (docs/d057), and a plain row keeps the catalog slice enriched by it
 *   (docs/d033)
 * @property {boolean} [lineupFromFacts] the provider's own source decides
 *   WHICH ids publish and the catalog only their metadata (docs/d190): a
 *   catalog row the source does not serve is retired rather than carried, and
 *   a source that cannot answer publishes nothing instead of the last good
 *   cache. Without it the catalog slice stays the lineup (full)
 * @property {boolean} [lineupOnly] the published lineup is ALSO the only field
 *   source: the row takes no catalog records, so the table's ids and names
 *   publish over pi's schema defaults and nothing from models.dev follows a
 *   successful table read (docs/d189). Distinct from lineupFromFacts, which
 *   takes the lineup from the provider's own listing and keeps catalog metadata
 * @property {((record: ProviderFactsModel) => ModelsDevModel|null)|undefined}
 *   [factsMapper] rebuild one cached record as a models.dev-shaped record so
 *   it reuses catalogPiModel()'s full derivation, or null for a record the
 *   row must not publish at all; required whenever facts is set, and the only
 *   place a provider's own record shape is interpreted
 * @property {boolean} [catalogOptional] the models.dev catalog does not carry
 *   this provider at all, so loadProvider() must not be the lineup source and
 *   must not throw: the endpoint comes from the fact table (the same base URL
 *   the legacy install-time route is derived from, docs/d047/d108) and the
 *   lineup from the facts cache. Without it a catalog-less row throws and no
 *   layer is written
 *   (docs/d032 F1, docs/d057)
 * @property {boolean} [mixedSurface] one base URL serving several api
 *   dialects, describable only by the provider's own live listing: without
 *   one the row publishes NO models and pi's built-in records stand
 *   (docs/d048)
 * @property {boolean} [catalogOnly] the provider serves no model listing the
 *   probe could ever authenticate (google: /v1beta/models demands its own
 *   api-key parameter, not the bearer the probe sends, so every probe is a
 *   permanent 403) — no probes at all, the models.dev slice is the sole
 *   lineup source, and the catwalk union is skipped (override-only; docs/d033)
 * @property {(() => Promise<readonly LineupEntry[]>) | undefined} [lineupResolver]
 *   the provider's PUBLISHED lineup (id + display name), fetched at emit
 *   time; when present it decides which ids publish and the catalog only
 *   supplies their metadata, so it replaces modelAllowlist for that row
 *   (full; docs/d189)
 * @property {string} [modelIdPrefix] literal prefix every catalog model id
 *   must carry (full). Structural guard, not a scoping choice: models.dev
 *   intermittently mislabels `cline`-provider models under other provider
 *   keys, and the prefix is the provider's own API contract — a cline-pass
 *   id served without it bills at standard API pricing, not the subscription
 *   (docs/d040)
 * @property {Record<string, string>} [headers] provider-level request headers
 */

/**
 * The ClinePass provider id — simultaneously the pi provider key, the
 * models.dev key, and the model-id namespace prefix the ClinePass API
 * requires to bill the subscription (docs/d040).
 */
const CLINE_PASS_ID = "cline-pass";

/**
 * Cline's published clinepass.mdx: the ONE source of the called-through
 * lineup (docs/d189). The mirror farm is not consulted for this file — a
 * mirror clone is a remembered table, and a remembered table publishes ids
 * the gateway has already retired.
 */
const CLINE_PASS_DOCS_URL =
	"https://raw.githubusercontent.com/cline/cline/main/docs/getting-started/clinepass.mdx";

/**
 * One row of the published `## Models` table: the id the gateway bills under
 * (already in the `cline-pass/` namespace) and the display name the table
 * gives it.
 * @typedef {object} LineupEntry
 * @property {string} id
 * @property {string} name
 */

/**
 * The rows of the GFM table under one `## ` heading, as trimmed cells without
 * the outer pipes. Scoping to the heading is what makes a table readable at
 * all: every one of these documents carries further tables whose columns mean
 * something else, and the `| --- |` separator row is left to the caller that
 * knows which cell identifies a data row.
 * @param {string} mdx
 * @param {string} heading section heading without the `## `, e.g. "Models"
 * @returns {string[][]|null} null when the section is absent
 */
function tableRows(mdx, heading) {
	const section = mdx
		.split(new RegExp(`^## ${heading}\\s*$`, "m"))[1]
		?.split(/^## /m)[0];
	if (!section) {
		return null;
	}
	return section
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("|"))
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim()),
		);
}

/**
 * Parse the `## Models` GFM table from Cline's published clinepass.mdx into
 * one entry per row: the id WITH its `cline-pass/` prefix (the namespace the
 * API bills under) and the display name in the table's first column, so no
 * consumer re-derives either. Scoped to that section because the later
 * `## Reference pricing` table is a different shape (peak/off-peak and
 * token-tier rows with display-only names). Every accepted id must carry the
 * `cline-pass/` prefix — the published table doubles as the API-namespace
 * assertion. Returns null when the section is absent or carries no prefixed
 * id.
 * @param {string} mdx
 * @returns {LineupEntry[]|null}
 */
function parseClinePassDocs(mdx) {
	const rows = tableRows(mdx, "Models");
	if (!rows) {
		return null;
	}
	/** @type {LineupEntry[]} */
	const lineup = [];
	for (const cells of rows) {
		const id = cells[1]?.replace(/`/g, "");
		if (!id?.startsWith(`${CLINE_PASS_ID}/`)) {
			continue;
		}
		// A repeated row is one model: the docs file has carried duplicates
		// before, and a lineup is a set, not an ordering to reproduce.
		if (lineup.some((entry) => entry.id === id)) {
			continue;
		}
		lineup.push({ id, name: cells[0] || id });
	}
	return lineup.length > 0 ? lineup : null;
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
 * @param {string|string[]} refPath the in-repo path handed to `git show
 *   HEAD:` — an array is an ordered candidate list for a document that
 *   moved: the first path the mirror still carries wins, and an upstream
 *   move costs the file's content, never the read (docs/d048)
 * @param {string} warnContext log label on total failure
 * @returns {string|null}
 */
function readMirrorFile(envMirror, orgRepo, refPath, warnContext) {
	const refPaths = typeof refPath === "string" ? [refPath] : refPath;
	const candidates = [
		...(envMirror ? [envMirror] : []),
		join(homedir(), "Downloads", "references", "github.com", `${orgRepo}.git`),
		join(homedir(), `${orgRepo}.git`),
	];
	let lastError;
	for (const mirror of candidates) {
		for (const path of refPaths) {
			try {
				return execFileSync("git", ["-C", mirror, "show", `HEAD:${path}`], {
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 15_000,
				});
			} catch (err) {
				lastError = err;
			}
		}
	}
	logWarn(`${warnContext} — no mirror location readable`, {
		candidates,
		refPaths,
		error: lastError,
	});
	return null;
}

/**
 * Read Cline's published clinepass.mdx: a pinned local file (CLINE_PASS_MDX)
 * when the host carries one, else the canonical raw URL. THROWS when neither
 * answers — no table means no ClinePass lineup, and a remembered one is not
 * a substitute (docs/d189).
 * @param {Record<string, string|undefined>} env the run's environment
 * @returns {Promise<string>}
 */
async function readClinePassDocs(env) {
	const explicit = env.CLINE_PASS_MDX;
	if (explicit) {
		return readFileSync(explicit, "utf-8");
	}
	const res = await fetch(CLINE_PASS_DOCS_URL, {
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) {
		throw new Error(`cline-pass docs answered ${res.status}`);
	}
	return res.text();
}

/**
 * ClinePass's published lineup for this run: the docs table, and nothing
 * else. models.dev carries metadata for those ids, never a lineup — its
 * cline-pass slice keeps rows the gateway has retired (docs/d189).
 * @returns {Promise<readonly LineupEntry[]>}
 * @throws {Error} when the table cannot be read or parsed: an unavailable
 *   lineup is an unavailable provider, not a reason to publish a remembered
 * @param {Record<string, string|undefined>} env the run's environment
 *   list (docs/d189)
 */
async function resolveClinePassLineup(env) {
	const lineup = parseClinePassDocs(await readClinePassDocs(env));
	if (!lineup) {
		throw new Error("clinepass.mdx carries no ## Models table");
	}
	logInfo("cline-pass lineup read from the published table", {
		models: lineup.length,
	});
	return lineup;
}

/**
 * The opencode-go provider id — simultaneously the pi provider key and the
 * models.dev key (its api.json slice is keyed bare, unlike cline-pass's
 * prefixed keys).
 */
const OPENCODE_GO_ID = "opencode-go";

/**
 * The pi-native rows behind ONE base URL that serves a MIXED api surface —
 * zen (opencode) and Go share the machinery. Their provider-level dialect
 * cannot route the lineup, and the catalog carries no dialect at all (its
 * per-model `provider.npm` cannot split the two openai shapes), so only a
 * live listing describes them: without one, publishing id-only records would
 * replace pi's described built-ins with stubs and route every model through
 * the wrong shape. The row keeps the reroute and publishes no models
 * (docs/d048).
 * @type {ReadonlySet<string>}
 */
const MIXED_SURFACE_IDS = new Set(["opencode", OPENCODE_GO_ID]);

/**
 * Parse the `## Endpoints` GFM table from opencode's published go.mdx into
 * bare model ids. Scoped to that section because the other tables (usage
 * limits, privacy) carry display names only; cell layout is
 * | Model | Model ID | Endpoint | AI SDK Package | and only the id column
 * matters — the endpoint column is a restatement of the route each LIVE
 * listing entry already declares per model (docs/d048). Returns null when
 * the section is absent, which is not an error: the table is a reference,
 * never a lineup source.
 * @param {string} mdx
 * @returns {Set<string>|null}
 */
function parseDocsModelIds(mdx) {
	const rows = tableRows(mdx, "Endpoints");
	if (!rows) {
		return null;
	}
	/** @type {Set<string>} */
	const ids = new Set();
	for (const cells of rows) {
		const id = cells[1]?.replace(/`/g, "");
		// The GFM separator row (`| --- | --- | ...`) sits in the same table
		// and its second cell is a dash run; the header cell is the label.
		if (id && id !== "Model ID" && !/^-+$/.test(id)) {
			ids.add(id);
		}
	}
	return ids;
}

/**
 * Read opencode's published go.mdx. OPENCODE_GO_MDX points at a plain file;
 * otherwise the mirror lookup (readMirrorFile) tries the in-repo paths in
 * order — the docs moved from the package tree to the site tree, and the
 * candidate list makes a further move a degrade to "no reference" rather
 * than a silent loss (docs/d048). A missing mirror is the normal container
 * case and warns once.
 * @param {Record<string, string|undefined>} env the run's environment
 * @returns {string|null}
 */
function readOpencodeGoDocs(env) {
	const explicit = env.OPENCODE_GO_MDX;
	if (explicit) {
		try {
			return readFileSync(explicit, "utf-8");
		} catch (err) {
			logWarn("opencode-go docs file unreadable", {
				path: explicit,
				error: err,
			});
			return null;
		}
	}
	return readMirrorFile(
		env.OPENCODE_MIRROR,
		"anomalyco/opencode",
		[
			"services/site/src/docs/content/console/go.mdx",
			"packages/web/src/content/docs/go.mdx",
		],
		"opencode-go docs mirror unreadable — no docs/listing cross-check",
	);
}

/**
 * The published endpoint ids, or null when no docs source answered — the
 * cross-check then simply does not run (one read per run: the caller does not
 * call this twice).
 * @param {Record<string, string|undefined>} env the run's environment
 * @returns {Set<string>|null}
 */
function docsModelIds(env) {
	const docs = readOpencodeGoDocs(env);
	return docs ? parseDocsModelIds(docs) : null;
}

/**
 * Compare opencode-go's emitted lineup with the published table and log both
 * directions (docs/d048). The table is a REFERENCE, not a lineup: the live
 * listing decides which ids exist (a key that cannot call a model does not
 * see it, and that absence is the provider's answer, not a gap to patch),
 * so a docs-only id is reported and never added. The reverse direction —
 * a live model the table does not list — is the drift that matters for
 * documentation, and it is reported the same way.
 * @param {import("./gen-lib.mjs").PiModel[]} models
 * @param {Set<string>|null} docsIds the published endpoint ids, or null when
 *   no docs source answered
 * @returns {void}
 */
function reportOpencodeGoDocsDrift(models, docsIds) {
	if (!docsIds) {
		return;
	}
	const emitted = new Set(models.map((m) => m.id));
	const docsOnly = [...docsIds].filter((id) => !emitted.has(id));
	const liveOnly = [...emitted].filter((id) => !docsIds.has(id));
	if (docsOnly.length === 0 && liveOnly.length === 0) {
		logInfo("opencode-go docs and live listing agree", {
			models: emitted.size,
		});
		return;
	}
	logWarn(
		"opencode-go docs and live listing disagree — the listing stands (docs/d048)",
		{ docs: docsIds.size, live: emitted.size, docsOnly, liveOnly },
	);
}
/**
 * The run's provider spec table: what to emit per row and how to gate it. A
 * function of the fact table and the environment, called by main — it is DATA
 * about the run, not module state.
 * @param {Readonly<Record<string, import("./lib/cloud-providers.mjs").CloudProviderFacts>>} cloudProviders
 * @param {Record<string, string|undefined>} env the run's environment
 * @returns {CloudProviderSpec[]}
 */
function providerSpecs(cloudProviders, env) {
	return [
	// --- override-only: the pi-native set (fact table owns the base URL) ---
	...PI_NATIVE_CLOUD_IDS.map(
		(id) =>
			/** @type {CloudProviderSpec} */ ({
				id,
				mode: "override-only",
				envKey: providerFacts(cloudProviders, id).apiKeyEnv,
				filter: MODEL_SCOPES[id],
				// A mixed surface is only describable by its own listing (d048).
				...(MIXED_SURFACE_IDS.has(id) ? { mixedSurface: true } : {}),
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
		// The table decides the lineup AND is the only field source: read first, so
		// a successful read means no models.dev metadata follows it (docs/d189).
		lineupResolver: () => resolveClinePassLineup(env),
		lineupOnly: true,
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
		// hyper's own /provider catalog IS the lineup (docs/d190): models.dev
		// only prices it, so a catalog id the source no longer serves is retired
		// instead of carried (docs/d033 records the earlier enrich-and-keep
		// shape and why it kept them: nothing dropped a row pi could still ask
		// for while the endpoint answered).
		facts: { path: "/provider" },
		factsMapper: hyperFactsRecord,
		lineupFromFacts: true,
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
	{
		id: "verboo",
		mode: "full",
		name: "Verboo",
		file: "model-018-cloud-verboo.json",
		envKey: "VERBOO_API_KEY",
		// Plain OpenAI-compatible gateway on /router/v1: no developer-role
		// quirk, no per-model wire-compat mirror — pi's defaults are correct
		// as-is (the inferx shape, docs/d032 F7).
		compat: null,
		modelCompat: null,
		// The listing publishes effort ENUMS, so buildThinkingLevelMap covers
		// the reasoning models and no ON_OFF fallback applies. Note the gap
		// this leaves: only `qwen3.8-27b` lists a disable value ("none"), so
		// for the other four the map has off=null and pi offers no way to
		// disable thinking. Synthesizing one would mean inventing a wire value
		// the listing never advertises, so it stays absent until verb oo
		// publishes one (docs/d057).
		onOffThinking: false,
		// models.dev carries no verboo row and the catalog is replaced
		// wholesale on refresh, so the lineup cannot come from it
		// (catalogOptional) and the endpoint comes from the fact table
		// instead of a catalog `api`.
		catalogOptional: true,
		facts: { path: "/models", listKey: "data" },
		factsMapper: verbooFactsRecord,
	},
	{
		id: "synthetic",
		mode: "full",
		name: "Synthetic",
		file: "model-019-cloud-synthetic.json",
		envKey: "SYNTHETIC_API_KEY",
		// Plain OpenAI-compatible gateway (models.dev:
		// @ai-sdk/openai-compatible), the inferx shape: no developer-role
		// quirk, no per-model wire-compat mirror. Every reasoning model
		// publishes an effort enum, so buildThinkingLevelMap covers them and no
		// ON_OFF fallback applies (docs/d033, d032 F7).
		compat: null,
		modelCompat: null,
		onOffThinking: false,
		// The public listing IS the lineup (docs/d190): the catalog slice kept
		// `hf:` ids the provider had already rotated away, and the `syn:*` tier
		// rows exist only on the wire.
		facts: { path: "/models", listKey: "data" },
		factsMapper: syntheticFactsRecord,
		lineupFromFacts: true,
	},
	];
}

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
 * @param {{ reasoning_options?: Array<{ type?: string, values?: string[] }> | undefined }} m
 * @returns {Set<string>}
 */
function effortValues(m) {
	const values = new Set();
	for (const opt of m?.reasoning_options ?? []) {
		if (opt?.type === "effort" && Array.isArray(opt.values)) {
			for (const v of opt.values) {
				values.add(String(v).toLowerCase());
			}
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
	if (values.size === 0) {
		return null;
	}
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
 * @param {ModelsDevModel["cost"]} cost the catalog's price block, or `null`
 *   for a provider whose listing publishes NO prices
 * @returns {PiAlternativeModel["cost"]} undefined for `null` — the layer then
 *   omits `cost` rather than asserting pi's placeholder as if it were fact —
 *   and undefined for an all-zero block, by the shared piCost rule
 */
function toCost(cost) {
	if (cost === null || cost === undefined) {
		return;
	}
	// Only the field names differ between the two sources (models.dev spells
	// the cache prices cache_read/cache_write); "complete or absent" is
	// piCost's rule, shared with the llama-swap path in gen-lib (docs/d057).
	return piCost({
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cache_read,
		cacheWrite: cost.cache_write,
	});
}

/**
 * A models.dev model record — the subset the full mode reads.
 * @typedef {object} ModelsDevModel
 * @property {string} id
 * @property {string|undefined} [name]
 * @property {string} [family]
 * @property {boolean} [reasoning]
 * @property {{ input?: string[]|undefined, output?: string[]|undefined }} [modalities]
 * @property {{ context?: number|undefined, output?: number|undefined }} [limit]
 * @property {{ input: number, output: number, cache_read: number, cache_write: number }|null} [cost]
 *   `null` = the source publishes no prices at all (a facts-only provider's
 *   listing), which catalogPiModel() renders as an omitted cost rather than
 *   the placeholder (see toCost)
 * @property {Array<{ type?: string, values?: string[] }>|undefined} [reasoning_options]
 * @property {{ npm?: string }|null} [provider] per-model api surface override
 *   (models.dev mirrors the anomalyco fork's providers/<id>/models/*.toml
 *   `[provider] npm = ...`; the package name is the api-shape vocabulary,
 *   docs/d048)
 */

/**
 * A pi-shaped model entry as the full mode publishes it. Only the first
 * three fields are guaranteed: route-served ids with no models.dev equivalent
 * are published minimal (the rest falls back to pi's defaults).
 * @typedef {object} PiAlternativeModel
 * @property {string} id
 * @property {boolean} reasoning
 * @property {string[]} input
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} [cost]
 * @property {Record<string, string|null>} [thinkingLevelMap]
 * @property {Record<string, unknown>} [compat]
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
	// Documented name exception (d049): models.dev labels the embedding
	// endpoints output ["text"] — the gate below trusts that label, so the
	// family/id check is what refuses them (the visible exception set).
	if (m.family === "text-embedding" || id.toLowerCase().includes("embedding")) {
		return null;
	}
	// d049 admit-but-trim gate: refuse what the client cannot drive (input
	// without the drivable core, output beyond text) before any projection.
	// Unjudgeable dimensions pass — see modalitiesEligible.
	if (!modalitiesEligible(m.modalities)) {
		return null;
	}
	/** @type {PiAlternativeModel["cost"]} */
	const cost = toCost(m.cost);
	/** @type {PiAlternativeModel} */
	const model = {
		id,
		name: m.name ?? id,
		reasoning: m.reasoning === true,
		input: toInput(m.modalities?.input),
		contextWindow: m.limit?.context ?? 128_000,
		maxTokens: m.limit?.output ?? 16_384,
	};
	// A record with no published prices (cost: null, docs/d057) publishes no
	// cost block: pi falls back to its own defaults, and a committed artifact
	// never carries invented numbers.
	if (cost) {
		model.cost = cost;
	}
	if (model.reasoning) {
		const map = buildThinkingLevelMap(m.reasoning_options);
		const thinking =
			map ?? (spec.onOffThinking ? { ...ON_OFF_THINKING_LEVEL_MAP } : null);
		if (thinking) {
			model.thinkingLevelMap = thinking;
		}
	}
	const compat = spec.modelCompat?.(m);
	if (compat) {
		model.compat = compat;
	}
	return model;
}

/**
 * The record a facts cache's mapper consumes or produces — one generic view
 * over the provider-specific shapes (HyperProviderModel, VerbooFactsRecord):
 * pi-shaped derivation runs through catalogPiModel(), so mappers emit
 * models.dev-shaped records and every catalog default still applies.
 * @typedef {import("./catalog-facts.mjs").ProviderFactsModel} ProviderFactsModel
 */

/**
 * @typedef {import("./catalog-facts.mjs").ProviderFactsModel} ProviderFactsModelRaw
 */

/**
 * Load one full-mode provider's slice of the (once-parsed) models.dev
 * catalog. Catwalk is NOT a fallback here: it carries none of the
 * alternative providers (docs/d028 coverage gap — hyper/cline-pass/inferx
 * are absent).
 *
 * A `catalogOptional` row returns an EMPTY lineup instead of throwing, and its
 * endpoint comes from the fact table rather than a catalog `api`: models.dev
 * does not carry the provider at all, and the vendored catalog is replaced
 * wholesale on every refresh, so a missing row is this row's normal state,
 * not a broken catalog (docs/d032 F1, docs/d057). The fact table is also the
 * base URL its client route is derived from, so the committed and installed
 * URL forms cannot disagree (docs/d047, d070). Its lineup arrives through the facts cache instead —
 * an empty `models` map is what tells emitFull the cache owns the lineup.
 * @param {CatalogDoc} catalog the run's parsed models.dev catalog
 * @param {string} layerDir the run's layer dir (the catalog sits beside it)
 * @param {CloudProviderSpec} spec the provider spec row
 * @returns {Record<string, ModelsDevModel>} the provider's per-model metadata
 */
function loadProvider(catalog, layerDir, spec) {
	if (spec.catalogOptional) {
		return {};
	}
	const provider = catalog?.[spec.id];
	if (!provider?.models) {
		throw Object.assign(
			new Error(
				catalog
					? "provider not found in the models.dev catalog"
					: "models.dev catalog unreadable",
			),
			{ provider: spec.id, path: join(layerDir, "models.dev.api.json") },
		);
	}
	return provider.models;
}

/**
 * Rebuild a raw hyper facts (live `/provider`) record as a models.dev-shaped
 * model record, so the enrichment reuses catalogPiModel()'s full derivation
 * (input, costs, effort-enum → thinkingLevelMap/compat). Fields pi models but
 * the live record lacks stay undefined → catalogPiModel()'s defaults; the
 * display name is overridden back to the models.dev one by the enricher
 * (names stay catalog — see the header whitelist note).
 * @param {HyperFactsRecord} l a raw live /provider record
 * @returns {ModelsDevModel} a models.dev-shaped record with live facts
 */
function hyperFactsRecord(l) {
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
		reasoning_options:
			levels.length > 0 ? [{ type: "effort", values: levels }] : [],
	};
}

/**
 * A raw Charm Hyper `/provider` model record — the subset its factsMapper
 * reads. Declared here, next to the mapper, because the record shape is the
 * mapper's input and nothing else in the generator knows it.
 * @typedef {object} HyperFactsRecord
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [can_reason]
 * @property {string[]} [reasoning_levels]
 * @property {string} [default_reasoning_effort]
 * @property {boolean} [supports_attachments]
 * @property {number} [context_window]
 * @property {number} [default_max_tokens]
 * @property {number} [cost_per_1m_in]
 * @property {number} [cost_per_1m_out]
 * @property {number} [cost_per_1m_in_cached]
 * @property {number} [cost_per_1m_out_cached]
 */

/**
 * A raw verboo `/models` record — its listing is OpenAI-shaped
 * (`{object:"list",data:[…]}`) and RICH in capability fields but silent on
 * money: context_window, a boolean vision flag, and an optional reasoning
 * object carrying the effort enum. `default_effort` has no home in pi's model
 * shape (the thinkingLevelMap is a level → wire-value map, not a default), so
 * it is dropped rather than invented into one.
 * @typedef {object} VerbooFactsRecord
 * @property {string} id
 * @property {number} [context_window]
 * @property {boolean} [vision]
 * @property {{ effort_levels?: string[], default_effort?: string }} [reasoning]
 */

/**
 * Rebuild a raw verboo `/models` record as a models.dev-shaped record (this is
 * the provider's factsMapper, so catalogPiModel() derives everything pi reads
 * from one shape).
 *
 * Two absences are deliberate, not oversights:
 *   - `cost: null` — the listing publishes NO prices, and toCost() would
 *     otherwise fabricate pi's 10/50/1/20 placeholder into a committed
 *     artifact. `null` is the marker for "no published price" (see toCost);
 *     the layer then omits the block rather than asserting a number.
 *   - no `limit.output` — likewise unpublished. catalogPiModel()'s default
 *     (16384) is the conservative cap to request, and inventing
 *     context_window-sized max_tokens against a 1M-context model would send
 *     max_tokens the upstream may reject.
 * @param {VerbooFactsRecord} l a raw live /models record
 * @returns {ModelsDevModel} a models.dev-shaped record with the live facts
 */
function verbooFactsRecord(l) {
	const levels = (l.reasoning?.effort_levels ?? []).map((v) =>
		String(v).toLowerCase(),
	);
	return {
		id: l.id,
		reasoning: l.reasoning !== undefined,
		modalities: { input: l.vision === true ? ["text", "image"] : ["text"] },
		limit: { context: l.context_window },
		cost: null,
		reasoning_options:
			levels.length > 0 ? [{ type: "effort", values: levels }] : [],
	};
}

/**
 * The listing's id families this row drops: `infinite:*` is Synthetic's print/mesh
 * routing family, which the OpenAI-compatible surface these layers point at
 * does not serve (docs/d096).
 * @type {readonly string[]}
 */
const UNSUPPORTED_SYNTHETIC_ID_PREFIXES = Object.freeze(["infinite:"]);

/**
 * Synthetic's listing row as a models.dev-shaped record, so the fleet layer's
 * prices, limits, modalities and effort enums come from the provider that
 * serves the model (docs/d190). Its pricing fields are dollar-prefixed
 * per-token strings ("$0.000002"), the same units the catalog states per
 * million (docs/d033's conversion, spelled out here because this folder may
 * not import a sibling extension's shaper — docs/d113).
 *
 * null for the `infinite:` family: the listing publishes a second routing family the
 * OpenAI-compatible surface this row points at does not serve, so publishing
 * it would put ids in the layer that answer 400 (docs/d096 carries the same
 * filter in the extension).
 * @param {Record<string, any>} l one listing record
 * @returns {ModelsDevModel|null}
 */
function syntheticFactsRecord(l) {
	if (
		typeof l.id === "string" &&
		UNSUPPORTED_SYNTHETIC_ID_PREFIXES.some((p) => l.id.startsWith(p))
	) {
		return null;
	}
	const efforts = /** @type {unknown[]} */ (
		l.reasoning_parameters?.efforts ?? []
	).map((v) => String(v).toLowerCase());
	const perMillion = (/** @type {unknown} */ value) => {
		const raw = typeof value === "string" ? value.trim().replace(/^\$/, "") : value;
		const n = Number(raw);
		return Number.isFinite(n) ? Number((n * 1_000_000).toFixed(9)) : 0;
	};
	const pricing = l.pricing ?? {};
	// A tier id says nothing about the model currently behind it, so the name
	// renders the target — the same display the extension emits (docs/d096).
	const pointsAt =
		typeof l.hugging_face_id === "string" && `hf:${l.hugging_face_id}` !== l.id
			? ` (hf:${l.hugging_face_id})`
			: "";
	return {
		id: l.id,
		name: `${l.display_name ?? l.id}${pointsAt}`,
		reasoning: efforts.length > 0,
		modalities: {
			input: l.input_modalities ?? ["text"],
			output: l.output_modalities ?? ["text"],
		},
		limit: { context: l.context_length, output: l.max_output_length },
		cost: {
			input: perMillion(pricing.prompt),
			output: perMillion(pricing.completion),
			cache_read: perMillion(pricing.input_cache_reads),
			cache_write: perMillion(pricing.input_cache_writes),
		},
		reasoning_options:
			efforts.length > 0 ? [{ type: "effort", values: efforts }] : [],
	};
}

/**
 * Enrich pi-shaped models with the provider's facts cache: rebuild every model
 * whose id is in the live records through catalogPiModel() on LIVE data
 * (via the spec's factsMapper), keeping the models.dev display name (see the
 * header whitelist). Models absent from the cache pass through
 * untouched. Live-only records are NOT appended (docs/d063 removed the
 * direct mode that served them): the lineup stays on the catalog bounded by
 * the route's listing. Only the ENRICHING role reaches here — a
 * catalog-less row's cache is consumed as the whole lineup, without a
 * catalog to reconcile against (docs/d057).
 * @param {CloudProviderSpec} spec
 * @param {PiAlternativeModel[]} models the models to enrich
 * @param {ProviderFactsModelRaw[]} facts the records the provider just served
 * @returns {{ enriched: PiAlternativeModel[], untouched: PiAlternativeModel[] }}
 */
function enrichWithFacts(spec, models, facts) {
	const { factsMapper } = spec;
	if (!factsMapper) {
		return { enriched: [], untouched: [...models] };
	}
	const live = new Map(facts.map((l) => [l.id, l]));
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
		const mapped = factsMapper(l);
		if (!mapped) {
			continue;
		}
		const rebuilt = catalogPiModel(spec, { ...mapped, name: m.name }, m.id);
		if (rebuilt) {
			enriched.push(rebuilt);
		}
	}
	return { enriched, untouched };
}

/**
 * The provider's own source AS the lineup (docs/d190): every record it served
 * publishes, bounded by the route's live listing and the published lineup when
 * the row has one. A catalog row the source does not mention never publishes —
 * that carried row IS the remembered lineup — and the catalog keeps the
 * display name for an id it also carries.
 * @param {CloudProviderSpec} spec
 * @param {ProviderFactsModelRaw[]} facts the records the provider just served
 * @param {PiAlternativeModel[]} catalogModels the catalog's pi-shaped rows
 * @param {{ routeIds: Set<string>|null, allow: Set<string>|null }} bounds
 * @returns {PiAlternativeModel[]}
 */
function factsLineup(spec, facts, catalogModels, { routeIds, allow }) {
	const { factsMapper } = spec;
	if (!factsMapper) {
		logWarn("facts row without a mapper — lineup unusable", {
			provider: spec.id,
		});
		return [];
	}
	const catalogNames = new Map(catalogModels.map((m) => [m.id, m.name]));
	const served = routeIds
		? facts.filter((l) => routeIds.has(l.id))
		: facts;
	return served
		.filter((l) => !allow || allow.has(l.id))
		.map((l) => {
			const record = factsMapper(l);
			return record === null
				? null
				: catalogPiModel(
						spec,
						{ ...record, name: catalogNames.get(l.id) ?? record.name },
						l.id,
					);
		})
		.filter((m) => m !== null);
}

/**
 * The override's models for one row, from the route's live listing.
 * Returns null when the listing yields nothing usable (the caller falls back
 * to the catalog).
 * @param {import("./route-probe.mjs").RawModelEntry[]} entries
 * @param {CloudProviderSpec} spec
 * @returns {import("./gen-lib.mjs").PiModel[]|null}
 */
function listingModels(entries, spec) {
	const filter = spec.filter;
	const models = entries
		.filter(
			(e) =>
				// d049: judge the typed surface when the listing carries one —
				// llama-swap and openrouter type `architecture`, a first-party
				// gateway types `modalities` (an untyped dimension passes).
				modalitiesEligible({
					input: e.architecture?.input_modalities ?? e.modalities?.input,
					output: e.modalities?.output,
				}) &&
				(filter?.(e.id) ?? true),
		)
		.map(piModel);
	return models.length > 0 ? models : null;
}

/**
 * The minimal override for a pi-native row: a provider at the CANONICAL
 * fact-table upstream URL (docs/d070 §1 — the route substitution happens at
 * install) plus the models.dev ∪ catwalk id list as minimal records. pi's
 * merge semantics keep
 * it safe: a matching id replaces the built-in record, a new id is added,
 * and the rest of the built-in lineup survives. When no lineup resolves the
 * provider is STILL emitted with `models: []`: omitting the provider would
 * hand routing to pi's built-in DIRECT definition (d063 §3) — a loud empty
 * lineup beats a silent direct URL.
 * @param {ProviderRow} row the provider this stage emits
 * @param {CatalogDoc} catalog the run's parsed models.dev catalog
 * @param {import("./catalog-facts.mjs").CatwalkProvider[]|null} catwalk the
 *   run's fetched catwalk listing
 * @returns {import("./gen-lib.mjs").PiProvider} the entry to publish
 */
function emitMinimalCatalogOverride(row, catalog, catwalk) {
	const spec = row.spec;
	if (spec.mixedSurface) {
		// The catalog carries no per-model dialect, so id-only records would
		// replace pi's described built-ins with stubs and misroute each model.
		logInfo("mixed surface, no listing — reroute only, pi's records stand", {
			provider: spec.id,
		});
		return providerReroute(row.facts.baseUrl);
	}
	const filter = spec.filter;
	const modelsDevModels = catalog?.[spec.id]?.models ?? {};
	const ids = new Set(
		Object.keys(modelsDevModels).filter(
			(mid) =>
				// A retired catalog entry first (docs/d048): publishing it offers
				// a model the provider stopped serving.
				catalogModelLive(modelsDevModels[mid]) &&
				// then the d049 gate, then the exception/access checks.
				modalitiesEligible(modelsDevModels[mid]?.modalities) &&
				(filter?.(mid, modelsDevModels[mid]) ?? true),
		),
	);
	// The catwalk union is skipped for catalogOnly rows: their lineup
	// contract is the models.dev slice alone (google, docs/d033) — catwalk's
	// gemini view is a rendering of the same upstream, not an independent
	// source to union in.
	if (!spec.catalogOnly) {
		for (const m of getCatwalkModels(catwalk, spec.id) ?? []) {
			if (filter?.(m.id) ?? true) {
				ids.add(m.id);
			}
		}
	}
	if (ids.size === 0) {
		logWarn(
			"no model list available — canonical reroute with an empty lineup",
			{
				provider: spec.id,
			},
		);
	}
	const models = [...ids].map((mid) => piModel({ id: mid }));
	logInfo("minimal catalog override — canonical base, ids merged", {
		provider: spec.id,
		models: ids.size,
	});
	return providerReroute(row.facts.baseUrl, models);
}

/**
 * Probe one row's canonical upstream with its own bearer. The base URL comes
 * from the fact table rather than the spec, so the URL a probe checks and the
 * URL the layer emits cannot diverge (docs/d070, d108).
 * @param {ProviderRow} row the provider to probe
 * @param {boolean} tlsDisabled the runtime TLS state, from main
 */
async function probeRow(row, tlsDisabled) {
	return await probeEndpoint(
		row.facts.baseUrl,
		bearerHeaders(row.apiKey?.trim()),
		tlsDisabled,
	);
}

/**
 * Run the override-only cascade for one pi-native row and record its entry
 * in `providers`: ALWAYS at the canonical fact-table upstream URL (docs/d070
 * — the route substitution is generate.mjs's install-time job). The probe
 * only picks the lineup source (live listing → catalog); superficial
 * rows (docs/d064) skip it entirely and take the catalog directly.
 * @param {ProviderRow} row the provider this stage emits
 * @param {boolean} tlsDisabled the runtime TLS state, from main
 * @param {CatalogDoc} catalog the run's parsed models.dev catalog
 * @param {import("./catalog-facts.mjs").CatwalkProvider[]|null} catwalk the
 *   run's fetched catwalk listing
 * @returns {Promise<import("./gen-lib.mjs").PiProvider>} the entry to publish
 */
async function emitOverrideOnly(row, tlsDisabled, catalog, catwalk) {
	const spec = row.spec;
	// catalogOnly rows never probe (docs/d033): the endpoint cannot
	// authenticate the probe's bearer, so no probe outcome means anything —
	// "credential-gated" would be a misleading verdict for an endpoint that
	// would 403 even with the key in hand. The models.dev slice IS the
	// lineup source. Superficial rows (docs/d064) are not smoke-tested, so
	// their probe would be a promise nothing maintains — same shortcut.
	if (spec.catalogOnly || row.facts.support === "superficial") {
		logInfo(
			spec.catalogOnly
				? "catalog-only provider — models.dev slice is the lineup source"
				: "superficial provider — not route-probed (docs/d064), catalog lineup",
			{ provider: spec.id },
		);
		return emitMinimalCatalogOverride(row, catalog, catwalk);
	}

	const route = await probeRow(row, tlsDisabled);
	// The probe only selects the LINEUP source — the emitted URL is canonical
	// either way (docs/d108).
	if (!route.usable) {
		logWarn(
			"no usable endpoint — lineup degrades to the catalog (docs/d108)",
			{ provider: spec.id },
		);
		return emitMinimalCatalogOverride(row, catalog, catwalk);
	}
	const models = listingModels(route.entries, spec);
	if (models) {
		logInfo("override models from the live listing", {
			provider: spec.id,
			models: models.length,
		});
		return providerReroute(row.facts.baseUrl, models);
	}
	// Route proved but not listable (401/403 without a key, or an unexpected
	// answer — reachable ≠ authenticated): the catalog mirrors the provider's
	// own ids, and the canonical base stands either way.
	return emitMinimalCatalogOverride(row, catalog, catwalk);
}

/**
 * Run the full-mode cascade for one row and write its layer file at the
 * CANONICAL fact-table upstream URL (docs/d070): the layer IS the provider
 * definition, so it is written every run — even with an empty lineup —
 * because an unwritten layer would leave a stale committed DIRECT block in
 * the merge (d063 §3). The probe only bounds the lineup: the endpoint's own
 * listing when it could be authenticated, else the catalog/facts cascade.
 * Full rows are first-class or best-effort (docs/d064), so they always get
 * the probe, and a `catalogOptional` row skips the catalog entirely — its
 * facts cache IS the lineup (docs/d057).
 * @param {ProviderRow} row the provider this stage emits
 * @param {boolean} tlsDisabled the runtime TLS state, from main
 * @param {CatalogDoc} catalog the run's parsed models.dev catalog
 * @param {string} layerDir where the `model-*.json` layers live this run
 * @returns {Promise<void>}
 */
async function emitFull(row, tlsDisabled, catalog, layerDir) {
	const spec = row.spec;
	const route = await probeRow(row, tlsDisabled);
	if (!route.usable) {
		logWarn(
			"no usable endpoint — lineup degrades to the catalog/facts cascade (docs/d108)",
			{ provider: spec.id },
		);
	}
	// The endpoint's own listing bounds a facts-sourced lineup when the probe
	// could authenticate it; empty entries (401/403 without a key) mean the
	// endpoint answered but says nothing, so nothing is bounded (docs/d033).
	const routeIds =
		route.usable && route.entries.length > 0
			? new Set(route.entries.map((e) => e.id))
			: null;
	/**
	 * The artifact's provider URL (docs/d070 §1): the fact table's real
	 * upstream, keyed by id — never string-derived from a configured base.
	 * @type {string}
	 */
	const canonicalUrl = row.facts.baseUrl;
	/**
	 * The published lineup, when this row has one: it decides WHICH ids
	 * publish, and the catalog is then only their metadata (docs/d189).
	 * @type {readonly LineupEntry[]|null}
	 */
	const lineup = spec.lineupResolver ? await spec.lineupResolver() : null;
	/**
	 * The bound on which catalog ids may publish: a published lineup is the
	 * whole bound for its row, and a row without one publishes its whole
	 * catalog slice.
	 * @type {Set<string>|null}
	 */
	const allow = lineup
		? new Set(lineup.map((entry) => entry.id))
		: null;
	const modelsDev = loadProvider(catalog, layerDir, spec);
	const catalogModels = Object.entries(modelsDev)
		.filter(
			([id, m]) =>
				// A retired catalog entry never publishes (docs/d048).
				catalogModelLive(m) &&
				// A lineup-only row takes no catalog records: its published lineup is
				// the whole contract, so the catalog cannot enrich it (docs/d189).
				!spec.lineupOnly &&
				(!spec.modelIdPrefix || id.startsWith(spec.modelIdPrefix)) &&
				(!allow || allow.has(id)),
		)
		.map(([, m]) => m);
	/** @type {PiAlternativeModel[]} */
	let models = catalogModels
		.map((m) => catalogPiModel(spec, m))
		.filter((m) => m !== null);

	if (lineup) {
		/**
		 * The table owns the display name as well: models.dev has published the
		 * raw id in that field, and a row named after its own id is worse than
		 * the published label (docs/d189).
		 * @type {Map<string, string>}
		 */
		const publishedNames = new Map(
			lineup.map((entry) => [entry.id, entry.name]),
		);
		for (const model of models) {
			const name = publishedNames.get(model.id);
			if (name) {
				model.name = name;
			}
		}
		/**
		 * A published id the catalog has no record for still publishes: the
		 * table is the contract and the catalog only its metadata, so a model
		 * models.dev has not caught up to lands with the table's display name
		 * and pi's schema defaults rather than vanishing (docs/d189).
		 */
		const published = new Set(models.map((m) => m.id));
		for (const entry of lineup) {
			if (published.has(entry.id)) {
				continue;
			}
			const model = catalogPiModel(spec, {
				id: entry.id,
				name: entry.name,
			});
			if (model) {
				models.push(model);
			}
		}
	}

	if (spec.facts) {
		// The fetch addresses the canonical upstream (docs/d108). Its ANSWER is
		// the whole lineup contract: there is no cache behind it to fall back
		// to, so a provider that cannot answer offers nothing (docs/d190, d191).
		const served = await fetchProviderFacts(
			row.facts,
			spec.facts,
			row.apiKey,
			tlsDisabled,
		);
		if (!served && spec.lineupFromFacts) {
			logWarn(
				"the provider's own source did not answer — the lineup is empty (docs/d190)",
				{ provider: spec.id },
			);
			models = [];
		} else if (!served) {
			logWarn("the provider did not answer — using catalog metadata", {
				provider: spec.id,
			});
		} else if (spec.lineupFromFacts || (models.length === 0 && spec.catalogOptional)) {
			models = factsLineup(spec, served, models, { routeIds, allow });
			logInfo("lineup taken from the facts source", {
				provider: spec.id,
				served: served.length,
				published: models.length,
				catalogNamed: models.filter((m) => m.name !== m.id).length,
				routeBounded: routeIds !== null,
			});
		} else {
			const { enriched, untouched } = enrichWithFacts(spec, models, served);
			models = [...enriched, ...untouched];
			logInfo("enriched from the live listing", {
				provider: spec.id,
				enriched: enriched.length,
				catalogOnlyKept: untouched.length,
			});
		}
	}

	if (models.length === 0) {
		// d063 §3: still written, empty — a stale committed DIRECT block must
		// never survive a successful regeneration.
		logWarn("no models resolved — writing an empty lineup", {
			provider: spec.id,
		});
	}
	const written = writeJsonArtifact(
		join(layerDir, /** @type {string} */ (spec.file)),
		{
			providers: {
				[spec.id]: {
					name: /** @type {string} */ (spec.name),
					baseUrl: canonicalUrl,
					api: "openai-completions",
					// pi resolves the key from the env at request time, and every
					// full row speaks the upstream's bearer form
					// (openai-completions — there is no non-bearer full row).
					apiKey: `$${spec.envKey}`,
					authHeader: true,
					...(spec.headers ? { headers: spec.headers } : {}),
					...(spec.compat ? { compat: spec.compat } : {}),
					models,
				},
			},
		},
	);
	logInfo("provider layer written", {
		provider: spec.id,
		path: written,
		baseUrl: canonicalUrl,
		models: models.length,
	});
}

/**
 * Run the override-only rows and return their provider entries. Catwalk is
 * fetched ONCE here, in memory, for the rows that union its view in
 * (docs/d048); it is not a cache a later run reads (docs/d191). The caller
 * publishes the result and runs the opencode-go docs cross-check.
 * @param {ProviderRow[]} rows the run's override-only rows
 * @param {CatalogDoc} catalog the run's parsed models.dev catalog
 * @param {boolean} tlsDisabled the runtime TLS state, from main
 * @returns {Promise<Record<string, import("./gen-lib.mjs").PiProvider>>}
 */
async function generateOverrideLayers(rows, catalog, tlsDisabled) {
	// No reverse-proxy base is required any more (docs/d108): probes address
	// each provider's canonical upstream and reach the edge through the
	// environment proxy. A probe that cannot answer only narrows the lineup to
	// the catalog — the emitted URL is canonical either way.
	const catwalk = await fetchCatwalkFacts(undefined, tlsDisabled);
	const results = await Promise.allSettled(
		rows.map((row) => emitOverrideOnly(row, tlsDisabled, catalog, catwalk)),
	);

	/** @type {Record<string, import("./gen-lib.mjs").PiProvider>} */
	const providers = {};
	let failed = 0;
	for (const [i, res] of results.entries()) {
		const row = rows[i];
		// results is rows.map()'s settle — the index always names a row; the
		// guard is the type gate's form, not a reachable state.
		if (row === undefined) {
			continue;
		}
		if (res.status === "rejected") {
			failed++;
			logError("provider spec failed — no layer written", {
				provider: row.spec.id,
				error: res.reason,
			});
			continue;
		}
		providers[row.spec.id] = res.value;
	}
	// d063 §4: a rejected row means an omitted provider — and omission is how
	// a direct URL gets back in (pi's built-in). One bad row fails the whole
	// cloud stage, and generate.mjs treats this generator's exit as fatal.
	if (failed) {
		throw new Error(
			`${failed} provider spec(s) failed — refusing to merge a partial cloud layer (docs/d063)`,
		);
	}
	return providers;
}

/**
 * Write the override-only layer from the entries the stage returned.
 * @param {string} layerDir where the `model-*.json` layers live this run
 * @param {Record<string, import("./gen-lib.mjs").PiProvider>} providers
 * @returns {void}
 */
function writeOverrideLayer(layerDir, providers) {
	const written = writeJsonArtifact(
		join(layerDir, "model-012-cloud-pi-native.json"),
		{ providers },
	);
	logInfo("pi-native override layer written", { path: written });
}

/**
 * Run the full-mode rows, each writing its own layer file.
 * @param {ProviderRow[]} rows the run's full-mode rows
 * @param {CatalogDoc} catalog the run's parsed models.dev catalog
 * @param {string} layerDir where the `model-*.json` layers live this run
 * @param {boolean} tlsDisabled the runtime TLS state, from main
 * @returns {Promise<void>}
 */
async function generateFullLayers(rows, catalog, layerDir, tlsDisabled) {
	const results = await Promise.allSettled(
		rows.map((row) => emitFull(row, tlsDisabled, catalog, layerDir)),
	);
	let failed = 0;
	for (const [i, res] of results.entries()) {
		const row = rows[i];
		// results is rows.map()'s settle — the index always names a row; the
		// guard is the type gate's form, not a reachable state.
		if (row === undefined) {
			continue;
		}
		if (res.status === "rejected") {
			failed++;
			logError("provider spec failed — no layer written", {
				provider: row.spec.id,
				error: res.reason,
			});
		}
	}
	// d063 §4: a rejected row means an omitted provider — and omission is how
	// a direct URL gets back in (pi's built-in). One bad row fails the whole
	// cloud stage, and generate.mjs treats this generator's exit as fatal.
	if (failed) {
		throw new Error(
			`${failed} provider spec(s) failed — refusing to merge a partial cloud layer (docs/d063)`,
		);
	}
}

/**
 * @param {import("./lib/cloud-providers.mjs").CloudProviderFacts} farm the
 *   fact table's local-farm row (`llama-swap`)
 * @param {string|undefined} apiKey the farm's key, from the caller's env
 * @param {boolean} tlsDisabled the runtime TLS state, from main
 * @param {string} out the layer file to write
 * @returns {Promise<void>}
 */
async function generateLocalLlamaSwap(farm, apiKey, tlsDisabled, out) {
	// The farm's tsnet serve hostname is both the probe candidate and the
	// emitted base. The LAN port is not routable from outside the serving host
	// (docs/d022).
	const local = await probeCandidates(
		[farm.baseUrl],
		(ids) => ids.some((id) => id.includes("-GGUF")),
		bearerHeaders(apiKey?.trim()),
		tlsDisabled,
	);
	if (!local) {
		// The farm answers for itself or not at all (docs/d190): d064's
		// stale-preserve is retired. An empty block, not an unwritten file —
		// leaving the file alone would let the merge republish the old lineup
		// from the previous layer.
		logWarn(
			"no local GGUF source reachable — the llama-swap lineup is empty (docs/d190)",
		);
	}
	const gguf = local?.entries.filter((e) => e.id.includes("-GGUF")) ?? [];
	// Canonical emission (docs/d070): providerEntry appends /v1 to the fact
	// table's upstream, and no install step rewrites it (docs/d108).
	/** @type {Record<string, import("./gen-lib.mjs").PiProvider>} */
	const providers = {
		"llama-swap": providerEntry(
			farm.baseUrl,
			gguf.map(piModel),
			Boolean(apiKey?.trim()),
		),
	};

	const written = writeJsonArtifact(out, { providers });
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
		if (!isPlainObject(layer)) {
			continue;
		}
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
 * Deep-merge every `model-*.json` layer in `layerDir`, lexical filename
 * order, into the merged artifact.
 * @param {string} layerDir the dir holding this run's layers
 * @param {string} out the merged file to write
 * @returns {void}
 */
function mergeModels(layerDir, out) {
	const overlayNames = readdirSync(layerDir)
		.filter((name) => /^model-.*\.json$/.test(name))
		.sort();
	const layers = overlayNames.map((name) => readJson(join(layerDir, name)));
	const written = writeJsonArtifact(out, deepMerge(...layers));
	logInfo("merged layers", { overlays: overlayNames.length, path: written });
}

/**
 * @typedef {object} SettingsSource
 * @property {string} [defaultProvider]
 * @property {string} [defaultModel]
 */

/**
 * Return the operator's hardcoded defaultProvider/defaultModel from
 * `settingsPath` as its own overlay file (docs/d036 — an OPERATOR DECISION,
 * not a probed fact). The caller resolves `settingsPath`: the driver points it
 * at the agent dir's settings.json after the settings-install stage, a manual
 * run reads the repo's committed copy.
 * @param {string} settingsPath the settings source
 * @param {string} outPath the overlay file to write
 * @returns {void}
 */
function generateDefaultModel(settingsPath, outPath) {
	let settings = /** @type {SettingsSource} */ ({});
	try {
		settings = /** @type {SettingsSource} */ (
			JSON.parse(readFileSync(settingsPath, "utf-8"))
		);
	} catch (err) {
		logWarn("settings source unreadable — no default model configuration", {
			path: settingsPath,
			error: err,
		});
	}

	const overlay = {};
	if (settings.defaultProvider) {
		overlay.defaultProvider = settings.defaultProvider;
	}
	if (settings.defaultModel) {
		overlay.defaultModel = settings.defaultModel;
	}

	if (overlay.defaultProvider && overlay.defaultModel) {
		logInfo("default model: operator-hardcoded pair returned as is", {
			provider: overlay.defaultProvider,
			model: overlay.defaultModel,
			from: settingsPath,
		});
	} else {
		logWarn(
			"settings source carries no defaultProvider/defaultModel — empty overlay written (pi's own default will apply)",
			{ path: settingsPath },
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

/**
 * THE entry point. Every side effect of this generator happens below this
 * line: the env, the argv, the fact table and the catalog are read here, and
 * each stage receives the values it consumes (plus the network, which the
 * probe helpers own).
 * @returns {Promise<void>}
 */
async function main() {
	setLogTool("coding-agent/generate-pi-coding-agent");
	const env = process.env;
	/**
	 * Where the `model-*.json` layers are written — and, in `mergeModels`,
	 * where they are read from — for THIS run. generate.mjs points
	 * $PI_LAYER_DIR at its per-run output dir; a manual run lands in the
	 * module's own dir, which is where the committed layers live.
	 *
	 * WHY the override exists (docs/d072): the retired d023 scratch staging
	 * gave every run a private layer dir that was committed back only after a
	 * fully successful generation — that is the property this preserves. It
	 * matters twice: `mergeModels` globs the whole dir, and the committed
	 * layers seed it before this run rewrites any (generate.mjs does that).
	 */
	const layerDir = env.PI_LAYER_DIR ?? scriptDir;
	mkdirSync(layerDir, { recursive: true });

	// The catalog THIS RUN fetched, sitting in the run's layer dir beside the
	// `model-*` layers because that dir IS the run (docs/d191). Absent ⇒
	// override-only rows still have catwalk; full rows fail their row, exactly
	// as before.
	const apiJson = join(layerDir, "models.dev.api.json");
	/** @type {CatalogDoc} */
	let catalog = null;
	try {
		catalog = /** @type {CatalogDoc} */ (
			JSON.parse(readFileSync(apiJson, "utf-8"))
		);
	} catch (err) {
		logWarn("models.dev catalog unreadable — full-mode rows cannot load", {
			path: apiJson,
			error: err,
		});
	}

	const tlsDisabled = env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
	if (tlsDisabled) {
		logWarn(
			"TLS verification disabled (NODE_TLS_REJECT_UNAUTHORIZED=0) — https endpoints fail closed; only plain-http emergency bases are used",
		);
	}

	// One row per provider: its spec, its fact-table row and the key this run
	// holds for it. The stages take rows, so a given emission cannot read
	// another provider's facts.
	const cloudProviders = readCloudProviders(cloudProvidersPath);
	/** @type {ProviderRow[]} */
	const rows = providerSpecs(cloudProviders, env).map((spec) => {
		const facts = providerFacts(cloudProviders, spec.id);
		return { spec, facts, apiKey: env[facts.apiKeyEnv] };
	});

	const modelsOut =
		process.argv[2] ?? env.PI_MODELS_JSON ?? join(scriptDir, "models.json");
	const defaultOut =
		process.argv[3] ??
		env.PI_DEFAULT_MODEL_JSON ??
		join(scriptDir, "default-model.json");
	const settingsPath = env.PI_SETTINGS ?? join(scriptDir, "settings.json");

	const farm = providerFacts(cloudProviders, "llama-swap");
	await runStage("local-llama-swap", () =>
		generateLocalLlamaSwap(
			farm,
			env[farm.apiKeyEnv],
			tlsDisabled,
			join(layerDir, "model-010-local-default.json"),
		),
	);
	// NOT via runStage: a failed cloud stage must fail the generator — the
	// merge after it would otherwise install the committed artifact, and an
	// omitted provider is exactly the direct-routing fallback d063 forbids.
	const overrideRows = rows.filter((row) => row.spec.mode !== "full");
	const overrides = await generateOverrideLayers(
		overrideRows,
		catalog,
		tlsDisabled,
	);
	writeOverrideLayer(layerDir, overrides);
	// The opencode-go docs table is a REFERENCE the listing is compared
	// against (docs/d048); one read per run, and only when the row published.
	const opencodeGo = overrides[OPENCODE_GO_ID];
	if (opencodeGo) {
		reportOpencodeGoDocsDrift(opencodeGo.models, docsModelIds(env));
	}
	await generateFullLayers(
		rows.filter((row) => row.spec.mode === "full"),
		catalog,
		layerDir,
		tlsDisabled,
	);
	await runStage("merge-models", () => mergeModels(layerDir, modelsOut));
	await runStage("default-model", () =>
		generateDefaultModel(settingsPath, defaultOut),
	);
}

if (import.meta.main) {
	main().catch((err) => {
		logError("pi generator failed — nothing merged", { error: err });
		process.exit(1);
	});
}
