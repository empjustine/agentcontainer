/**
 * @fileoverview index.ts — the pi extension entry, as TWO CATALOG FRESHNESS
 * WATCHDOGS, not catalogs (docs/d097's built-in-provider rule; the opencode
 * + opencode-go unification is docs/d100's).
 *
 * Both providers are built into pi-coding-agent (pi-ai ships them), so the
 * host already carries the catalogs — opencode-go's per-model api dialects,
 * per-family base URLs and the OpenCode `x-opencode-session` wiring;
 * opencode's zen lineup. In pi's composer an extension layer without
 * `models` passes the built-in catalog through UNTOUCHED, while a returned
 * model list REPLACES the whole provider catalog — so any "backup" copy here
 * could only be a downgrade, and there is none.
 *
 * What is left worth doing is the one thing a built-in snapshot cannot do:
 * know whether its lineup is still live. That is this file, once per
 * provider (same rules, separate intervals):
 *
 *   - listing answers → return undefined: pi's defaults stand;
 *   - listing fails (network allowed, not aborted) → THROW. Throwing IS the
 *     catalog warning: pi records the error per provider
 *     (ModelsRefreshResult.errors) and the model selector surfaces
 *     "Could not refresh <provider>; showing cached models." — with the
 *     built-in rows untouched;
 *   - allowNetwork=false (offline init) or inside the refresh interval →
 *     return undefined silently: pi already knows it is offline, and a
 *     warning every model-selector open would be noise. `force` bypasses
 *     the interval.
 *
 * Why ONE folder for the two: they are the same vendor's two surfaces
 * (opencode.ai/zen/v1 and its /go subset), the same key env
 * (OPENCODE_API_KEY), the same watchdog rules, and the same built-in-provider
 * constraint — two folders would duplicate every rule for one provider
 * family. The contrast case is pi-mistral (also a watchdog, different
 * auth-gating rule, its own folder).
 *
 * The whole extension is this one file — deliberately with ZERO repo-`lib`
 * imports: a copied package must stand alone. The upstream URLs are
 * constants here, and tests/pi-opencode.test.mjs pins them against the fact
 * table (lib/cloud-providers.mjs, docs/d070) so they cannot drift.
 *
 * Network access rides the environment's forward proxy (NODE_USE_ENV_PROXY=1
 * plus the forwarded HTTP(S)_PROXY, docs/d074). Deliberately absent: OAuth
 * flows, quota/status UI, request shaping, and any model data.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi namespaces the models under these ids; they are also the fact-table ids. */
export const OPENCODE_PROVIDER_ID = "opencode";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";

/**
 * The providers' live model listings — the fact-table canonical upstreams
 * (docs/d070) plus the path each surface serves its listing under. tests pin
 * both against lib/cloud-providers.mjs. Both are PUBLIC (verified: 200
 * unauthenticated), which is why a keyless listing failure is a warning
 * worth raising here — unlike pi-mistral's auth-gated listing, where
 * keyless means only "no key".
 */
export const OPENCODE_LISTING_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_GO_LISTING_URL = "https://opencode.ai/zen/go/v1/models";

/** The env var holding the real key; sent when set, never logged (d086). */
const OPENCODE_API_KEY_ENV = "OPENCODE_API_KEY";

/**
 * One warning per interval per provider, not one per model-selector open: the
 * failure is about the CATALOG, not about any single refresh, and a refresh
 * storm while offline must not become a notification storm. `force` bypasses
 * it. Per-provider state — one provider's outage must not silence the
 * other's.
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
 * shape (or answered through an intercepting page), which is exactly the
 * "the live lineup cannot be confirmed" case this watchdog exists to report.
 * @throws {Error} on transport failure, non-2xx, or an unrecognizable payload
 */
async function fetchListingCount(
	url: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<number> {
	const key = process.env[OPENCODE_API_KEY_ENV]?.trim();
	const res = await fetchImpl(url, {
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

/**
 * The watchdog for one provider surface: its own interval clock, its own
 * listing URL, the shared rules. Returned as the registration's whole
 * config — ONLY refreshModels, because anything else would override the
 * built-in provider.
 * @param {string} providerId the provider this watchdog speaks for
 * @param {string} listingUrl the provider's live listing
 */
function watchdog(providerId: string, listingUrl: string) {
	let lastAttemptAt = 0;
	return {
		refreshModels: async (context: RefreshContext = {}) => {
			context.signal?.throwIfAborted();
			if (context.allowNetwork === false) return;
			if (!context.force && Date.now() - lastAttemptAt < REFRESH_INTERVAL_MS) {
				return;
			}
			lastAttemptAt = Date.now();
			try {
				await fetchListingCount(listingUrl, context.signal);
			} catch (err) {
				if (context.signal?.aborted) throw err;
				// Throwing IS the catalog warning: pi records the provider in
				// ModelsRefreshResult.errors and the UI shows "Could not refresh
				// <provider>; showing cached models." — and since we returned
				// nothing, the built-in rows are exactly what keeps standing.
				throw new Error(
					`${providerId}: live model listing unreachable (${
						err instanceof Error ? err.message : String(err)
					}) — keeping pi's built-in catalog`,
					{ cause: err },
				);
			}
			// Success returns undefined on purpose: the fresh lineup is the ids
			// only, and pi's built-in rows carry names, limits, prices, dialects
			// and thinking maps this file neither has nor could improve.
			return;
		},
	};
}

export default function piOpencode(pi: ExtensionAPI): void {
	pi.registerProvider(
		OPENCODE_PROVIDER_ID,
		watchdog(OPENCODE_PROVIDER_ID, OPENCODE_LISTING_URL),
	);
	pi.registerProvider(
		OPENCODE_GO_PROVIDER_ID,
		watchdog(OPENCODE_GO_PROVIDER_ID, OPENCODE_GO_LISTING_URL),
	);
}
