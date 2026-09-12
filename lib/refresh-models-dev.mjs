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
 * coding-agent/generate-cloud-alternative-providers.mjs): every listed
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
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeArtifact } from "./artifact.mjs";
import { logInfo, logWarn, setLogTool } from "./log.mjs";
import { useEnvProxy } from "./peer-probe.mjs";

useEnvProxy();
setLogTool("lib/refresh-models-dev");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const CATALOG_URL = "https://models.dev/api.json";
// Relay fallback (docs/d027): the llm-reverse-proxy passthrough for
// https://models.dev. Default assumes the proxy runs on THIS host (run.sh
// listens on HOST_PORT 8080, the funnel front); container-side callers
// override via env. An empty value disables the relay hop.
const RELAY_URL =
	process.env.MODELS_DEV_RELAY_URL ??
	"http://127.0.0.1:8080/models.dev/api.json";
const OUT = process.argv[2] ?? join(scriptDir, "models.dev.api.json");
const REQUEST_TIMEOUT_MS = 15000;
// Provider entries the generators read from the catalog; each must exist with
// a models map or the payload is rejected.
const REQUIRED_PROVIDERS = ["opencode", "opencode-go", "cline-pass", "hyper"];
// Reject obviously-wrong payloads (404 HTML, captive portal, truncated
// download) while tolerating normal catalog growth/shrink over time.
const MIN_PROVIDERS = 100;

function fail(msg) {
	logWarn("models.dev refresh skipped — keeping existing catalog", {
		reason: msg,
	});
	process.exit(1);
}

// Fetch one source and return the response, or null on any failure (the
// caller advances to the next source in the chain).
async function fetchCatalog(url, { via }) {
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) {
			logWarn("models.dev source answered with an error", {
				via,
				url,
				status: `${res.status} ${res.statusText}`,
			});
			return null;
		}
		logInfo("models.dev source answered", { via, url });
		return res;
	} catch (err) {
		logWarn("models.dev source unreachable", {
			via,
			url,
			error: err?.cause?.code || err?.message || String(err),
		});
		return null;
	}
}

async function main() {
	// Fallback chain (docs/d027): direct → relay → stale vendored copy. Each
	// source is validated identically before the atomic rename; the stale
	// file is only ever touched after a fully validated payload exists.
	let res = await fetchCatalog(CATALOG_URL, { via: "direct" });
	if (!res && RELAY_URL) {
		res = await fetchCatalog(RELAY_URL, { via: "relay" });
	}
	if (!res) return fail("no source answered (direct and relay both failed)");

	let text;
	try {
		text = await res.text();
	} catch (err) {
		return fail(`body read failed: ${err.message}`);
	}

	let catalog;
	try {
		catalog = JSON.parse(text);
	} catch (err) {
		return fail(`invalid JSON: ${err.message}`);
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

	// lib/artifact.mjs write contract: atomic tmp+rename, replace by default,
	// DRY_RUN=1 leaves the vendored catalog untouched and writes a preview.
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

main().catch((err) => fail(err?.message || String(err)));
