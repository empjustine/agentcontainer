/**
 * @fileoverview refresh-models-dev.mjs — refresh the vendored models.dev
 * catalog (lib/models.dev.api.json) from the reverse-proxy relay chain
 * (docs/d027, d063 — no direct models.dev leg: outside llm-reverse-proxy,
 * everything is proxy-only):
 *
 *   1. RELAY — reverse-proxy URLs only (relayCandidates, route-probe.mjs):
 *      the operator's MODELS_DEV_RELAY_URL when set (empty = no relay at
 *      all), else the local llm-reverse-proxy passthrough
 *      (http://127.0.0.1:8080/models.dev/api.json), then the vault
 *      reverse-proxy host-form routes. The relay forwards models.dev
 *      byte-for-byte, so the response is validated exactly like a direct
 *      one.
 *   2. STALE COPY — last resort: any failure above leaves the existing
 *      vendored file intact and generation proceeds with it.
 *
 * Designed to be SAFE to call from both generate.sh scripts on every run:
 * it never clobbers the existing file on failure.
 *
 *   - download is written to a temp file next to the target, validated, then
 *     atomically renamed into place — a failed/partial download never touches
 *     the live catalog.
 *   - any error (network, non-200, invalid JSON, unexpected shape, truncated
 *     payload) just advances to the next source; the current file is left
 *     intact.
 *   - this is why it can run in restricted environments (air-gapped hosts,
 *     behind a reverse proxy that blocks direct egress): the fetches fail
 *     and generation proceeds with the last good vendored copy.
 *   - honors http(s)_proxy via undici's EnvHttpProxyAgent (docs/d001), kept
 *     defensive so a missing undici install only drops proxy support.
 *
 * Validation is scoped to what the generators consume from the catalog (see
 * coding-agent/generate-pi-coding-agent.mjs): every listed
 * provider must exist with a models map or the payload is rejected. (The
 * former llm-local-inference generators were also consumers until the
 * cloud-relay handoff to llm-reverse-proxy removed them; the required list
 * keeps its UNION shape so a future consumer needs no edit here.)
 *
 * Usage: node refresh-models-dev.mjs [out]
 *   out defaults to ../lib/models.dev.api.json relative to this file
 *   (i.e. the vendored shared catalog itself).
 * Env: MODELS_DEV_RELAY_URL — operator's relay URL (replaces the default
 *   chain entirely; set to empty to disable relays — the stale vendored
 *   copy then always wins).
 *
 * Lives in coding-agent/ (its only invoker is coding-agent/generate.sh —
 * docs/d039) but writes the SHARED vendored catalog: ../lib stays the catalog
 * home because llm-reverse-proxy/generate-config.mjs reads it too.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { relayCandidates, useEnvProxy } from "./route-probe.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);

useEnvProxy();
setLogTool("coding-agent/refresh-models-dev");
/**
 * ?type=all pins the FULL payload (every provider type): the generators read
 * slices the default view could theoretically drop — google's whole lineup
 * comes from here (catalogOnly, docs/d033). Byte-identical to the bare URL
 * today; the query is the explicit contract, not a behavior change.
 * @type {string}
 */
const RELAY_PATH_AND_QUERY = "/api.json?type=all";

const OUT = process.argv[2] ?? join(scriptDir, "models.dev.api.json");
const REQUEST_TIMEOUT_MS = 15000;
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
	// Fallback chain (docs/d027, d063): reverse-proxy relay candidates →
	// stale vendored copy. Each candidate is validated identically before
	// the atomic rename; the stale file is only ever touched after a fully
	// validated payload exists.
	let res = null;
	let via = "";
	let url = "";
	for (const candidate of relayCandidates(
		"models.dev",
		RELAY_PATH_AND_QUERY,
		process.env.MODELS_DEV_RELAY_URL,
	)) {
		res = await fetchCatalog(candidate, { via: "relay" });
		via = "relay";
		url = candidate;
		if (res) break;
	}
	if (!res) return fail("no relay source answered");

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
	// body: models.dev serves the whole catalog as one ~4 MB minified line,
	// and a single-line file makes every refresh an unreviewable whole-file
	// diff (`--stat` helpfully reports "1 insertion(+), 1 deletion(-)" — those
	// two lines are the entire file). Tab-indented is also biome's canonical
	// JSON output (verified: `biome format` is a no-op on it), so the file
	// stays formatter-clean without biome ever touching it.
	const written = writeArtifact(
		OUT,
		`${JSON.stringify(catalog, null, "\t")}\n`,
	);
	logInfo("refreshed models.dev catalog", {
		path: written,
		providers: providerCount,
	});
}

main().catch((err) => fail("unhandled failure", { error: err }));
