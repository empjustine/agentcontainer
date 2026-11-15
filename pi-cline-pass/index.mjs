/**
 * @fileoverview index.mjs — the pi extension entry: registers the ClinePass
 * provider (its OpenAI-compatible gateway at the fact table's canonical
 * upstream) with pi, rebuilt at refresh time from the ONE published source
 * this folder treats as a contract: Cline's docs table (docs/d189).
 *
 * This file, sources.mjs, merge.mjs, log.mjs and package.json ARE
 * the pi package (docs/d096): `pi install ./pi-cline-pass -l`, a copy into
 * `~/.pi/agent/extensions/pi-cline-pass/`, or `pi -e ./pi-cline-pass/index.mjs`.
 *
 * What this extension deliberately does NOT do: sync the provider's own
 * `/models` listing — at api.cline.bot that listing serves the `cline`
 * (usage-billing) provider, a different catalog, which is why the fleet's
 * cline-pass row carries liveSync: false (docs/d040 item 2). Refresh here
 * means the lineup itself, and the docs table is read FIRST: a successful
 * parse ends the refresh, with no models.dev request after it. The table's
 * rows carry the billing-namespaced id and the display name, which is every
 * field this provider's catalog is a claim about; the second read only added
 * metadata, whose price column is Cline's reference rate against an undefined
 * quota multiplier rather than the money a subscriber pays. Both consumers
 * share that one contract (sources.mjs/merge.mjs; docs/d189).
 *
 * Compat (`supportsDeveloperRole: false`, docs/d022/d033) rides PER MODEL
 * rather than at provider level: the legacy ProviderConfig registration has
 * no provider-level `compat` field, and pi's provider composer replaces the
 * models.json layer wholesale with an extension's `models` — each definition
 * must carry the fact itself or it would be silently dropped the moment this
 * file registers. merge.mjs owns that projection; nothing in this folder
 * writes a manifest, so this is the only placement.
 *
 * Network access rides the environment's forward proxy (`NODE_USE_ENV_PROXY=1`
 * plus the forwarded `HTTP(S)_PROXY`, docs/d074), the same path the
 * generator uses, so this carries no route handling of its own.
 *
 * Deliberately absent: OAuth (API-key provider), a stream wrapper (the
 * gateway speaks openai-completions natively), custom request headers (the
 * fleet's full row defines none, so none are invented — an invented header
 * is a wire-level claim this folder cannot verify), and an alias map
 * (ClinePass publishes no rotating tier ids).
 *
 * No model list is registered or committed (docs/d190): `refreshModels` reads
 * the provider's own source on every run, and a source that cannot answer is
 * reported as a failure instead of reviving a remembered lineup.
 */

/**
 * The host's extension surface. A devDependency pins the version whose types
 * are checked here (docs/d107); the runtime instance is the host's own, and
 * the peerDep range states that contract in package.json.
 * @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI
 * @typedef {import("@earendil-works/pi-coding-agent").ProviderConfig} ProviderConfig
 * @typedef {import("@earendil-works/pi-coding-agent").ProviderModelConfig} ProviderModelConfig
 */

/**
 * What pi hands `refreshModels`, DERIVED from the registration slot rather than
 * imported from `@earendil-works/pi-ai`: pi-ai is a transitive dependency of
 * the host, not something this folder may name (pnpm's isolated node_modules
 * would not resolve it), and a derived type cannot drift from the slot.
 * @typedef {Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0]} RefreshModelsContext
 */

import { shapeCatalog, toExtensionModel } from "./merge.mjs";
import {
	CLINE_PASS_API_KEY_ENV,
	CLINE_PASS_BASE_URL,
	CLINE_PASS_NAME,
	CLINE_PASS_PROVIDER_ID,
	fetchDocsLineup,
	storeIsFresh,
} from "./sources.mjs";

/**
 * The lineup, or `undefined` when pi's own snapshot is still inside this
 * folder's TTL (or the network is not wanted right now).
 *
 * An unreadable source is a FAILURE, not an empty lineup: the table is this
 * provider's whole contract, so pi is told which provider broke and the model
 * selector renders "Could not refresh <provider>; showing cached models."
 * (ModelsRefreshResult.errors). docs/d190's rule is why nothing is invented in
 * its place.
 * @param {RefreshModelsContext} context
 * @returns {Promise<ProviderModelConfig[]|undefined>}
 */
async function refresh(context) {
	context.signal.throwIfAborted();
	const stored = context.stored;
	/**
	 * undefined is a real answer, not an empty lineup: offline init, or pi's own
	 * snapshot is still inside this folder's TTL. An empty array would REPLACE
	 * the catalog with nothing (docs/d190).
	 * @type {ProviderModelConfig[]|undefined}
	 */
	let models;
	if (
		context.allowNetwork !== false &&
		!(stored && storeIsFresh(stored.checkedAt ?? 0))
	) {
		try {
			const rows = shapeCatalog(
				await fetchDocsLineup({ signal: context.signal }),
			);
			// No catalog records: the table is the whole contract, so every row
			// publishes what the table says and pi's schema defaults for the rest
			// (docs/d189).
			models = rows.map(toExtensionModel);
		} catch (err) {
			if (context.signal.aborted) {
				throw err;
			}
			throw new Error(
				`${CLINE_PASS_PROVIDER_ID}: source unreadable (${
					err instanceof Error ? err.message : String(err)
				}) — nothing to publish (docs/d190)`,
				{ cause: err },
			);
		}
	}
	return models;
}

/**
 * @param {ExtensionAPI} pi
 * @returns {void}
 */
export default function piClinePass(pi) {
	pi.registerProvider(CLINE_PASS_PROVIDER_ID, {
		name: CLINE_PASS_NAME,
		baseUrl: CLINE_PASS_BASE_URL,
		api: "openai-completions",
		// pi's `$NAME` reference syntax: read from the environment at request
		// time, so no secret is ever written to disk. An unset key leaves the
		// provider unconfigured (pi hides its models from /model).
		apiKey: `$${CLINE_PASS_API_KEY_ENV}`,
		// The gateway authenticates with Authorization: Bearer rather than an
		// x-api-key header (the fleet's full row carries authHeader: true).
		authHeader: true,
		// No `models` list on purpose (docs/d190): a list here is a lineup the
		// provider may have stopped serving, and pi would keep publishing it.
		// `refreshModels` is the only source; when it cannot read one the
		// failure is reported and nothing is offered.
		refreshModels: /** @type {NonNullable<ProviderConfig["refreshModels"]>} */ (
			/** @type {unknown} */ (refresh)
		),
	});
}
