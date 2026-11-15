/**
 * @fileoverview index.ts — the pi extension entry: registers the Verboo
 * provider (its OpenAI-compatible gateway at the fact table's canonical
 * upstream) with pi, rebuilt at refresh time from the provider's own
 * `/models` listing — the only lineup source this folder has.
 *
 * This file, sources.mjs, log.mjs, merge.mjs and package.json ARE
 * the pi package (docs/d096's folder contract, applied here): `pi install
 * ./pi-verboo -l`, a copy into `~/.pi/agent/extensions/pi-verboo/`, or
 * `pi -e ./pi-verboo/index.ts`. There is no subfolder and no copy step —
 * the folder is the unit.
 *
 * Network access rides the environment's forward proxy (`NODE_USE_ENV_PROXY=1`
 * plus the forwarded `HTTP(S)_PROXY`, docs/d074), the same path the
 * generator uses, so this carries no route or relay handling of its own.
 *
 * Deliberately absent: OAuth flows (API-key provider), quota/status UI, any
 * request-shaping stream wrapper, and any compat flag — a plain
 * OpenAI-compatible gateway where pi's defaults are correct as-is; a flag
 * enabled on a hunch changes what pi SENDS, which is a wire-level claim
 * this folder cannot verify.
 *
 * No model list is registered or committed (docs/d190): `refreshModels` reads
 * the provider's own source on every run, and a source that cannot answer
 * leaves the provider with nothing to offer instead of reviving a remembered
 * lineup.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shapeListing, toExtensionModel } from "./merge.mjs";
import {
	fetchListing,
	storeIsFresh,
	VERBOO_API_KEY_ENV,
	VERBOO_BASE_URL,
	VERBOO_PROVIDER_ID,
} from "./sources.mjs";

/**
 * What pi hands `refreshModels`, as far as this extension reads it.
 *
 * Declared structurally and read defensively because `@earendil-works/pi-*` is
 * host-provided at runtime but is not a dependency of this repo: the shipped
 * declaration is the only thing checkable here. Every field is optional in
 * this reading, so a version that stops sending one costs a refresh, never a
 * throw.
 */
interface RefreshContext {
	signal?: AbortSignal;
	credential?: { type?: string; key?: string };
	/** pi's own snapshot of the last published list, when it has one. */
	stored?: { models?: unknown[]; checkedAt?: number };
	/** false when pi knows the network is not wanted right now. */
	allowNetwork?: boolean;
}

export default function piVerboo(pi: ExtensionAPI): void {
	pi.registerProvider(VERBOO_PROVIDER_ID, {
		name: "Verboo",
		baseUrl: VERBOO_BASE_URL,
		api: "openai-completions",
		// pi's `$NAME` reference syntax: read from the environment at request
		// time, so no secret is ever written to disk. An unset key leaves the
		// provider unconfigured (pi hides its models from /model).
		apiKey: `$${VERBOO_API_KEY_ENV}`,
		// The endpoint authenticates with Authorization: Bearer rather than an
		// x-api-key header.
		authHeader: true,
		// No `models` list on purpose (docs/d190): a list here is a lineup the
		// provider may have stopped serving, and pi would keep publishing it.
		// `refreshModels` is the only source; when it cannot read one there is
		// nothing to offer.
		refreshModels: async (context: RefreshContext = {}) => {
			context.signal?.throwIfAborted();
			const stored = context.stored;
			if (
				context.allowNetwork !== false &&
				(!stored || !storeIsFresh(stored.checkedAt ?? 0))
			) {
				try {
					const models = shapeListing(
						await fetchListing({ signal: context.signal }),
					);
					context.signal?.throwIfAborted();
					return models.map(toExtensionModel);
				} catch (err) {
					if (context.signal?.aborted) {
						throw err;
					}
					// The provider's own source is the only lineup, so an unreadable
					// one means the provider is not working: no remembered rows stand
					// in (docs/d190).
				}
			}
			return;
		},
	});
}
