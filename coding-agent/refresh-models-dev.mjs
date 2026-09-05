/**
 * @fileoverview refresh-models-dev.mjs — Best-effort refresh of the vendored models.dev
 * catalog (models.dev.api.json) from https://models.dev/api.json. Designed to be SAFE to
 * call from generate.sh on every run: it never clobbers the existing file on failure.
 *
 *   - download is written to a temp file next to the target, validated, then
 *     atomically renamed into place — a failed/partial download never touches
 *     the live catalog.
 *   - any error (network, non-200, invalid JSON, unexpected shape, truncated
 *     payload) is reported and the current file is left intact.
 *   - this is why it can run in restricted environments (air-gapped hosts,
 *     behind a reverse proxy that blocks direct egress): the fetch just fails
 *     and generation proceeds with the last good vendored copy.
 *   - honors http(s)_proxy via undici's EnvHttpProxyAgent (docs/d001), kept
 *     defensive so a missing undici install only drops proxy support.
 *
 * Usage: node refresh-models-dev.mjs [out]
 *   out defaults to ./models.dev.api.json
 */

import { renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Structured logging (JSON lines on stderr; see lib/log.mjs).  The env
// override lets generate.sh point this at its scratch-dir copy.
const { logInfo, logWarn, setLogTool } = await import(
	process.env.LOG_LIB ?? new URL("../lib/log.mjs", import.meta.url)
);
setLogTool("coding-agent/refresh-models-dev");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const CATALOG_URL = "https://models.dev/api.json";
const OUT = process.argv[2] ?? join(scriptDir, "models.dev.api.json");
const REQUEST_TIMEOUT_MS = 15000;
// Reject obviously-wrong payloads (404 HTML, captive portal, truncated
// download) while tolerating normal catalog growth/shrink over time.
const MIN_PROVIDERS = 100;

if (
	process.env.http_proxy ||
	process.env.HTTP_PROXY ||
	process.env.https_proxy ||
	process.env.HTTPS_PROXY
) {
	try {
		const require = createRequire(import.meta.url);
		const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici");
		setGlobalDispatcher(new EnvHttpProxyAgent());
	} catch (err) {
		logWarn("proxy set but undici unavailable; fetch will not use the proxy", {
			error: err.message,
		});
	}
}

function fail(msg) {
	logWarn("models.dev refresh skipped — keeping existing catalog", {
		reason: msg,
	});
	process.exit(1);
}

async function main() {
	let res;
	try {
		res = await fetch(CATALOG_URL, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (err) {
		return fail(`fetch failed: ${err?.cause?.code || err?.message || err}`);
	}
	if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText}`);

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
	const clinePass = catalog["cline-pass"];
	if (
		!clinePass ||
		typeof clinePass.models !== "object" ||
		clinePass.models === null
	) {
		return fail("response missing expected provider 'cline-pass'");
	}
	const providerCount = Object.keys(catalog).length;
	if (providerCount < MIN_PROVIDERS) {
		return fail(
			`unexpectedly small catalog (${providerCount} providers < ${MIN_PROVIDERS})`,
		);
	}

	const tmp = `${OUT}.${process.pid}.tmp`;
	// Re-serialize the VALIDATED catalog instead of writing the raw response
	// body: models.dev serves the whole catalog as one ~4 MB minified line,
	// and a single-line file makes every refresh an unreviewable whole-file
	// diff (`--stat` helpfully reports "1 insertion(+), 1 deletion(-)" — those
	// two lines are the entire file). Tab-indented is also biome's canonical
	// JSON output (verified: `biome format` is a no-op on it), so the file
	// stays formatter-clean without biome ever touching it.
	writeFileSync(tmp, `${JSON.stringify(catalog, null, "\t")}\n`);
	renameSync(tmp, OUT); // atomic on the same filesystem
	logInfo("refreshed models.dev catalog", {
		path: OUT,
		providers: providerCount,
	});
}

main().catch((err) => fail(err?.message || String(err)));
