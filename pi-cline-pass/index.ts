/**
 * @fileoverview index.ts — the pi extension entry: registers the ClinePass
 * provider (its OpenAI-compatible gateway at the fact table's canonical
 * upstream) with pi, rebuilt at refresh time from the SAME two published
 * sources the generator uses — the docs table for the lineup, models.dev for
 * metadata.
 *
 * This file, sources.mjs, merge.mjs, log.mjs and package.json ARE
 * the pi package (docs/d096): `pi install ./pi-cline-pass -l`, a copy into
 * `~/.pi/agent/extensions/pi-cline-pass/`, or `pi -e ./pi-cline-pass/index.ts`.
 *
 * What this extension deliberately does NOT do: sync the provider's own
 * `/models` listing — at api.cline.bot that listing serves the `cline`
 * (usage-billing) provider, a different catalog, which is why the fleet's
 * cline-pass row carries liveSync: false (docs/d040 item 2). Refresh here
 * means the lineup itself: the docs table names the ids, models.dev supplies
 * their metadata, and both consumers share that one contract
 * (sources.mjs/merge.mjs; docs/d189).
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
 *
 * No model list is registered or committed (docs/d190): `refreshModels` reads
 * the provider's own source on every run, and a source that cannot answer
 * leaves the provider with nothing to offer instead of reviving a remembered
 * lineup.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shapeCatalog, toExtensionModel } from "./merge.mjs";
import {
	CLINE_PASS_API_KEY_ENV,
	CLINE_PASS_BASE_URL,
	CLINE_PASS_NAME,
	CLINE_PASS_PROVIDER_ID,
	fetchCatalogSlice,
	fetchDocsLineup,
	storeIsFresh,
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
					const records = await fetchCatalogSlice({
						signal: context.signal,
					});
					const lineup = await fetchDocsLineup({ signal: context.signal });
					context.signal?.throwIfAborted();
					return shapeCatalog(records, lineup).map(toExtensionModel);
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
