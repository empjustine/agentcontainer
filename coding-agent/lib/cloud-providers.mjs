/**
 * @fileoverview cloud-providers.mjs — loader + derived projections of the ONE
 * fact table for the providers every generator family touches (docs/d024):
 * provider id, display label, the env var holding the provider's real key, and
 * its real (default) base URL. Only the per-family *rendering* stays local
 * (pi-shaped layer vs opencode V1 config vs llama-swap entry).
 *
 * The rows themselves live in `cloud-providers.json` (docs/d102): the table is
 * DATA, so the estige generator and every node generator read the SAME bytes and
 * no projection copy can drift from the deployed allowlist. Row-level WHY rides
 * the rows as `note` strings, so the reasoning travels with the data.
 *
 * The table is d070's canonical-URL source: committed and installed artifacts
 * carry these `baseUrl`s verbatim, and the verifier's host set is built from
 * them — one source for "which upstream does this provider sit on".
 *
 * Import via the LIB_DIR convention (docs/d023/d113): consumers resolve this
 * file through `process.env.LIB_DIR ?? <their own dir>/lib`, so a folder
 * copied out of this tree reads its own copy, not a sibling's.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The stable facts of a provider — the part every family agrees on.
 * `baseUrl` is the provider's REAL endpoint: the upstream the deployed
 * estige allowlist keys on (its HOST, and the base path the
 * client route carries client-side — docs/d047), the URL committed
 * artifacts embed verbatim (docs/d070), and the source for the
 * fact-table facts endpoint. Generators never REQUEST it directly — probes
 * walk client routes (docs/d063) and generate substitutes the route at
 * install (d070 §3); estige fetches it as the allowlist
 * upstream.
 * @typedef {object} CloudProviderFacts
 * @property {string} id provider id (matches pi's and opencode's
 *   built-in provider names and the llama-swap farm id)
 * @property {string} label human-readable name (opencode config renderer)
 * @property {string} apiKeyEnv env var holding the provider's real key, used
 *   for the facts-refresh bearer and the `${env.*}` reference emitted
 *   layers carry — never inlined into an emitted artifact
 * @property {string} baseUrl the provider's real default endpoint (upstream
 *   for the proxy allowlist; canonical artifact URL, docs/d070)
 * @property {SupportTier} support docs/d064's promise for this row — how
 *   much line-up/liveness work the generators do for it
 * @property {string} [note] why this row looks the way it does — the
 *   row-level rationale, carried with the data since the table became JSON
 *   (docs/d102)
 */

/**
 * docs/d064's support tiers — what this repo PROMISES per provider:
 * `first-class` (full lineup cascade, regressions are fix priorities,
 * publishes nothing when its source cannot answer, docs/d190), `best-effort`
 * (same cascade, fixed when convenient), `superficial` (proxy-level support +
 * metadata presence only, not smoke-tested, metadata may be stale).
 * @typedef {"first-class"|"best-effort"|"superficial"} SupportTier
 */

/** @type {ReadonlySet<string>} */
const SUPPORT_TIERS = new Set(["first-class", "best-effort", "superficial"]);

/**
 * Row order is preserved because the estige generator's collapse logs follow
 * it, so node and Go agree byte for byte. A malformed row is a broken repo,
 * not a downstream surprise: d024's one-table contract is only worth as much
 * as this gate.
 * @returns {Readonly<Record<string, CloudProviderFacts>>}
 */
function loadCloudProviders() {
	const path = fileURLToPath(new URL("./cloud-providers.json", import.meta.url));
	const rows = /** @type {CloudProviderFacts[]} */ (
		JSON.parse(readFileSync(path, "utf-8"))
	);
	/** @type {Record<string, CloudProviderFacts>} */
	const byId = {};
	for (const row of rows) {
		const candidate = /** @type {Record<string, unknown>} */ (row);
		const missing = ["id", "label", "apiKeyEnv", "baseUrl", "support"].filter(
			(field) => typeof candidate[field] !== "string",
		);
		if (missing.length > 0 || !SUPPORT_TIERS.has(row.support)) {
			throw new Error(
				`lib/cloud-providers.json has a malformed row (${String(row.id)}): ${missing.join(", ") || "unknown support tier"}`,
			);
		}
		byId[row.id] = Object.freeze(row);
	}
	return Object.freeze(byId);
}

/** @type {Readonly<Record<string, CloudProviderFacts>>} */
export const CLOUD_PROVIDERS = loadCloudProviders();

/**
 * One row's docs/d064 support tier. The fleet table (incl. the local
 * llama-swap farm) is all that gets a promise; everything outside it is
 * superficial: this repo promises nothing about providers it does not track.
 * @param {string} id fact-table provider id
 * @returns {SupportTier}
 */
export function supportTier(id) {
	return CLOUD_PROVIDERS[id]?.support ?? "superficial";
}

/**
 * One row's facts, refusing a missing id loudly. The table is the ONE home
 * for provider facts (this file, docs/d024): a consumer asking for a row
 * that is not there is a broken repo or a typo, and both deserve the same
 * loud stop — not undefined facts flowing downstream into an artifact.
 * @param {string} id fact-table provider id
 * @returns {CloudProviderFacts}
 */
export function providerFacts(id) {
	const facts = CLOUD_PROVIDERS[id];
	if (facts === undefined) {
		throw new Error(`lib/cloud-providers.mjs lost the ${id} row`);
	}
	return facts;
}

/**
 * The pi-native cloud providers: providers pi-coding-agent ships natively,
 * where a layer is only ever an override ("swap only baseUrl"). cline-pass is
 * deliberately absent (pi does NOT ship it natively — the authoritative
 * full-block layer is generate-pi-coding-agent.mjs's full rows, docs/d022), and
 * so are hyper, inferx and verboo (same reasoning, model-016..model-018).
 * `nvidia` is pi-native against the cloud NIM endpoint (docs/d028), and
 * `google` gains a route because the router forwards its native dialect
 * untouched (docs/d027).
 *
 * There is no `openai` row: nothing here consumes api.openai.com — "openai"
 * only ever appears as the API *shape* other providers speak.
 * @type {readonly string[]}
 */
export const PI_NATIVE_CLOUD_IDS = Object.freeze([
	"openrouter",
	"opencode",
	"opencode-go",
	"mistral",
	"google",
	"nvidia",
]);

/**
 * Every row's baseUrl as a list — the CANONICAL upstreams (docs/d070) a
 * committed artifact carries and an installed one must not.
 * @type {readonly string[]}
 */
const FACT_UPSTREAMS = Object.freeze(
	Object.values(CLOUD_PROVIDERS).map((f) => f.baseUrl),
);

/**
 * The upstreams' hostnames. d070's v2 route form embeds the upstream host as
 * a path segment (`<base>/<host>/…`, docs/d047), so a matching segment is the
 * structural marker that a URL under a colliding base host is routed rather
 * than canonical — the bazzite funnel and the bazzite llama-swap row share a
 * host (docs/d027), and a host-set check on the BASE would flag every
 * install there.
 * @type {ReadonlySet<string>}
 */
export const FACT_HOSTS = new Set(FACT_UPSTREAMS.map((u) => new URL(u).host));
