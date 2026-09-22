/**
 * @fileoverview refresh-models-dev.mjs — refresh the vendored models.dev
 * catalog (lib/models.dev.api.json) from https://models.dev/api.json, with a
 * fallback chain (docs/d027):
 *
 *   1. DIRECT — https://models.dev/api.json (the normal case: generation
 *      hosts have direct egress).
 *   2. RELAY — the llm-reverse-proxy passthrough (default
 *      http://127.0.0.1:8080/models.dev/api.json, MODELS_DEV_RELAY_URL to
 *      override): used when direct egress is blocked/broken but the local
 *      LLM relay is up. The relay forwards models.dev byte-for-byte, so the
 *      response is validated exactly like a direct one.
 *   3. STALE COPY — last resort: any failure above leaves the existing
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
 * former llm-local-inference peer generators were also consumers until the
 * cloud-relay handoff to llm-reverse-proxy removed them; the required list
 * keeps its UNION shape so a future consumer needs no edit here.)
 *
 * Usage: node refresh-models-dev.mjs [out]
 *   out defaults to ../lib/models.dev.api.json relative to this file
 *   (i.e. the vendored shared catalog itself).
 * Env: MODELS_DEV_RELAY_URL — relay fallback URL (default
 *   http://127.0.0.1:8080/models.dev/api.json; set to empty to disable the
 *   relay hop).
 *
 * Lives in coding-agent/ (its only invoker is coding-agent/generate.sh —
 * docs/d039) but writes the SHARED vendored catalog: ../lib stays the catalog
 * home because llm-reverse-proxy/generate-config.mjs reads it too.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useEnvProxy } from "./peer-probe.mjs";

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
// ?type=all pins the FULL payload (every provider type): the generators read
// slices the default view could theoretically drop — google's whole lineup
// comes from here (catalogOnly, docs/d033). Byte-identical to the bare URL
// today; the query is the explicit contract, not a behavior change.
const CATALOG_URL = "https://models.dev/api.json?type=all";
// Relay fallback (docs/d027): the llm-reverse-proxy passthrough for
// https://models.dev. Default assumes the proxy runs on THIS host (run.sh
// listens on HOST_PORT 8080, the funnel front); container-side callers
// override via env. An empty value disables the relay hop.
const RELAY_URL =
	process.env.MODELS_DEV_RELAY_URL ??
	"http://127.0.0.1:8080/models.dev/api.json";
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

async function main() {
	// Fallback chain (docs/d027): direct → relay → stale vendored copy. Each
	// source is validated identically before the atomic rename; the stale
	// file is only ever touched after a fully validated payload exists.
	let res = await fetchCatalog(CATALOG_URL, { via: "direct" });
	let via = "direct";
	let url = CATALOG_URL;
	if (!res && RELAY_URL) {
		res = await fetchCatalog(RELAY_URL, { via: "relay" });
		via = "relay";
		url = RELAY_URL;
	}
	if (!res) return fail("no source answered (direct and relay both failed)");

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
