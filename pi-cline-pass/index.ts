/**
 * @fileoverview index.ts — the pi extension entry: registers the ClinePass
 * provider (its OpenAI-compatible gateway at the fact table's canonical
 * upstream) with pi, seeded from the generated catalog and reconciled at
 * refresh time against the SAME two published sources the generator uses.
 *
 * This file, sources.mjs, merge.mjs, models.js and package.json ARE the pi
 * package (docs/d096): `pi install ./pi-cline-pass -l`, a copy into
 * `~/.pi/agent/extensions/pi-cline-pass/`, or `pi -e ./pi-cline-pass/index.ts`.
 *
 * What this extension deliberately does NOT do: sync the provider's own
 * `/models` listing — at api.cline.bot that listing serves the `cline`
 * (usage-billing) provider, a different catalog, which is why the fleet's
 * cline-pass row carries liveSync: false (docs/d040 item 2). Refresh here
 * means the reconciliation itself: models.dev metadata intersected with the
 * docs-table lineup through the same floor both consumers share
 * (sources.mjs/merge.mjs — one contract, generation and runtime alike).
 *
 * Compat (`supportsDeveloperRole: false`, docs/d022/d033) rides PER MODEL
 * rather than at provider level: the legacy ProviderConfig registration has
 * no provider-level `compat` field, and pi 1.4.0's provider-composer
 * replaces the models.json layer wholesale with an extension's `models` —
 * each definition must carry the fact itself or it would be silently
 * dropped the moment this file registers. merge.mjs owns that projection;
 * the generated models.json keeps the fleet's provider-level block.
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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MergedModel, shapeCatalog, toExtensionModel } from "./merge.mjs";
import { CLINE_PASS_MODELS } from "./models.js";
import {
	CLINE_PASS_API_KEY_ENV,
	CLINE_PASS_BASE_URL,
	CLINE_PASS_NAME,
	CLINE_PASS_PROVIDER_ID,
	fetchCatalogSlice,
	fetchDocsIds,
	resolveAllowlist,
	storeIsFresh,
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
 * The freshly reconciled list plus the committed seed, deduplicated by id
 * with the fresh rows winning. The seed is never dropped: it is the only row
 * set that exists offline, and a refresh whose docs fetch degraded to the
 * committed fallback lineup must not delete the union-adopted rows the seed
 * carries (docs/d040) — a refresh that cannot confirm a row is not a
 * refresh that may revoke it.
 * @param {MergedModel[]} models freshly shaped models
 * @returns {unknown[]} the list pi registers
 */
function withSeed(models: MergedModel[]): unknown[] {
	const fresh = models.map(toExtensionModel);
	const seen = new Set(models.map((m) => m.id));
	return [
		...fresh,
		...CLINE_PASS_MODELS.filter((m) => !seen.has((m as { id: string }).id)),
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
		return undefined;
	}
	return stored.models;
}

export default function piClinePass(pi: ExtensionAPI): void {
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
		models: [...CLINE_PASS_MODELS],
		refreshModels: async (context: RefreshContext = {}) => {
			context.signal?.throwIfAborted();
			const stored = context.stored;
			if (
				context.allowNetwork !== false &&
				(!stored || !storeIsFresh(stored.checkedAt ?? 0))
			) {
				try {
					const records = await fetchCatalogSlice({
						signal: context.signal,
					});
					const docsIds = await fetchDocsIds({ signal: context.signal });
					context.signal?.throwIfAborted();
					return withSeed(
						shapeCatalog(records, resolveAllowlist(docsIds, records)),
					);
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
