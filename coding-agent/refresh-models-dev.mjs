/**
 * @fileoverview refresh-models-dev.mjs — refresh the vendored models.dev
 * catalog (lib/models.dev.api.json) from the canonical upstream
 * (docs/d108; the prefixed reverse-proxy relay chain of d027/d063 is gone):
 *
 * The chain is upstreamCandidates (route-probe.mjs): the operator's
 * MODELS_DEV_RELAY_URL when set (empty = no fetch at all), else the ONE
 * canonical models.dev URL, reached through the environment proxy
 * (NODE_USE_ENV_PROXY=1, docs/d074). models.dev answers byte-for-byte, so
 * the response is validated exactly like any other catalog download.
 *
 * The stale-copy fallback is why this is safe to call on every run, air-
 * gapped hosts and egress-blocking proxies included: no failure here is a
 * precondition for generation, and none can clobber the last good catalog —
 * a payload is validated in memory and only then renamed over the live file,
 * so a network error, non-200, invalid JSON, unexpected shape or truncated
 * download just advances to the next candidate. A payload that validates but
 * carries the same facts as the file already there is not written at all
 * (lib/fact-table.mjs, docs/d086). Proxy env is honored
 * natively by Node (NODE_USE_ENV_PROXY=1, set by lib/node-run.sh; docs/d074)
 * — no repo-side dispatcher.
 *
 * Validation is scoped to what the generators consume from the catalog (see
 * coding-agent/generate-pi-coding-agent.mjs): every listed
 * provider must exist with a models map or the payload is rejected. (The
 * former llm-local-inference generators were also consumers until the
 * cloud-relay handoff to estige removed them; the required list
 * keeps its UNION shape so a future consumer needs no edit here.)
 *
 * Usage: node refresh-models-dev.mjs [out]
 *   out defaults to ./lib/models.dev.api.json in this folder
 *   (i.e. the vendored shared catalog itself).
 * Env: MODELS_DEV_RELAY_URL — operator's override URL (replaces the
 *   canonical candidate entirely; set to empty to disable the fetch — the
 *   stale vendored copy then always wins).
 *
 * Lives in coding-agent/ (its invoker is coding-agent/generate.mjs, which
 * points it at this run's catalog path — docs/d039) but writes the SHARED
 * vendored catalog: ../lib stays the catalog home because
 * estige/generate.mjs reads it too.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { upstreamCandidates } from "./route-probe.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "lib");
const { publishProviderMirror } =
	/** @type {typeof import("./lib/fact-table.mjs")} */ (
		await import(`${LIB_DIR}/fact-table.mjs`)
	);
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("./lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);

setLogTool("coding-agent/refresh-models-dev");
/**
 * ?type=all pins the FULL payload (every provider type): the generators read
 * slices the default view could theoretically drop — google's whole lineup
 * comes from here (catalogOnly, docs/d033). Byte-identical to the bare URL
 * today; the query is the explicit contract, not a behavior change.
 * @type {string}
 */
const RELAY_PATH_AND_QUERY = "/api.json?type=all";

const OUT =
	process.argv[2] ?? join(scriptDir, "lib", "models.dev.api.json");
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Provider entries the generators read from the catalog; each must exist with
 * a models map or the payload is rejected.
 * @type {readonly string[]}
 */
const REQUIRED_PROVIDERS = ["opencode", "opencode-go", "cline-pass", "hyper"];
/**
 * Reject obviously-wrong payloads (404 HTML, captive portal, truncated
 * download) while tolerating normal catalog growth/shrink over time.
 * @type {number}
 */
const MIN_PROVIDERS = 100;

/**
 * @param {string} msg static label — the structured detail goes in `fields`
 * @param {Record<string, unknown>} [fields]
 */
function fail(msg, fields) {
	logWarn("models.dev refresh skipped — keeping existing catalog", {
		reason: msg,
		...fields,
	});
	process.exit(1);
}

/**
 * Fetch one source and return the response, or null on any failure (the
 * caller advances to the next source in the chain).
 * @param {string} url
 * @param {{ via: string }} options
 * @returns {Promise<Response|null>}
 */
async function fetchCatalog(url, { via }) {
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) {
			logWarn("models.dev source answered with an error", {
				via,
				url,
				status: res.status,
				statusText: res.statusText,
			});
			return null;
		}
		logInfo("models.dev source answered", { via, url });
		return res;
	} catch (err) {
		logWarn("models.dev source unreachable", {
			via,
			url,
			error: err,
		});
		return null;
	}
}

/**
 * One-shot refresh CLI: walk the fallback chain, validate the payload
 * (REQUIRED_PROVIDERS + MIN_PROVIDERS), write the atomic temp file, and
 * rename it over CATALOG_PATH. Any validation failure is a `fail()` exit 1
 * — the previous catalog is never touched (docs/d027's stale-source rule).
 * @returns {Promise<void>}
 */
async function main() {
	let res = null;
	let via = "";
	let url = "";
	for (const candidate of upstreamCandidates(
		"models.dev",
		RELAY_PATH_AND_QUERY,
		process.env.MODELS_DEV_RELAY_URL,
	)) {
		res = await fetchCatalog(candidate, { via: "upstream" });
		via = "upstream";
		url = candidate;
		if (res) {
			break;
		}
	}
	if (!res) {
		return fail("no catalog source answered");
	}

	let text;
	try {
		text = await res.text();
	} catch (err) {
		return fail("body read failed", { via, url, error: err });
	}

	let catalog;
	try {
		catalog = JSON.parse(text);
	} catch (err) {
		return fail("invalid JSON", { via, url, error: err });
	}

	if (
		typeof catalog !== "object" ||
		catalog === null ||
		Array.isArray(catalog)
	) {
		return fail("response is not a provider map");
	}
	for (const id of REQUIRED_PROVIDERS) {
		const provider = catalog[id];
		if (
			!provider ||
			typeof provider.models !== "object" ||
			provider.models === null
		) {
			return fail(`response missing expected provider '${id}'`);
		}
	}
	const providerCount = Object.keys(catalog).length;
	if (providerCount < MIN_PROVIDERS) {
		return fail(
			`unexpectedly small catalog (${providerCount} providers < ${MIN_PROVIDERS})`,
		);
	}

	// Re-serialize the VALIDATED catalog instead of writing the raw response
	// body: models.dev serves the whole catalog as one ~4 MB minified line, and
	// it emits providers (and their models maps) in its own iteration order,
	// which differs between two fetches of identical data — so a raw body write
	// turns a routine refresh into a ~416k-line diff of nothing. Canonical
	// ordering plus the skip-when-unchanged rule (lib/fact-table.mjs, docs/d086)
	// reduce the same refresh to the lines that actually moved.
	const published = publishProviderMirror(OUT, catalog);
	logInfo(
		published.written
			? "refreshed models.dev catalog"
			: "models.dev catalog unchanged — not rewritten",
		{
			path: OUT,
			providers: providerCount,
			contentSha256: published.contentSha256,
		},
	);
}

main().catch((err) => fail("unhandled failure", { error: err }));
