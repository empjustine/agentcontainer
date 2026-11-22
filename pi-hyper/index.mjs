/**
 * @fileoverview index.mjs — the pi extension entry: registers the Charm Hyper
 * provider (its OpenAI-compatible gateway at the fact table's canonical
 * upstream) with pi, rebuilt at refresh time from the provider's own
 * `/provider` document — the only lineup source this folder has.
 *
 * This file, sources.mjs, merge.mjs and package.json ARE
 * the pi package (docs/d096's folder contract, applied here): `pi install
 * ./pi-hyper -l`, a copy into `~/.pi/agent/extensions/pi-hyper/`, or
 * `pi -e ./pi-hyper/index.mjs`. There is no subfolder and no copy step —
 * the folder is the unit.
 *
 * Network access rides the environment's forward proxy (`NODE_USE_ENV_PROXY=1`
 * plus the forwarded `HTTP(S)_PROXY`, docs/d074), the same path the
 * generator uses, so this carries no route or relay handling of its own.
 *
 * Deliberately absent: OAuth flows (API-key provider), quota/status UI, and
 * any request-shaping stream wrapper. The wire-compat mirror
 * (supportsStore/thinkingFormat/maxTokensField) is a TRANSCRIPTION from the
 * vendor extension, not a published fact — see merge.mjs's HYPER_WIRE_COMPAT
 * and the README's provenance section before touching it.
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
	fetchCatalog,
	HYPER_API_KEY_ENV,
	HYPER_BASE_URL,
	HYPER_PROVIDER_ID,
	storeIsFresh,
} from "./sources.mjs";

/**
 * The client identity this folder sends upstream (the generator's
 * REQUEST_HEADERS, one spelling in both halves — see there for why a UA
 * rides at all).
 */
const REQUEST_HEADERS = {
	"User-Agent": "npm:@agentcontainer/pi-hyper",
};

/**
 * The lineup, or `undefined` when pi's own snapshot is still inside this
 * folder's TTL (or the network is not wanted right now).
 *
 * An unreadable source is a FAILURE, not an empty lineup: the provider's own
 * catalog is this folder's only source, so pi is told which provider broke and
 * the model selector renders "Could not refresh <provider>; showing cached
 * models." (ModelsRefreshResult.errors) instead of silently keeping a list the
 * provider may have stopped serving (docs/d190).
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
				await fetchCatalog({ signal: context.signal }),
			);
			models = rows.map(toExtensionModel);
		} catch (err) {
			if (context.signal.aborted) {
				throw err;
			}
			throw new Error(
				`${HYPER_PROVIDER_ID}: source unreadable (${
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
export default function piHyper(pi) {
	pi.registerProvider(HYPER_PROVIDER_ID, {
		name: "Charm Hyper",
		baseUrl: HYPER_BASE_URL,
		api: "openai-completions",
		// pi's `$NAME` reference syntax: read from the environment at request
		// time, so no secret is ever written to disk. An unset key leaves the
		// provider unconfigured (pi hides its models from /model).
		apiKey: `$${HYPER_API_KEY_ENV}`,
		// The gateway authenticates with Authorization: Bearer rather than an
		// x-api-key header.
		authHeader: true,
		headers: { ...REQUEST_HEADERS },
		// No `models` list on purpose (docs/d190): a list here is a lineup the
		// provider may have stopped serving, and pi would keep publishing it.
		// `refreshModels` is the only source; when it cannot read one the
		// failure is reported and nothing is offered.
		refreshModels: /** @type {NonNullable<ProviderConfig["refreshModels"]>} */ (
			/** @type {unknown} */ (refresh)
		),
	});
}
