/**
 * @fileoverview index.ts — the pi extension entry, as a CATALOG FRESHNESS
 * WATCHDOG, not a catalog (docs/d097's built-in-provider rule, applied to
 * mistral per docs/d100).
 *
 * mistral is built into pi-coding-agent (pi-ai ships the provider), so the
 * host already carries the catalog, the wire format and the auth — all of it
 * strictly better data than this folder could re-derive. In pi's composer an
 * extension layer without `models` passes the built-in catalog through
 * UNTOUCHED, while a returned model list REPLACES the whole provider catalog
 * — so any "backup" copy here could only be a downgrade, and there is none.
 *
 * What is left worth doing is the one thing a built-in snapshot cannot do:
 * know whether its lineup is still live. That is this file:
 *
 *   - listing answers → return undefined: pi's defaults stand;
 *   - listing fails (network allowed, not aborted) → THROW. Throwing IS the
 *     catalog warning: pi records the error per provider
 *     (ModelsRefreshResult.errors) and the model selector surfaces
 *     "Could not refresh mistral; showing cached models." — with the
 *     built-in rows untouched;
 *   - allowNetwork=false (offline init) or inside the refresh interval →
 *     return undefined silently: pi already knows it is offline, and a
 *     warning every model-selector open would be noise. `force` bypasses
 *     the interval.
 *
 * ONE deliberate divergence from the opencode watchdogs (pi-opencode/):
 * mistral's listing is AUTH-GATED (verified: 401 even before any key is
 * sent), so a MISSING key returns undefined without a fetch. An unconfigured
 * provider is hidden by pi anyway — a "could not refresh" warning about a
 * provider the user cannot use yet would be pure noise. The opencode
 * listings are public, so there a keyless failure means the endpoint moved
 * and is worth the warning; here a keyless failure means only "no key".
 *
 * The whole extension is this one file — deliberately with ZERO repo-`lib`
 * imports: a copied package must stand alone. The upstream URL is a constant
 * here, and tests/pi-mistral.test.mjs pins it against the fact table
 * (lib/cloud-providers.mjs, docs/d070) so it cannot drift.
 *
 * Network access rides the environment's forward proxy (NODE_USE_ENV_PROXY=1
 * plus the forwarded HTTP(S)_PROXY, docs/d074). Deliberately absent: OAuth
 * flows, quota/status UI, request shaping, and any model data. The fleet's
 * chat-capable scoping of the lineup (dropping mistral-embed / voxtral-tts)
 * is the models.json layer's job (model-012), not a watchdog's — this file
 * never touches models.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi namespaces the models under this id; it is also the fact-table id. */
export const MISTRAL_PROVIDER_ID = "mistral";

/**
 * The provider's live model listing — the fact-table canonical upstream
 * (docs/d070) plus the path the OpenAI surface serves its listing under.
 * tests pin this against lib/cloud-providers.mjs.
 */
export const MISTRAL_LISTING_URL = "https://api.mistral.ai/v1/models";

/** The env var holding the real key; sent when set, never logged (d086). */
const MISTRAL_API_KEY_ENV = "MISTRAL_API_KEY";

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
 * host-provided at runtime but is not a dependency of this repo.
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
 * shape, which is exactly the "the live lineup cannot be confirmed" case
 * this watchdog exists to report.
 * @throws {Error} on transport failure, non-2xx, or an unrecognizable payload
 */
async function fetchListingCount(
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<number> {
	const key = process.env[MISTRAL_API_KEY_ENV]?.trim();
	const res = await fetchImpl(MISTRAL_LISTING_URL, {
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

export default function piMistral(pi: ExtensionAPI): void {
	let lastAttemptAt = 0;

	pi.registerProvider(MISTRAL_PROVIDER_ID, {
		// ONLY refreshModels: no models (the built-in catalog must survive —
		// any list we returned would REPLACE it wholesale), no api/baseUrl/
		// apiKey/headers (the built-in provider's own). See the fileoverview.
		refreshModels: async (context: RefreshContext = {}) => {
			context.signal?.throwIfAborted();
			if (context.allowNetwork === false) return undefined;
			// The listing is auth-gated, so without a key there is nothing this
			// watchdog can observe — and nothing to warn about: pi hides an
			// unconfigured provider from /model already.
			if (!process.env[MISTRAL_API_KEY_ENV]?.trim()) return undefined;
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
				// mistral; showing cached models." — and since we returned
				// nothing, the built-in rows are exactly what keeps standing.
				throw new Error(
					`${MISTRAL_PROVIDER_ID}: live model listing unreachable (${
						err instanceof Error ? err.message : String(err)
					}) — keeping pi's built-in catalog`,
					{ cause: err },
				);
			}
			// Success returns undefined on purpose: the fresh lineup is the ids
			// only, and pi's built-in rows carry names, limits, prices and
			// thinking maps this file neither has nor could improve.
			return undefined;
		},
	});
}
