/**
 * @fileoverview index.ts — the pi extension entry: registers the Verboo
 * provider (its OpenAI-compatible gateway at the fact table's canonical
 * upstream) with pi, seeded from the generated catalog and refreshed from
 * the provider's own `/models` listing at runtime.
 *
 * This file, sources.mjs, merge.mjs, models.js and package.json ARE the pi
 * package (docs/d096's folder contract, applied here): `pi install
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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MergedModel, shapeListing, toExtensionModel } from "./merge.mjs";
import { VERBOO_MODELS } from "./models.js";
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
 * this reading, so a version that stops sending one degrades to the committed
 * seed instead of throwing.
 */
interface RefreshContext {
	signal?: AbortSignal;
	credential?: { type?: string; key?: string };
	/** pi's own snapshot of the last published list, when it has one. */
	stored?: { models?: unknown[]; checkedAt?: number };
	/** false when pi knows the network is not wanted right now. */
	allowNetwork?: boolean;
}

/**
 * The freshly shaped list plus the committed seed, deduplicated by id with
 * the fresh rows winning. The seed is never dropped: it is the only row set
 * that exists offline, and a listing that omits a row must not delete a
 * model the user may be mid-conversation with.
 * @param {MergedModel[]} models freshly shaped models
 * @returns {unknown[]} the list pi registers
 */
function withSeed(models: MergedModel[]): unknown[] {
	const fresh = models.map(toExtensionModel);
	const seen = new Set(models.map((m) => m.id));
	return [
		...fresh,
		...VERBOO_MODELS.filter((m) => !seen.has((m as { id: string }).id)),
	];
}

/**
 * Rebuild the list from pi's own persisted snapshot. `stored.models` is pi's
 * model shape, not this folder's config shape, so the rows are passed
 * straight back as pi gave them — re-shaping them here would re-invent data
 * pi already normalized.
 * @param {RefreshContext} context
 * @returns {unknown[]|undefined} undefined when there is no usable snapshot
 */
function fromStore(context: RefreshContext): unknown[] | undefined {
	const stored = context.stored;
	if (!stored || !Array.isArray(stored.models) || stored.models.length === 0) {
		return;
	}
	return stored.models;
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
		models: [...VERBOO_MODELS],
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
					return withSeed(models);
				} catch (err) {
					if (context.signal?.aborted) throw err;
					// A failed refresh must never cost the user a working provider:
					// the store, then the seed, stand in. An unconfigured key is
					// the common case here (the listing is auth-gated), and the
					// seed standing in is exactly the offline contract.
				}
			}
			return fromStore(context) ?? undefined;
		},
	});
}
