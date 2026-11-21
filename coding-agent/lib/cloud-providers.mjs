/**
 * @fileoverview cloud-providers.mjs — the ONE fact table for the providers
 * every generator family touches (docs/d024): provider id, display label, the
 * env var holding the provider's real key, and its real (default) base URL.
 * Only the per-family *rendering* stays local (pi-shaped layer vs opencode V1
 * config vs llama-swap entry).
 *
 * PURE BY CONTRACT. This module reads no file, loads no table and answers no
 * lookup from state the caller did not pass. A caller either parses bytes it
 * holds (parseCloudProviders) or reads the table once (readCloudProviders) and
 * then passes the resulting record to providerFacts, factHosts or the emitted
 * entry builders (which read `row.support` straight off the row).
 * That is what makes these functions testable against a five-row fixture, and
 * what stops a "predicate" from silently answering out of a file read nobody
 * at the call site can see.
 *
 * The rows themselves live in `cloud-providers.json` (docs/d102): the table is
 * DATA, so the estige generator and every node generator read the SAME bytes and
 * no projection copy can drift from the deployed allowlist. Row-level WHY rides
 * the rows as `note` strings, so the reasoning travels with the data.
 *
 * The table is d070's canonical-URL source: committed and installed artifacts
 * carry these `baseUrl`s verbatim, and the verifier's host set is built from
 * them — one source for "which upstream does this provider sit on".
 */

import { readFileSync } from "node:fs";

/**
 * The stable facts of a provider — the part every family agrees on.
 * `baseUrl` is the provider's REAL endpoint: the URL committed artifacts embed
 * verbatim (docs/d070/d108) and the base a probe addresses through the
 * environment proxy (docs/d074). Nothing in the tree rewrites it.
 * @typedef {object} CloudProviderFacts
 * @property {string} id provider id (matches pi's and opencode's
 *   built-in provider names and the llama-swap farm id)
 * @property {string} label human-readable name (opencode config renderer)
 * @property {string} apiKeyEnv env var holding the provider's real key, used
 *   for the facts-refresh bearer and the `${env.*}` reference emitted
 *   layers carry — never inlined into an emitted artifact
 * @property {string} baseUrl the provider's real default endpoint (canonical
 *   artifact URL, docs/d070)
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
 * @param {string} text the table's JSON bytes
 * @returns {Readonly<Record<string, CloudProviderFacts>>}
 */
export function parseCloudProviders(text) {
	const rows = /** @type {CloudProviderFacts[]} */ (JSON.parse(text));
	if (!Array.isArray(rows)) {
		throw new Error("lib/cloud-providers.json must be a JSON array of rows");
	}
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

/**
 * Read and parse the table. The I/O happens at THIS call, with the caller's
 * path: a test reads a fixture, a copied unit reads its own `lib/` copy, and
 * no import of this module touches the filesystem.
 * @param {string} path the json file to read
 * @returns {Readonly<Record<string, CloudProviderFacts>>}
 */
export function readCloudProviders(path) {
	return parseCloudProviders(readFileSync(path, "utf-8"));
}

/**
 * One row's facts, refusing a missing id loudly. The table is the ONE home
 * for provider facts (this file, docs/d024): a consumer asking for a row
 * that is not there is a broken repo or a typo, and both deserve the same
 * loud stop — not undefined facts flowing downstream into an artifact.
 * @param {Readonly<Record<string, CloudProviderFacts>>} providers the table
 * @param {string} id fact-table provider id
 * @returns {CloudProviderFacts}
 */
export function providerFacts(providers, id) {
	const facts = providers[id];
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
 * `google` gains a route because pi speaks its native dialect (docs/d027).
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
 * The base-url env var a row accepts, derived from its key env the way Azure
 * OpenAI spells the pair (AZURE_OPENAI_API_KEY → AZURE_OPENAI_BASE_URL). One
 * rule for every provider, so a new row gets the override without a second
 * table entry. A key env that does not end in `_API_KEY` has no derived name:
 * the convention would be a guess, and a guessed name silently retargets a
 * provider.
 * @param {string} apiKeyEnv
 * @returns {string|null}
 */
export function baseUrlEnvName(apiKeyEnv) {
	return apiKeyEnv.endsWith("_API_KEY")
		? `${apiKeyEnv.slice(0, -"_API_KEY".length)}_BASE_URL`
		: null;
}

/**
 * The upstream one run uses for a row: the env override when set (the derived
 * name, absolute http(s) only, trailing slashes trimmed), else the fact table's
 * canonical URL (docs/d070). A malformed override THROWS instead of falling
 * back: a typo must not send traffic to the canonical upstream while the
 * operator believes the provider is pointed elsewhere.
 * @param {CloudProviderFacts} facts
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function providerBaseUrl(facts, env) {
	const name = baseUrlEnvName(facts.apiKeyEnv);
	const override = name === null ? undefined : env[name]?.trim();
	if (!override) {
		return facts.baseUrl;
	}
	let protocol;
	try {
		protocol = new URL(override).protocol;
	} catch {
		protocol = "";
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`${name} is not an absolute http(s) URL: ${override}`);
	}
	return override.replace(/\/+$/, "");
}

/**
 * The upstreams' hostnames. A routed URL carried the upstream host as a path
 * segment (`<base>/<host>/…`, docs/d047); that form is deleted (docs/d108),
 * and this set is the regression guard that refuses it if it comes back — a
 * committed artifact names the fact-table upstream verbatim (docs/d070).
 * @param {Readonly<Record<string, CloudProviderFacts>>} providers the table
 * @returns {Set<string>}
 */
export function factHosts(providers) {
	return new Set(
		Object.values(providers).map((facts) => new URL(facts.baseUrl).host),
	);
}
