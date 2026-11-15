/**
 * @fileoverview sources.mjs — the ONE published source of the ClinePass
 * catalog, and the read that carries it:
 *
 *   - Cline's docs table (docs/getting-started/clinepass.mdx in the
 *     cline/cline repo, ## Models section) — the lineup: which ids ClinePass
 *     serves, in the cline-pass/ namespace, and the display name of each.
 *     Nothing else adds an id and nothing else describes one.
 *
 * models.dev was the second read, and it retired (docs/d189's amendment): its
 * price column is a reference rate a subscriber never pays, the fields it could
 * add disagreed with the vendor's own package on most rows of the table, and it
 * could never widen the lineup — so an unreadable catalog cost the provider its
 * whole catalog to protect fields nobody could check. A successful table parse
 * now ends the run: one fetch, no catalog request.
 *
 * Why the provider's own listing is NOT a source (docs/d040, the fleet's
 * cline-pass row): GET <baseUrl>/models at api.cline.bot answers with the
 * catalog of the cline (usage-billing) provider — a DIFFERENT provider — so
 * syncing against it would prune the real ClinePass lineup and append hundreds
 * of wrong-priced ids.
 *
 * The prefix guard is a BILLING fact, not tidiness: a ClinePass id served
 * without the cline-pass/ prefix bills at standard API pricing instead of the
 * subscription. Every consumer filters on CLINE_PASS_ID_PREFIX before
 * publishing a row (docs/d040).
 *
 * Failure contract: the read THROWS. An unreadable table means there is
 * nothing to publish, and "ClinePass is unavailable" is the answer — never a
 * remembered list (docs/d189). The artifact a successful run wrote stays in
 * place; a failed run writes nothing. The fetch URL is never recorded in logs
 * (docs/d086).
 *
 * Env: CLINE_PASS_MDX — a plain local copy of the docs file, for a host that
 * pins the table instead of fetching it.
 */
import { readFileSync } from "node:fs";

import { logInfo, setLogTool } from "./log.mjs";

setLogTool("pi-cline-pass/sources");

/**
 * The provider facts this folder exists for (docs/d024): the ONE place the
 * upstream URL and the key env are declared, and the source of the canonical
 * URL the committed artifact carries (docs/d070).
 *
 * A frozen literal rather than a loaded fact table: an extension serves
 * exactly one provider, so a row here cannot be missing and nothing has to
 * guard for that. `support` is docs/d064's tier for this row — how much
 * lineup/liveness work the generators do for it — carried with the data so
 * the folder still states it.
 * @type {Readonly<{
 *   id: string,
 *   label: string,
 *   apiKeyEnv: string,
 *   baseUrl: string,
 *   support: string,
 * }>}
 */
export const CLINE_PASS = Object.freeze({
	id: "cline-pass",
	label: "ClinePass",
	apiKeyEnv: "CLINE_API_KEY",
	baseUrl: "https://api.cline.bot/api/v1",
	support: "first-class",
});

/** @type {string} the provider's canonical upstream. */
export const CLINE_PASS_BASE_URL = CLINE_PASS.baseUrl;
/** @type {string} the env var holding the real key. */
export const CLINE_PASS_API_KEY_ENV = CLINE_PASS.apiKeyEnv;
/** @type {string} the provider id pi namespaces model ids under. */
export const CLINE_PASS_PROVIDER_ID = CLINE_PASS.id;
/** @type {string} the display name (the row's label, docs/d024). */
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
 * Cline's published docs table at its canonical raw-file URL — the lineup
 * contract source. CLINE_PASS_MDX overrides the READ (a plain local copy,
 * e.g. `git show HEAD:docs/getting-started/clinepass.mdx` from the fleet's
 * git mirror) but never the network source this folder otherwise uses.
 * @type {string}
 */
const CLINE_PASS_DOCS_URL =
	"https://raw.githubusercontent.com/cline/cline/main/docs/getting-started/clinepass.mdx";

/**
 * One row of the published ## Models table: the id the gateway bills under
 * (already in the cline-pass/ namespace) and the display name the table gives
 * it.
 * @typedef {object} LineupEntry
 * @property {string} id
 * @property {string} name
 */

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The request signal: the CALLER's cancellation composed with this folder's own
 * deadline. Both, never either — `signal ?? AbortSignal.timeout(…)` was the
 * first shape here and it silently dropped the ceiling on every real refresh,
 * because pi always hands a concrete signal (pi-ai's RefreshModelsContext): a
 * revoked refresh then waited on an upstream that never answers, which is the
 * hang d045 says the step owning the I/O must report instead.
 * @param {AbortSignal} [caller] pi's signal, when the caller has one
 * @returns {AbortSignal}
 */
function requestSignal(caller) {
	return caller
		? AbortSignal.any([caller, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
		: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}
const MODEL_STORE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Parse the `## Models` GFM table from Cline's published clinepass.mdx and
 * return one entry per row: the id WITH its `cline-pass/` prefix (the
 * namespace the API bills under) and the display name in the table's first
 * column, so no consumer re-derives either. Scoped to that section because
 * the later `## Reference pricing` table is a different shape (peak/off-peak
 * and token-tier rows with display-only names). Returns null when the
 * section is absent or carries no prefixed id.
 * @param {string} mdx the raw docs file
 * @returns {LineupEntry[]|null}
 */
export function parseClinePassDocs(mdx) {
	const section = mdx.split(/^## Models\s*$/m)[1]?.split(/^## /m)[0];
	if (!section) {
		return null;
	}
	/** @type {LineupEntry[]} */
	const lineup = [];
	for (const line of section.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) {
			continue;
		}
		const cells = trimmed
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		const id = cells[1]?.replace(/`/g, "");
		if (!id?.startsWith(CLINE_PASS_ID_PREFIX)) {
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
 * The published lineup, from a local copy (CLINE_PASS_MDX) or the canonical
 * raw URL. THROWS on every failure: without the table there is no lineup to
 * publish, and "ClinePass is unavailable" is the answer rather than a
 * remembered list (docs/d189).
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl] injected by tests
 * @returns {Promise<LineupEntry[]>}
 * @throws {Error} on an unreadable override, a transport failure, a non-2xx
 *   answer, or a file with no ## Models table
 */
export async function fetchDocsLineup({ signal, fetchImpl = fetch } = {}) {
	const explicit = process.env.CLINE_PASS_MDX;
	let mdx;
	if (explicit) {
		mdx = readFileSync(explicit, "utf-8");
	} else {
		const res = await fetchImpl(CLINE_PASS_DOCS_URL, {
			signal: requestSignal(signal),
		});
		if (!res.ok) {
			throw new Error(`cline-pass docs answered ${res.status} — nothing to publish`);
		}
		mdx = await res.text();
	}
	const lineup = parseClinePassDocs(mdx);
	if (!lineup) {
		throw new Error("clinepass.mdx carries no ## Models table — nothing to publish");
	}
	logInfo("cline-pass lineup read from the published table", {
		models: lineup.length,
	});
	return lineup;
}

/**
 * Whether a persisted model store is still inside the refresh TTL.
 * @param {number} checkedAt epoch ms of the stored catalog
 * @returns {boolean}
 */
export function storeIsFresh(checkedAt) {
	return Date.now() - checkedAt < MODEL_STORE_TTL_MS;
}
