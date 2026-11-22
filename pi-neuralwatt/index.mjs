/**
 * @fileoverview index.mjs — the pi extension entry: TWO registrations for one
 * vendor, rebuilt from the provider's own `/v1/models` listing at every
 * refresh.
 *
 * `neuralwatt-flex` and `neuralwatt-standard` serve the same models at the two
 * tiers the provider sells. The split is the extension's own pick rather than a
 * user decision: the flex provider attaches `service_tier: "flex"` to every
 * request body and publishes the flex twin's discounted prices, so its cost
 * display matches the bill; the standard provider sends nothing and keeps the
 * list price. Both keep the STANDARD model id, which is what keeps the wire
 * model name — and the shared server-side prefix cache — unchanged across a
 * tier switch (/guides/flex-tier#prompt-caching-and-model-names).
 *
 * Why two registrations from one entry (the pi-opencode precedent, docs/d100):
 * one vendor, one key env, one listing, and two failure surfaces that cannot
 * silence each other. The README says which tier is the operator default.
 *
 * This file, sources.mjs, merge.mjs, compat.mjs, log.mjs and package.json ARE
 * the pi package (docs/d096's folder contract): `pi install ./pi-neuralwatt -l`,
 * a copy into `~/.pi/agent/extensions/pi-neuralwatt/`, or
 * `pi -e ./pi-neuralwatt/index.mjs`. There is no subfolder and no copy step.
 *
 * Network access rides the environment's forward proxy (`NODE_USE_ENV_PROXY=1`
 * plus the forwarded `HTTP(S)_PROXY`, docs/d074), so this carries no route or
 * relay handling of its own.
 *
 * Deliberately absent: OAuth flows (API-key provider), quota/status/energy UI,
 * any request-shaping stream wrapper, and any model list on the registration —
 * a lineup here would be a claim about the provider that outlives its catalog
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

import { shapeListing } from "./merge.mjs";
import {
	fetchListing,
	NEURALWATT_API_KEY_ENV,
	NEURALWATT_BASE_URL,
	PROVIDER_IDS,
	storeIsFresh,
} from "./sources.mjs";

/** @typedef {"flex"|"standard"} Tier */

/**
 * @param {Tier} tier
 * @returns {string} the provider id pi namespaces model ids under
 */
function providerIdFor(tier) {
	return tier === "flex" ? PROVIDER_IDS.flex : PROVIDER_IDS.standard;
}

/**
 * The tier's lineup, or `undefined` when pi's own snapshot is still inside this
 * folder's TTL (or the network is not wanted right now).
 *
 * An unreadable source is a FAILURE, not an empty lineup (docs/d190/d192): pi
 * records the provider in `ModelsRefreshResult.errors` and the model selector
 * renders "Could not refresh <provider>; showing cached models." instead of
 * silently keeping a list the provider may have stopped serving. An empty array
 * would REPLACE the catalog with nothing.
 * @param {RefreshModelsContext} context
 * @param {Tier} tier
 * @returns {Promise<ProviderModelConfig[]|undefined>}
 */
async function refresh(context, tier) {
	context.signal.throwIfAborted();
	const stored = context.stored;
	if (
		context.allowNetwork === false ||
		(stored && storeIsFresh(stored.checkedAt ?? 0))
	) {
		return;
	}
	const providerId = providerIdFor(tier);
	try {
		const lineups = shapeListing(
			await fetchListing({ signal: context.signal }),
		);
		return tier === "flex" ? lineups.flex : lineups.standard;
	} catch (err) {
		if (context.signal.aborted) {
			throw err;
		}
		throw new Error(
			`${providerId}: source unreadable (${
				err instanceof Error ? err.message : String(err)
			}) — nothing to publish (docs/d190)`,
			{ cause: err },
		);
	}
}

/**
 * @param {ExtensionAPI} pi
 * @param {Tier} tier
 * @param {string} name
 * @returns {void}
 */
function register(pi, tier, name) {
	pi.registerProvider(providerIdFor(tier), {
		name,
		baseUrl: NEURALWATT_BASE_URL,
		api: "openai-completions",
		// pi's `$NAME` reference syntax: read from the environment at request
		// time, so no secret is ever written to disk. An unset key is NOT a
		// hidden provider: pi resolves the reference BEFORE the network refresh
		// phase, so `refresh` below never runs, the provider lands in
		// `ModelsRefreshResult.errors`, and the selector reports "Could not
		// refresh <provider>" (measured on pi 1.5.2). The sandbox run path has to
		// name the env in `coding-agent/run.mjs`'s allowlist for it to arrive.
		apiKey: `$${NEURALWATT_API_KEY_ENV}`,
		// The endpoint authenticates with Authorization: Bearer.
		authHeader: true,
		// No `models` list on purpose (docs/d190): `refreshModels` is the only
		// source, and when it cannot read one the failure is reported and
		// nothing is offered.
		refreshModels: /** @type {NonNullable<ProviderConfig["refreshModels"]>} */ (
			/** @type {unknown} */ (
				(/** @type {RefreshModelsContext} */ context) =>
					refresh(context, tier)
			)
		),
	});
}

/**
 * @param {ExtensionAPI} pi
 * @returns {void}
 */
export default function piNeuralwatt(pi) {
	register(pi, "flex", "Neuralwatt Flex");
	register(pi, "standard", "Neuralwatt Standard");
}
