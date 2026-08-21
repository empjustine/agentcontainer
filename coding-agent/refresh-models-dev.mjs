// Best-effort refresh of the vendored models.dev catalog (models.dev.api.json)
// from https://models.dev/api.json.  Designed to be SAFE to call from
// generate.sh on every run: it never clobbers the existing file on failure.
//
//   - download is written to a temp file next to the target, validated, then
//     atomically renamed into place — a failed/partial download never touches
//     the live catalog.
//   - any error (network, non-200, invalid JSON, unexpected shape, truncated
//     payload) is reported and the current file is left intact.
//   - this is why it can run in restricted environments (air-gapped hosts,
//     behind a reverse proxy that blocks direct egress): the fetch just fails
//     and generation proceeds with the last good vendored copy.
//   - honors http(s)_proxy via undici's EnvHttpProxyAgent (docs/d001), kept
//     defensive so a missing undici install only drops proxy support.
//
// Usage: node refresh-models-dev.mjs [out]
//   out defaults to ./models.dev.api.json

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const CATALOG_URL = "https://models.dev/api.json";
const OUT = process.argv[2] ?? join(scriptDir, "models.dev.api.json");
const REQUEST_TIMEOUT_MS = 15000;
// Reject obviously-wrong payloads (404 HTML, captive portal, truncated
// download) while tolerating normal catalog growth/shrink over time.
const MIN_PROVIDERS = 100;

if (process.env.http_proxy || process.env.HTTP_PROXY ||
    process.env.https_proxy || process.env.HTTPS_PROXY) {
  try {
    const require = createRequire(import.meta.url);
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch (err) {
    console.warn(`  warning: proxy set but undici unavailable: ${err.message}`);
  }
}

function fail(msg) {
  console.warn(`  warning: models.dev refresh skipped — ${msg}; keeping existing catalog`);
  process.exit(1);
}

async function main() {
  let res;
  try {
    res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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

  if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
    return fail("response is not a provider map");
  }
  const clinePass = catalog["cline-pass"];
  if (!clinePass || typeof clinePass.models !== "object" || clinePass.models === null) {
    return fail("response missing expected provider 'cline-pass'");
  }
  const providerCount = Object.keys(catalog).length;
  if (providerCount < MIN_PROVIDERS) {
    return fail(`unexpectedly small catalog (${providerCount} providers < ${MIN_PROVIDERS})`);
  }

  const tmp = `${OUT}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, OUT); // atomic on the same filesystem
  console.warn(`  refreshed models.dev catalog -> ${OUT} (${providerCount} providers)`);
}

main().catch((err) => fail(err?.message || String(err)));
