/**
 * @fileoverview sources.mjs — the data sources of the ClinePass lineup, and
 * the ONE reconciliation contract between them.
 *
 * Why the provider's own listing is NOT a source here (docs/d040, the fleet's
 * cline-pass row): `GET <baseUrl>/models` at api.cline.bot answers with the
 * catalog of the `cline` (usage-billing) provider — a DIFFERENT provider —
 * so syncing against it would prune the real ClinePass lineup and append
 * hundreds of wrong-priced ids. The lineup comes from the two published
 * sources the fleet reconciles instead:
 *
 *   - Cline's docs table (`docs/getting-started/clinepass.mdx` in the
 *     cline/cline repo, `## Models` section) — the SUBSCRIPTION CONTRACT:
 *     the ids ClinePass currently serves, in the `cline-pass/` namespace.
 *   - the models.dev `cline-pass` slice — the METADATA (prices, limits,
 *     modalities, effort enums) and catalog-first lineup additions.
 *
 * `resolveAllowlist` is the fleet's `resolveClinePassAllowlist`
 * (coding-agent/generate-pi-coding-agent.mjs, docs/d040) in miniature: a
 * docs ∪ catalog union when at least CLINE_PASS_MATCH_FLOOR of the docs
 * table still appears in the slice, else the committed fallback lineup. The
 * floor is the self-check against both failure modes at once — a models.dev
 * pollution dump (the whole `cline` catalog dumped under `cline-pass`) and
 * a docs-table reshape (ids stop parsing).
 *
 * The prefix guard is a BILLING fact, not tidiness: a ClinePass id served
 * without the `cline-pass/` prefix bills at standard API pricing instead of
 * the subscription, and models.dev intermittently mislabels `cline`-provider
 * rows under neighboring provider keys. Every consumer filters on
 * CLINE_PASS_ID_PREFIX before publishing a row (docs/d040).
 *
 * Failure contract, mirroring the fleet and pi-synthetic:
 *   - a failed catalog fetch THROWS: the committed artifacts (written
 *     atomically, lib/artifact.mjs) are the offline fallback, and a run
 *     with no metadata source has nothing to publish;
 *   - an unreadable docs table degrades to the committed fallback lineup
 *     with a warning: a missing markdown file says nothing about whether
 *     the subscription still serves its models.
 * Neither fetch URL is recorded in logs (docs/d086).
 *
 * Env: LIB_DIR (lib/ resolution override, docs/d023) and CLINE_PASS_MDX —
 * a plain local copy of the docs file, the fleet's git-mirror override
 * kept here because the docs source is published markdown, not an API.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");

const { logDebug, logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);

setLogTool("pi-cline-pass/sources");

/**
 * The fact-table row this folder exists for (lib/cloud-providers.mjs,
 * docs/d024): the ONE place the upstream URL and the key env are declared,
 * and the source of the canonical URL the committed artifact carries
 * (docs/d070).
 */
const CLINE_PASS = CLOUD_PROVIDERS["cline-pass"];

/** @type {string} the provider's canonical upstream. */
export const CLINE_PASS_BASE_URL = CLINE_PASS.baseUrl;
/** @type {string} the env var holding the real key. */
export const CLINE_PASS_API_KEY_ENV = CLINE_PASS.apiKeyEnv;
/** @type {string} the provider id pi namespaces model ids under. */
export const CLINE_PASS_PROVIDER_ID = CLINE_PASS.id;
/** @type {string} the display name (the fact table's label, docs/d024). */
export const CLINE_PASS_NAME = CLINE_PASS.label;

/**
 * The namespace every ClinePass model id carries — the provider's own API
 * contract (the id is what bills the subscription, docs/d040) and the
 * structural guard against models.dev mislabeling the neighboring `cline`
 * catalog's rows into this slice.
 * @type {string}
 */
export const CLINE_PASS_ID_PREFIX = `${CLINE_PASS_PROVIDER_ID}/`;

/**
 * models.dev's canonical catalog URL — the metadata source. Public, no key,
 * and deliberately NOT redirectable by env: one canonical fetch, the same
 * no-redirect-surface contract pi-synthetic's listing fetch keeps.
 * @type {string}
 */
const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Cline's published docs table at its canonical raw-file URL — the lineup
 * contract source. CLINE_PASS_MDX overrides the READ (a plain local copy,
 * e.g. `git show HEAD:docs/getting-started/clinepass.mdx` from the fleet's
 * git mirror) but never the network source this folder otherwise uses.
 * @type {string}
 */
const CLINE_PASS_DOCS_URL =
	"https://raw.githubusercontent.com/cline/cline/main/docs/getting-started/clinepass.mdx";

/**
 * The committed last-known-good lineup — the fallback when the docs table
 * cannot be read or no longer agrees with the catalog. Transcribed from the
 * published `## Models` table, exactly as the fleet's CLINE_PASS_LINEUP
 * constant in coding-agent/generate-pi-coding-agent.mjs; the two are
 * siblings by provenance, and a deliberate lineup contraction must land in
 * both (docs/d040 owns the reconciliation contract).
 * @type {readonly string[]}
 */
export const CLINE_PASS_LINEUP = Object.freeze([
	"cline-pass/glm-5.3",
	"cline-pass/glm-5.3-flash",
	"cline-pass/kimi-k3",
	"cline-pass/deepseek-v4-pro",
	"cline-pass/deepseek-v4.1-flash",
	"cline-pass/mimo-v2.5",
	"cline-pass/mimo-v2.5-pro",
	"cline-pass/minimax-m3",
	"cline-pass/muse-spark-1.3-contributor",
	"cline-pass/qwen3.8-max",
	"cline-pass/qwen3.7-max",
	"cline-pass/qwen3.7-plus",
]);

/**
 * Minimum fraction of the docs table that must also appear in the catalog
 * slice before either source is trusted (docs/d040, fleet parity). Genuine
 * lineup churn keeps the ratio near 1 and self-adopts; a pollution dump or
 * a docs reshape drives it toward zero and the committed lineup wins
 * instead of a wrong-priced one.
 * @type {number}
 */
export const CLINE_PASS_MATCH_FLOOR = 0.8;

const REQUEST_TIMEOUT_MS = 15000;
const MODEL_STORE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * A models.dev model record — the subset this folder reads. Every field is
 * optional, including the identity: the catalog's map KEY is the row this
 * folder publishes (the prefix guard filters keys; merge.mjs trusts no body
 * id), and the source may stop publishing any other field at any time,
 * degrading field by field.
 * @typedef {object} CatalogRecord
 * @property {string} [id] a body id may exist but is never trusted — the
 *   map key wins (the prefix is a billing contract, docs/d040)
 * @property {string} [name]
 * @property {string} [family]
 * @property {boolean} [reasoning]
 * @property {{ input?: string[], output?: string[] }} [modalities]
 * @property {{ context?: number, output?: number }} [limit]
 * @property {{ input?: number, output?: number, cache_read?: number, cache_write?: number }|null} [cost]
 *   `null`/absent = no published prices (docs/d057: nothing is rendered);
 *   `cache_write` is commonly absent from the wire and completes to zero at
 *   shaping time (fleet `toCost` semantics)
 * @property {Array<{ type?: string, values?: string[] }>} [reasoning_options]
 *   the published effort enum — the ONLY source of thinking levels
 */

/**
 * One catalog fetch: the canonical models.dev URL, sliced to the cline-pass
 * provider record's models. Injectable fetch so tests exercise the parse
 * with no network.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl] injected by tests
 * @returns {Promise<Record<string, CatalogRecord>>} the slice, keyed by the
 *   catalog's own (prefixed) ids — unfiltered; the prefix guard is applied
 *   by resolveAllowlist and shapeCatalog, not here
 * @throws {Error} on a transport failure, a non-2xx answer, or a payload
 *   with no cline-pass slice — the caller has nothing to publish, and the
 *   committed artifact is the fallback rather than a stale regeneration
 */
export async function fetchCatalogSlice({ signal, fetchImpl = fetch } = {}) {
	logDebug("fetching models.dev catalog", { provider: CLINE_PASS_PROVIDER_ID });
	const res = await fetchImpl(MODELS_DEV_URL, {
		signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(
			`models.dev catalog answered ${res.status} — nothing to publish`,
		);
	}
	const payload = /** @type {unknown} */ (await res.json());
	const provider = /** @type {{ models?: Record<string, CatalogRecord> }|undefined} */ (
		/** @type {Record<string, unknown>|undefined} */ (payload)?.[
			CLINE_PASS_PROVIDER_ID
		]
	);
	const slice = provider?.models;
	if (!slice || typeof slice !== "object" || Object.keys(slice).length === 0) {
		throw new Error("models.dev carries no cline-pass models — nothing to publish");
	}
	logDebug("models.dev catalog answered", { rows: Object.keys(slice).length });
	return slice;
}

/**
 * Parse the `## Models` GFM table from Cline's published clinepass.mdx and
 * return the model ids WITH their `cline-pass/` prefix — the namespace the
 * API bills under, so no consumer re-derives it. Scoped to that section
 * because the later `## Reference pricing` table is a different shape
 * (peak/off-peak and token-tier rows with display-only names). Returns null
 * when the section is absent or carries no prefixed id.
 * @param {string} mdx the raw docs file
 * @returns {string[]|null}
 */
export function parseClinePassDocs(mdx) {
	const section = mdx.split(/^## Models\s*$/m)[1]?.split(/^## /m)[0];
	if (!section) return null;
	/** @type {string[]} */
	const ids = [];
	for (const line of section.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		const cells = trimmed
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		const raw = cells[1]?.replace(/`/g, "");
		if (raw?.startsWith(CLINE_PASS_ID_PREFIX)) ids.push(raw);
	}
	return ids.length > 0 ? ids : null;
}

/**
 * The docs table's id list, from a local copy (CLINE_PASS_MDX) or the
 * canonical raw URL. UNLIKE the catalog fetch this NEVER throws: the docs
 * source is one of two lineup inputs, and its absence degrades to the
 * committed fallback lineup (resolveAllowlist) rather than failing a run
 * whose metadata source answered.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl] injected by tests
 * @returns {Promise<string[]|null>}
 */
export async function fetchDocsIds({ signal, fetchImpl = fetch } = {}) {
	try {
		const explicit = process.env.CLINE_PASS_MDX;
		let mdx;
		if (explicit) {
			mdx = readFileSync(explicit, "utf-8");
		} else {
			const res = await fetchImpl(CLINE_PASS_DOCS_URL, {
				signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`docs file answered ${res.status}`);
			mdx = await res.text();
		}
		const ids = parseClinePassDocs(mdx);
		if (!ids) throw new Error("no ## Models table with prefixed ids");
		return ids;
	} catch (err) {
		logWarn("cline-pass docs lineup unreadable", { error: err });
		return null;
	}
}

/**
 * The lineup contract for one run: the UNION of the docs table and the
 * catalog slice when the two still agree, else the committed fallback —
 * the fleet's reconciliation (docs/d040), pure over its inputs so the
 * generator and the extension resolve identically and tests need neither
 * source on the wire.
 * @param {string[]|null} docsIds the parsed docs table, or null when it
 *   could not be read
 * @param {Record<string, CatalogRecord>} records the fetched cline-pass
 *   slice
 * @returns {readonly string[]} the allowlist ids (catalog-namespace)
 */
export function resolveAllowlist(docsIds, records) {
	if (docsIds?.length === 0) {
		logWarn("cline-pass docs lineup unavailable — using committed lineup", {
			fallback: CLINE_PASS_LINEUP.length,
		});
		return CLINE_PASS_LINEUP;
	}
	const catalogKeys = new Set(
		Object.keys(records).filter((id) => id.startsWith(CLINE_PASS_ID_PREFIX)),
	);
	const matched = docsIds.filter((id) => catalogKeys.has(id));
	const ratio = matched.length / docsIds.length;
	if (ratio < CLINE_PASS_MATCH_FLOOR) {
		logWarn("cline-pass docs/catalog disagree — keeping committed lineup", {
			docs: docsIds.length,
			matched: matched.length,
			ratio,
			floor: CLINE_PASS_MATCH_FLOOR,
		});
		return CLINE_PASS_LINEUP;
	}
	/**
	 * Union: docs ids first (the published contract), then catalog-only ids
	 * (catalog-first additions the docs table has not caught up to) —
	 * shapeCatalog intersects with the slice anyway, so docs-only ids
	 * simply find no record to emit.
	 */
	const union = [...new Set([...docsIds, ...catalogKeys])];
	logInfo("cline-pass lineup adopted as docs ∪ catalog union", {
		docs: docsIds.length,
		matched: matched.length,
		catalogOnlyAdopted: catalogKeys.size - matched.length,
		union: union.length,
	});
	return union;
}

/**
 * Whether a persisted model store is still inside the refresh TTL.
 * @param {number} checkedAt epoch ms of the stored catalog
 * @returns {boolean}
 */
export function storeIsFresh(checkedAt) {
	return Date.now() - checkedAt < MODEL_STORE_TTL_MS;
}
