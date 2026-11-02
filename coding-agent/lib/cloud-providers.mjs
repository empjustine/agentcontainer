/**
 * @fileoverview cloud-providers.mjs — loader + derived projections of the
 * ONE fact table for the providers every generator family touches
 * (docs/d023 c3/c4 follow-up, docs/d024): provider id, display label, the
 * env var holding the provider's real key, and the provider's real (default)
 * base URL. Previously these facts were re-declared per family with drifting
 * field names (`generate-models.json.mjs` `baseUrl`, `generate-opencode.mjs`
 * `realBase`, `llm-local-inference/gen-lib.mjs` `defaultBaseUrl`) — a
 * base-url or key-env change needed two/three edits in files with different
 * output renderers. Now every consumer derives from this table and only the
 * per-family *rendering* stays local (pi-shaped layer vs opencode V1 config
 * vs llama-swap entry).
 *
 * The rows themselves live in `cloud-providers.json` (docs/d102): the table
 * is DATA, so the estige generator — all-Go since d102 — and every node
 * generator read the SAME bytes, and no projection copy can drift from the
 * deployed allowlist. This module is the node-facing half: it loads the JSON
 * with its row-order intact, validates it loudly, and derives the typed
 * exports below. Row-level WHY (full-base-path rationale, catalog gaps) rides
 * the rows as `note` strings, so the reasoning travels with the data.
 *
 * The table is d070's canonical-URL source: committed and installed artifacts
 * carry these `baseUrl`s verbatim, and the verifier's host set is built from
 * them — one source for "which upstream does this provider sit on" (docs/d070).
 * The route derivation and the proxy allowlist that also read this table are
 * gone with the reverse proxy (docs/d108).
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
 * stale-preserve on outages), `best-effort` (same cascade, fixed when
 * convenient), `superficial` (proxy-level support + metadata presence only,
 * not smoke-tested, metadata may be stale).
 * @typedef {"first-class"|"best-effort"|"superficial"} SupportTier
 */

/** @type {ReadonlySet<string>} */
const SUPPORT_TIERS = new Set(["first-class", "best-effort", "superficial"]);

/**
 * Load + validate the shared table, preserving the JSON's row order (the
 * estige generator's collapse logs follow it, so node and Go agree byte for
 * byte). A malformed row is a broken repo, not a downstream surprise: every
 * field the typedef promises is checked here, loudly (docs/d024's one-table
 * contract is only worth as much as this gate).
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
 * where a
 * layer is only ever an override ("swap only baseUrl"). cline-pass
 * is deliberately absent (pi does NOT ship it natively — the authoritative
 * full-block layer is owned by generate-pi-coding-agent.mjs's full rows,
 * docs/d022), and so are hyper, inferx and verboo (same reasoning, model-016,
 * model-017 and model-018). `google` IS
 * pi-native (built-in google provider, google-generative-ai wire format) and
 * gains a client route only since the simplified router forwards its
 * native dialect untouched (docs/d027) — previously Google could never be
 * routed and silently relied on direct reachability. `nvidia` IS
 * pi-native too (built-in openai-completions provider against the cloud NIM
 * endpoint, no local hardware — docs/d028).
 * There is no
 * `openai` provider in this table and never was: no
 * route or generator here consumes api.openai.com and no OPENAI_API_KEY
 * exists — "openai" only ever appears as the API *shape* other providers
 * (opencode, opencode-go, cline-pass, ...) speak.
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
 * The table's baseUrl per id — the projection every URL-shape rule needs
 * (route derivation in route-probe.mjs, the d070 verifier, install-time
 * substitution). Kept here rather than re-derived in each consumer so an
 * artifact can never be checked against a stale copy of the table.
 * @type {Readonly<Record<string, string>>}
 */
export const PROVIDER_BASE_URLS = Object.freeze(
	Object.fromEntries(
		Object.entries(CLOUD_PROVIDERS).map(([id, f]) => [id, f.baseUrl]),
	),
);

/**
 * Every row's baseUrl as a list — the CANONICAL upstreams (docs/d070 §1) a
 * committed artifact carries and an installed one must not.
 * @type {readonly string[]}
 */
export const FACT_UPSTREAMS = Object.freeze(
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
