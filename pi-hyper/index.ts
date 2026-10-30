/**
 * @fileoverview index.ts — the pi extension entry: registers the Charm Hyper
 * provider (its OpenAI-compatible gateway at the fact table's canonical
 * upstream) with pi, seeded from the generated catalog and refreshed from
 * the provider's own `/provider` document at runtime.
 *
 * This file, sources.mjs, merge.mjs, models.js and package.json ARE the pi
 * package (docs/d096's folder contract, applied here): `pi install
 * ./pi-hyper -l`, a copy into `~/.pi/agent/extensions/pi-hyper/`, or
 * `pi -e ./pi-hyper/index.ts`. There is no subfolder and no copy step —
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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MergedModel, shapeCatalog, toExtensionModel } from "./merge.mjs";
import { HYPER_MODELS } from "./models.js";
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
		...HYPER_MODELS.filter((m) => !seen.has((m as { id: string }).id)),
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

export default function piHyper(pi: ExtensionAPI): void {
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
		models: [...HYPER_MODELS],
		refreshModels: async (context: RefreshContext = {}) => {
			context.signal?.throwIfAborted();
			const stored = context.stored;
			if (
				context.allowNetwork !== false &&
				(!stored || !storeIsFresh(stored.checkedAt ?? 0))
			) {
				try {
					const models = shapeCatalog(
						await fetchCatalog({ signal: context.signal }),
					);
					context.signal?.throwIfAborted();
					return withSeed(models);
				} catch (err) {
					if (context.signal?.aborted) throw err;
					// A failed refresh must never cost the user a working provider:
					// the store, then the seed, stand in.
				}
			}
			return fromStore(context) ?? undefined;
		},
	});
}
