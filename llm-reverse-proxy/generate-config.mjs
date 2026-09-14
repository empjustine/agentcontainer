/**
 * @fileoverview generate-config.mjs — Emit `llm-reverse-proxy.json`, the
 * deployed llm-reverse-proxy routing table, as the UNION of THREE provider
 * sources (docs/d038), merged under an explicit priority:
 *
 *   1. pi-ai        — lib/pi-ai-providers.mjs (pi-coding-agent's built-in
 *                     registry, extracted from the installed pi)
 *   2. models.dev   — the vendored + best-effort refreshed
 *                     lib/models.dev.api.json (ai-sdk/opencode's catalog):
 *                     a record's `api` field IS its base URL; records
 *                     without one fall back to the ai-sdk package map
 *                     (lib/ai-sdk-package-endpoints.mjs)
 *   3. catwalk      — the vendored + refreshable lib/catwalk-facts.json
 *                     (crush's catalog): each provider carries
 *                     `api_endpoint`
 *
 * Merge rules (docs/d038): the route namespace is the provider NAME. The
 * same name from several sources ⇒ the higher-priority source wins (every
 * win is logged with what it replaced). Different names for the same vendor
 * ⇒ each name is served under its own route (pi's "google" and catwalk's
 * "gemini" both exist; pi's "together" and models.dev's "togetherai" both
 * exist). Rows whose endpoint is not a single fixed public URL are skipped
 * with the reason: env-placeholder / account-scoped URLs (`$VAR`,
 * `{PLACEHOLDER}` — e.g. catwalk's $ANTHROPIC_API_ENDPOINT, the cloudflare
 * gateways), per-region bedrock, per-project vertex, and models.dev records
 * whose npm package has no canonical endpoint.
 *
 * The path-prefix contract this table serves is unchanged (docs/d027): every
 * entry maps a route name to the upstream's FULL real base URL — path
 * suffixes included — so a client route is deterministic:
 * `<peerBase>/<providerId>` (lib/peer-probe.mjs peerProviderUrl). The proxy
 * strips the leading `/<providerId>` and single-joins the rest onto the
 * configured base. Keys are deliberately NOT consulted: llm-reverse-proxy
 * performs NO credential handling — requests must already carry valid
 * provider keys, so every routable provider is exposed unconditionally.
 *
 * The deployed config also carries the hand-added entries the catalogs do
 * not know about: `llama-swap`, the LOCAL GGUF peer (env
 * LLAMA_SWAP_BASE_URL, default http://127.0.0.1:8101 — loopback is
 * deliberate: llama-swap's inbound auth is its bearer key and the loopback
 * hop never leaves the host), plus two static metadata passthroughs,
 * `models.dev` and `catwalk` (public, no keys, never drift-checked).
 *
 * Drift checking is unchanged: lib/cloud-providers.mjs (docs/d024) stays the
 * reference for ITS nine ids — a deployed value that differs from the fact
 * table warns. Those nine resolve through the pi-ai/models.dev rows, which
 * must therefore agree with the fact table.
 *
 * Overwrite semantics follow the repo-wide generator standard
 * (lib/artifact.mjs): a rerun REPLACES the deployed config by default;
 * DRY_RUN=1 writes an inspectable .dry-run preview instead.
 *
 * Usage: ./generate.sh (the standard wrapper — node_run interpreter
 * selection, same as the other environments) or node generate-config.mjs
 * [out]
 *   out defaults to ./llm-reverse-proxy.json (the path run.sh serves).
 *   Env: LIB_DIR (default ../lib), DRY_RUN, LLAMA_SWAP_BASE_URL,
 *   MODELS_DEV_JSON, CATWALK_FACTS_JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);
const { PI_AI_PROVIDERS } =
	/** @type {typeof import("../lib/pi-ai-providers.mjs")} */ (
		await import(`${LIB_DIR}/pi-ai-providers.mjs`)
	);
const { AI_SDK_PACKAGE_ENDPOINTS } =
	/** @type {typeof import("../lib/ai-sdk-package-endpoints.mjs")} */ (
		await import(`${LIB_DIR}/ai-sdk-package-endpoints.mjs`)
	);
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
setLogTool("llm-reverse-proxy/generate-config");

const out = process.argv[2] ?? join(scriptDir, "llm-reverse-proxy.json");
const MODELS_DEV_JSON =
	process.env.MODELS_DEV_JSON ?? join(LIB_DIR, "models.dev.api.json");
const CATWALK_FACTS_JSON =
	process.env.CATWALK_FACTS_JSON ?? join(LIB_DIR, "catwalk-facts.json");

/**
 * A candidate route before the priority merge.
 * @typedef {object} RouteCandidate
 * @property {string} id route name (the provider's name in ITS source)
 * @property {string} url the FULL real base URL
 * @property {string} source which of the three catalogs supplied it
 */

/**
 * A skipped source row — why it is NOT in the routing table.
 * @typedef {object} SkippedRow
 * @property {string} source
 * @property {string} id
 * @property {string} reason
 */

/** @type {RouteCandidate[]} */
const candidates = [];
/** @type {SkippedRow[]} */
const skipped = [];

/**
 * A single fixed public URL is routable; env-placeholder and account-scoped
 * templates (`$VAR`, `{PLACEHOLDER}`) are not — the proxy forwards to one
 * configured base, so a URL that varies per account cannot be expressed.
 * @param {string} url
 * @returns {boolean}
 */
function routableUrl(url) {
	return Boolean(url) && !url.startsWith("$") && !url.includes("{");
}

// --- source 1: pi-ai (top priority) -----------------------------------------
for (const p of Object.values(PI_AI_PROVIDERS)) {
	candidates.push({ id: p.id, url: p.baseUrl, source: "pi-ai" });
}

// --- source 2: models.dev (ai-sdk / opencode's catalog) ---------------------
/** @type {Record<string, { api?: string, npm?: string, name?: string }>} */
let modelsDev = {};
try {
	modelsDev = /** @type {typeof modelsDev} */ (
		JSON.parse(readFileSync(MODELS_DEV_JSON, "utf-8"))
	);
} catch (err) {
	logWarn("models.dev catalog unreadable — its layer is skipped", {
		path: MODELS_DEV_JSON,
		error: /** @type {any} */ (err)?.message ?? String(err),
	});
}
for (const [id, p] of Object.entries(modelsDev)) {
	if (routableUrl(p.api ?? "")) {
		candidates.push({
			id,
			url: /** @type {string} */ (p.api),
			source: "models.dev",
		});
		continue;
	}
	// No usable `api` URL: defer to the record's ai-sdk package. Only
	// packages with a canonical public endpoint resolve; the rest are
	// documented skips (lib/ai-sdk-package-endpoints.mjs).
	const pkg = AI_SDK_PACKAGE_ENDPOINTS[p.npm ?? ""];
	if (pkg?.endpoint) {
		candidates.push({ id, url: pkg.endpoint, source: "models.dev(npm)" });
	} else if (pkg?.reason) {
		skipped.push({ source: "models.dev", id, reason: pkg.reason });
	} else {
		skipped.push({
			source: "models.dev",
			id,
			reason: "no `api` URL and its npm package is unmapped",
		});
	}
}

// --- source 3: catwalk (crush's catalog) ------------------------------------
/** @type {{ providers?: Array<{ id?: string, api_endpoint?: string }> }} */
let catwalk = {};
try {
	catwalk = /** @type {typeof catwalk} */ (
		JSON.parse(readFileSync(CATWALK_FACTS_JSON, "utf-8"))
	);
} catch (err) {
	logWarn("catwalk facts cache unreadable — its layer is skipped", {
		path: CATWALK_FACTS_JSON,
		error: /** @type {any} */ (err)?.message ?? String(err),
	});
}
for (const p of catwalk.providers ?? []) {
	if (!p.id) continue;
	if (!routableUrl(p.api_endpoint ?? "")) {
		skipped.push({
			source: "catwalk",
			id: p.id,
			reason: "endpoint is an env/account placeholder or absent",
		});
		continue;
	}
	candidates.push({
		id: p.id,
		url: /** @type {string} */ (p.api_endpoint),
		source: "catwalk",
	});
}

// --- priority merge ----------------------------------------------------------
// First source to claim a NAME owns the route (pi-ai > models.dev > catwalk,
// docs/d038). Later claims on the same name are logged with what they lost;
// equal URLs are a quiet cross-catalog agreement, not a conflict.
/** @type {Map<string, { url: string, source: string }>} */
const routes = new Map();
/** @type {Record<string, number>} */
const perSource = {};
let overruled = 0;
for (const c of candidates) {
	perSource[c.source] = (perSource[c.source] ?? 0) + 1;
	const held = routes.get(c.id);
	if (held) {
		if (held.url === c.url) continue;
		logWarn(
			"route kept from the higher-priority source — lower source's endpoint ignored",
			{
				route: c.id,
				winner: `${held.source}: ${held.url}`,
				ignored: `${c.source}: ${c.url}`,
			},
		);
		overruled++;
		continue;
	}
	routes.set(c.id, { url: c.url, source: c.source });
}

if (skipped.length) {
	for (const s of skipped) {
		logInfo("source row not routable — no proxy route", {
			source: s.source,
			provider: s.id,
			reason: s.reason,
		});
	}
}

/** @type {{ listen: string, providers: Record<string, string> }} */
const cfg = {
	listen: "0.0.0.0:8080",
	// id → FULL real base URL (docs/d027), catalog routes first (insertion
	// order is kept for a stable, reviewable diff), then the LOCAL llama-swap
	// peer and the metadata passthroughs (see header).
	providers: Object.fromEntries([
		...[...routes.entries()].map(([id, r]) => [id, r.url]),
		["llama-swap", process.env.LLAMA_SWAP_BASE_URL ?? "http://127.0.0.1:8101"],
		// Static metadata passthroughs — public endpoints, no keys, never
		// fact-table rows (see header).
		["models.dev", "https://models.dev"],
		["catwalk", "https://catwalk.charm.land"],
	]),
};
const written = writeArtifact(out, `${JSON.stringify(cfg, null, 2)}\n`);
logInfo("wrote llm-reverse-proxy config", {
	path: written,
	routes: Object.keys(cfg.providers).length,
	perSource,
	overruled,
	skipped: skipped.length,
});

/** @type {{ providers?: Record<string, string> }} */
const deployedState = existsSync(out)
	? JSON.parse(readFileSync(out, "utf-8"))
	: {};
const deployed = deployedState.providers ?? {};
const missing = Object.keys(CLOUD_PROVIDERS).filter((id) => !deployed[id]);
if (missing.length) {
	logWarn(
		"providers in the fact table but NOT deployed — their peer path-routes are dead",
		{
			missing,
		},
	);
}
for (const [id, url] of Object.entries(deployed)) {
	const expected = CLOUD_PROVIDERS[id]?.baseUrl;
	if (expected && expected !== url) {
		logWarn("deployed upstream differs from the fact table — drift", {
			provider: id,
			deployed: url,
			factTable: expected,
		});
	}
}
