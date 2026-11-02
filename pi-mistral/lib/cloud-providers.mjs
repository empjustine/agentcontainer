/**
 * @fileoverview cloud-providers.mjs — loader for THIS extension's own row of
 * the provider fact table (docs/d104): the row lives in the sibling
 * `cloud-providers.json`, pruned to the one provider this unit serves.
 *
 * Why a copy instead of a shared table: the table used to be repo-wide
 * (docs/d024's one-edit law), but every consumer of it is now a copy unit of
 * its own — the coding-agent generators (all rows), estige (the allowlist,
 * in Go) and each pi-* extension (exactly one row each). A one-row copy says
 * what the extension actually depends on, and editing another provider's row
 * cannot break this one.
 *
 * The row-level WHY (full-base-path rationale, catalog gaps) rides the row as
 * a `note` string, so the reasoning travels with the data.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The stable facts of a provider — the part every family agrees on.
 * `baseUrl` is the provider's REAL endpoint: the upstream the deployed estige
 * allowlist keys on (its HOST — docs/d047), the URL committed artifacts embed
 * verbatim (docs/d070), and the source for the fact-table facts endpoint.
 * @typedef {object} CloudProviderFacts
 * @property {string} id provider id (matches pi's and opencode's built-in
 *   provider names and the llama-swap farm id)
 * @property {string} label human-readable name
 * @property {string} apiKeyEnv env var holding the provider's real key, used
 *   for the facts-refresh bearer and the `${env.*}` reference emitted layers
 *   carry — never inlined into an emitted artifact
 * @property {string} baseUrl the provider's real default endpoint (upstream
 *   for the proxy allowlist; canonical artifact URL, docs/d070)
 * @property {SupportTier} support docs/d064's promise for this row — how much
 *   line-up/liveness work the generators do for it
 * @property {string} [note] why this row looks the way it does — the
 *   row-level rationale, carried with the data since the table became JSON
 */

/**
 * docs/d064's support tiers — validated here so a malformed row is a loud stop
 * at load, not a downstream surprise.
 * @typedef {"first-class"|"best-effort"|"superficial"} SupportTier
 */

/** @type {ReadonlySet<string>} */
const SUPPORT_TIERS = new Set(["first-class", "best-effort", "superficial"]);

/**
 * Load + validate this extension's row. Every field the typedef promises is
 * checked here, loudly: a broken row is a broken repo, and one this unit
 * cannot serve for.
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
