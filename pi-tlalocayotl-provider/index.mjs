/**
 * @fileoverview index.mjs — the pi extension entry: registers the Tlalocayotl
 * llama-swap gateway (its OpenAI-compatible surface at the base URL in the
 * fact table) with pi, rebuilt at refresh time from the gateway's own
 * `/v1/models` listing — the only lineup source this folder has.
 *
 * This file, sources.mjs, merge.mjs and package.json ARE the pi package
 * (docs/d096's folder contract): `pi install ./pi-tlalocayotl-provider -l`, a
 * copy into `~/.pi/agent/extensions/pi-tlalocayotl-provider/`, or
 * `pi -e ./pi-tlalocayotl-provider/index.mjs`. There is no subfolder and no
 * copy step.
 *
 * Network access rides the environment's forward proxy (`NODE_USE_ENV_PROXY=1`
 * plus the forwarded `HTTP(S)_PROXY`, docs/d074), so this carries no route or
 * relay handling of its own.
 *
 * Deliberately absent: OAuth flows (API-key gateway), quota/status UI, any
 * request-shaping stream wrapper, and any catalog of its own — a lineup here
 * would be a claim about a gateway whose whole job is swapping backends
 * (docs/d190).
 */

/**
 * The host's extension surface. A devDependency pins the version whose types
 * are checked here (docs/d107); the runtime instance is the host's own, and the
 * peerDep range states that contract in package.json.
 * @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI
 * @typedef {import("@earendil-works/pi-coding-agent").ProviderConfig} ProviderConfig
 * @typedef {import("@earendil-works/pi-coding-agent").ProviderModelConfig} ProviderModelConfig
 */

/**
 * What pi hands `refreshModels`, DERIVED from the registration slot rather than
 * imported from `@earendil-works/pi-ai`: pi-ai is a transitive dependency of the
 * host, not something this folder may name (pnpm's isolated node_modules would
 * not resolve it), and a derived type cannot drift from the slot.
 * @typedef {Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0]} RefreshModelsContext
 */

import { shapeListing, toExtensionModel } from "./merge.mjs";
import {
	fetchListing,
	persistLineup,
	storedLineup,
	storeIsFresh,
	TLALOCAYOTL_API_KEY_ENV,
	TLALOCAYOTL_BASE_URL,
	TLALOCAYOTL_PROVIDER_ID,
} from "./sources.mjs";

/**
 * The lineup for this refresh phase.
 *
 * Three ordered answers (the d190 amendment): pi's cache-only phase
 * (`allowNetwork: false`) gets the catalog the last verified read persisted, so
 * a process pi has not allowed onto the network still offers a lineup; a stored
 * catalog inside this folder's TTL answers `undefined` because that phase
 * already published it; and a read that succeeds is persisted before it is
 * returned.
 *
 * An unreadable source is a FAILURE, not an empty lineup (docs/d190): the
 * gateway's own listing is this folder's only source, so pi is told which
 * provider broke and the model selector renders "Could not refresh <provider>;
 * showing cached models." (ModelsRefreshResult.errors) instead of silently
 * keeping a list the gateway may have stopped serving.
 * @param {RefreshModelsContext} context
 * @returns {Promise<ProviderModelConfig[]|undefined>}
 */
async function refresh(context) {
	context.signal.throwIfAborted();
	const stored = context.stored;
	if (context.allowNetwork === false) {
		return storedLineup(stored);
	}
	if (stored && storeIsFresh(stored.checkedAt ?? 0)) {
		return;
	}
	/** @type {ProviderModelConfig[]} */
	let models;
	try {
		models = shapeListing(await fetchListing({ signal: context.signal })).map(
			toExtensionModel,
		);
	} catch (err) {
		if (context.signal.aborted) {
			throw err;
		}
		throw new Error(
			`${TLALOCAYOTL_PROVIDER_ID}: source unreadable (${
				err instanceof Error ? err.message : String(err)
			}) — nothing to publish (docs/d190)`,
			{ cause: err },
		);
	}
	await persistLineup(context, models);
	return models;
}

/**
 * @param {ExtensionAPI} pi
 * @returns {void}
 */
export default function piTlalocayotlProvider(pi) {
	pi.registerProvider(TLALOCAYOTL_PROVIDER_ID, {
		name: "Tlalocayotl",
		baseUrl: TLALOCAYOTL_BASE_URL,
		api: "openai-completions",
		// pi's `$NAME` reference syntax: read from the environment at request
		// time, so no secret is ever written to disk. An unset key leaves the
		// provider unconfigured (pi resolves the reference before the refresh
		// phase, so the selector names the provider instead of probing keylessly).
		apiKey: `$${TLALOCAYOTL_API_KEY_ENV}`,
		// llama-swap authenticates with Authorization: Bearer rather than an
		// x-api-key header.
		authHeader: true,
		// No `models` list on purpose (docs/d190): the gateway swaps backends, so
		// a list here would publish a lineup it may already have retired.
		// `refreshModels` is the only source; when it cannot read one the failure
		// is reported and nothing is offered.
		refreshModels: /** @type {NonNullable<ProviderConfig["refreshModels"]>} */ (
			/** @type {unknown} */ (refresh)
		),
	});
}
