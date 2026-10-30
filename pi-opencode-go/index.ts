/**
 * @fileoverview index.ts — the pi extension entry, as a CATALOG
 * FRESHNESS WATCHDOG, not a catalog (docs/d097).
 *
 * opencode-go is built into pi-coding-agent (pi-ai's data/opencode-go.json):
 * the host already carries the per-model api dialects, the per-family base
 * URLs, the session-header wiring and the auth — all of it strictly better
 * data than this folder could re-derive or outlive. So this extension
 * registers NO model data at all, and pi's composer does the rest
 * (core/provider-composer.js applyExtension): an extension layer without
 * `models` passes the built-in catalog through UNTOUCHED, while an extension
 * that returns a model list REPLACES the whole provider catalog — a returned
 * row inherits only api/baseUrl from its built-in twin, not limits, prices or
 * thinking maps. Any "backup" copy here could therefore only be a downgrade.
 *
 * What is left worth doing is the one thing a built-in snapshot cannot do:
 * know whether the lineup it ships is still the provider's live lineup. That
 * is this file:
 *
 *   - listing answers → return undefined: pi's defaults stand, because they
 *     are the better data;
 *   - listing fails (network allowed, not aborted) → THROW. pi's refresh
 *     pipeline records the error per provider (ModelsRefreshResult.errors)
 *     and the model selector / mode surfaces it as
 *     "Could not refresh opencode-go; showing cached models." — the catalog
 *     warning, with the built-in rows untouched;
 *   - allowNetwork=false (offline init) or inside the refresh interval →
 *     return undefined silently: pi already knows it is offline, and a
 *     warning every time the selector opens would be noise.
 *
 * The whole extension is this one file — deliberately with ZERO repo-`lib`
 * imports: the previous design pulled lib/cloud-providers.mjs at runtime,
 * which made a copied package useless outside the repo. The upstream URL is
 * a constant here, and tests/pi-opencode-go.test.mjs pins it against the
 * fact table (docs/d070) so it cannot drift.
 *
 * Network access rides the environment's forward proxy (NODE_USE_ENV_PROXY=1
 * plus the forwarded HTTP(S)_PROXY, docs/d074). Deliberately absent: OAuth
 * flows, quota/status UI, request shaping, and any model data.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi namespaces the models under this id; it is also the fact-table id. */
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";

/**
 * The provider's live model listing — the fact-table canonical upstream
 * (docs/d070) plus the path the OpenAI surface serves its listing under.
 * tests pin this against lib/cloud-providers.mjs.
 */
export const OPENCODE_GO_LISTING_URL = "https://opencode.ai/zen/go/v1/models";

/** The env var holding the real key; sent when set, never logged (d086). */
const OPENCODE_GO_API_KEY_ENV = "OPENCODE_API_KEY";

/**
 * One warning per interval, not one per model-selector open: the failure is
 * about the CATALOG, not about any single refresh, and a refresh storm while
 * offline must not become a notification storm. `force` bypasses it.
 */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 15000;

/**
 * What pi hands `refreshModels`, as far as this extension reads it —
 * declared structurally and read defensively because @earendil-works/pi-* is
 * host-provided at runtime and is not a dependency of this repo.
 */
interface RefreshContext {
	signal?: AbortSignal;
	/** false during offline/cache-only initialization — no warning then. */
	allowNetwork?: boolean;
	/** bypass the refresh interval and fetch immediately. */
	force?: boolean;
}

/**
 * One listing probe. The payload check is deliberately shallow: a 2xx whose
 * body is not the OpenAI-shaped {data: [...]} means the upstream changed
 * shape (or answered through an intercepting page), which is exactly the
 * "the live lineup cannot be confirmed" case this watchdog exists to report.
 * @throws {Error} on transport failure, non-2xx, or an unrecognizable payload
 */
async function fetchListingCount(
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<number> {
	const key = process.env[OPENCODE_GO_API_KEY_ENV]?.trim();
	const res = await fetchImpl(OPENCODE_GO_LISTING_URL, {
		headers: key ? { Authorization: `Bearer ${key}` } : undefined,
		signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`model listing answered ${res.status}`);
	}
	const payload: unknown = await res.json();
	const rows = Array.isArray(payload)
		? payload
		: Array.isArray((payload as { data?: unknown })?.data)
			? (payload as { data: unknown[] }).data
			: [];
	const ids = rows.filter(
		(row) => typeof (row as { id?: unknown })?.id === "string",
	);
	if (ids.length === 0) {
		throw new Error("model listing carried no usable rows");
	}
	return ids.length;
}

export default function piOpencodeGo(pi: ExtensionAPI): void {
	let lastAttemptAt = 0;

	pi.registerProvider(OPENCODE_GO_PROVIDER_ID, {
		// ONLY refreshModels: no models (the built-in catalog must survive —
		// any list we returned would REPLACE it wholesale), no api/baseUrl/
		// apiKey/headers (the built-in provider's own). See the fileoverview.
		refreshModels: async (context: RefreshContext = {}) => {
			context.signal?.throwIfAborted();
			if (context.allowNetwork === false) return undefined;
			if (!context.force && Date.now() - lastAttemptAt < REFRESH_INTERVAL_MS) {
				return undefined;
			}
			lastAttemptAt = Date.now();
			try {
				await fetchListingCount(context.signal);
			} catch (err) {
				if (context.signal?.aborted) throw err;
				// Throwing IS the catalog warning: pi records the provider in
				// ModelsRefreshResult.errors and the UI shows "Could not refresh
				// opencode-go; showing cached models." — and since we returned
				// nothing, the built-in rows are exactly what keeps standing.
				throw new Error(
					`${OPENCODE_GO_PROVIDER_ID}: live model listing unreachable (${
						err instanceof Error ? err.message : String(err)
					}) — keeping pi's built-in catalog`,
					{ cause: err },
				);
			}
			// Success returns undefined on purpose: the fresh lineup is the ids
			// only, and pi's built-in rows carry names, limits, prices, dialects
			// and thinking maps this file neither has nor could improve.
			return undefined;
		},
	});
}
