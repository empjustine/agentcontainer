/**
 * @fileoverview gen-lib.mjs — shared helpers for the split llama-swap peer/general
 * generators. Kept self-contained so a serving dir can be copied onto a host in isolation;
 * explanations live in docs/d018-split-config-d.md (merge contract) and docs/d001
 * (proxy baseUrl / plain-env-var key naming).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Structured logging (JSON lines on stderr; see lib/log.mjs), re-exported so
// the generators that import gen-lib get a consistent logger.
const { logDebug, logInfo, logWarn, logError, setLogTool } = await import(
	process.env.LOG_LIB ?? new URL("../lib/log.mjs", import.meta.url)
);
setLogTool("openai-completions/gen-lib");

export { logDebug, logError, logInfo, logWarn };

export const scriptDir = dirname(fileURLToPath(import.meta.url));

// Route fetch() through http(s)_proxy when set (rationale: docs/d001 §1).
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
		logWarn(
			"http(s)_proxy set but undici EnvHttpProxyAgent unavailable — fetch requests will NOT use the proxy",
			{ error: err.message },
		);
	}
}

const REQUEST_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
	return fetch(url, {
		...options,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

// --- Providers ---------------------------------------------------------
// Keys match pi-coding-agent's built-in provider names so generated peer ids
// line up with what pi expects.  Two model-id sources:
//   - `modelsDev` — the vendored models.dev catalog (models.dev.api.json,
//     atomically refreshed by refresh-models-dev.mjs on every generate.sh
//     run); ALL models of that catalog provider are enumerated, no filtering
//     (access is decided at request time by the key the peer carries).
//   - otherwise the provider's own live /models endpoint, filtered by
//     `filter` (openrouter's ":free" slice).
//
// `apiKeyEnv` is the env var llama-swap reads for that peer's key at request
// time.  generate-peer-cloud.yaml.mjs iterates this map, so adding a provider
// here is the ONLY change needed to emit a new peer.
//
// CURRENT PROVIDER SET (this table IS the provider list — it mirrors the key
// names documented in openai-completions/.env.example):
//
//   | Provider     | Peer id      | Key env            | Base URL                       | Model ids                     |
//   |--------------|--------------|--------------------|--------------------------------|-------------------------------|
//   | OpenRouter   | openrouter   | OPENROUTER_API_KEY | https://openrouter.ai/api/v1   | live /models, ":free" slice   |
//   | OpenCode Zen | opencode     | OPENCODE_API_KEY   | https://opencode.ai/zen/v1     | models.dev catalog, all       |
//   | OpenCode Go  | opencode-go  | OPENCODE_API_KEY   | https://opencode.ai/zen/go/v1  | models.dev catalog, all       |
//   | ClinePass    | cline-pass   | CLINE_API_KEY      | https://api.cline.bot/api/v1   | models.dev catalog, all       |
//
// KEY-NAMING CONTRACT (docs/d001 §3 — plain un-prefixed env var names, the
// historical `__`-prefix is gone; see OLD/docs/d019 for the rationale):
//   - PLAIN environment variable names — no `__` prefix.  The `__`-prefix
//     convention used to hide keys from pi's provider auto-detection, but
//     these keys are consumed SERVER-side (llama-swap resolves the ${env.*}
//     references in config.d/ from its own environment); pi is only a client
//     of llama-swap and authenticates with the llama-swap bearer key, so it
//     never sees them.  No `__`-prefix is recognized, ever — see
//   - PLAIN environment variable names — no `__` prefix.  The `__`-prefix
//     convention used to hide keys from pi's provider auto-detection, but
//     these keys are consumed SERVER-side (llama-swap resolves the ${env.*}
//     references in config.d/ from its own environment); pi is only a client
//     of llama-swap and authenticates with the llama-swap bearer key, so it
//     never sees them.  No `__`-prefix is recognized, ever — see
//     OLD/docs/d019-unified-opencode-key.md for the historical rationale and
//     OLD/docs/d001-proxy-env-and-namespace.md for the original problem the
//     prefix was a workaround for.
//   - ONE unified OPENCODE_API_KEY covers both the Zen and the Go peers.  The
//     former split (OPENCODE_ZEN_API_KEY / OPENCODE_GO_API_KEY) is retired and
//     those names are ignored.
//   - `defaultBaseUrl` is HARDCODED and deliberately NOT env-overridable: the
//     peer's proxy target is part of the provider definition, not a host
//     setting.  (Remote-target overrides live in the gfx1030 peer generator,
//     which is about *which instance* to route to — PEER_BASE_URL.)
//
// Keys are read from the process environment (populated by load_secrets in
// generate.sh: infisical, or keys already in the caller's environment — no
// .env file is ever read).  A provider whose key
// is absent is still emitted — peerEntry() omits the apiKey field and access
// is decided at request time — except where the provider's own logic skips it.
export const PROVIDERS = {
	openrouter: {
		id: "openrouter",
		apiKeyEnv: "OPENROUTER_API_KEY",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		filter: (m) => m.id.endsWith(":free"),
	},
	opencode: {
		id: "opencode",
		apiKeyEnv: "OPENCODE_API_KEY",
		defaultBaseUrl: "https://opencode.ai/zen/v1",
		modelsDev: "opencode",
	},
	"opencode-go": {
		id: "opencode-go",
		apiKeyEnv: "OPENCODE_API_KEY",
		defaultBaseUrl: "https://opencode.ai/zen/go/v1",
		modelsDev: "opencode-go",
	},
	"cline-pass": {
		id: "cline-pass",
		apiKeyEnv: "CLINE_API_KEY",
		defaultBaseUrl: "https://api.cline.bot/api/v1",
		modelsDev: "cline-pass",
	},
};

// --- models.dev catalog ----------------------------------------------
// The vendored models.dev catalog (models.dev.api.json, refreshed atomically
// by refresh-models-dev.mjs — the tmp+rename contract means a failed fetch
// never corrupts the last good copy).  Providers flagged `modelsDev` in
// PROVIDERS take their model-id list from here, unfiltered.
export function loadModelsDev(path = join(scriptDir, "models.dev.api.json")) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

// --- Auth / fetch helpers ---------------------------------------------

export async function fetchModelsJson(baseUrl, headers) {
	let url = baseUrl.replace(/\/+$/, "") + "/models";
	let res = await fetchWithTimeout(url, { headers });
	if (res.status === 404 && !url.endsWith("/v1/models")) {
		url = baseUrl.replace(/\/+$/, "") + "/v1/models";
		res = await fetchWithTimeout(url, { headers });
	}
	if (!res.ok) {
		let body;
		try {
			body = await res.text();
		} catch {}
		const detail = body ? `: ${body.slice(0, 500)}` : "";
		throw new Error(
			`GET ${url} returned ${res.status} ${res.statusText}${detail}`,
		);
	}
	const body = await res.json();
	const data = body.data || body.models || body;
	if (!Array.isArray(data) || data.length === 0) {
		throw new Error(`GET ${url} returned no models`);
	}
	return { data, url };
}

// Resolve the model-id list for one provider: from the models.dev catalog
// when flagged `modelsDev` (ALL models, unfiltered), otherwise from the
// provider's own live /models endpoint filtered by `p.filter`.  Returns null
// on skip (catalog entry missing / fetch failure) so callers treat it as "no
// result".  The peer entry written to disk references the env var, never the
// key value.
export async function fetchPeerModels(p) {
	if (p.modelsDev) {
		const provider = loadModelsDev()[p.modelsDev];
		if (
			!provider ||
			typeof provider.models !== "object" ||
			provider.models === null
		) {
			logWarn("models.dev catalog has no provider — skipping", {
				provider: p.modelsDev,
			});
			return null;
		}
		return Object.keys(provider.models);
	}
	const apiKey = process.env[p.apiKeyEnv] ?? "";
	try {
		const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
		const { data } = await fetchModelsJson(p.defaultBaseUrl, headers);
		return data.filter(p.filter).map((m) => m.id ?? "unknown");
	} catch (err) {
		logWarn("fetch for provider failed — skipping", {
			provider: p.id,
			error: err?.cause?.code || err?.message || String(err),
		});
		return null;
	}
}

// --- llama-swap config helpers ---------------------------------------

export function loadCore(path = join(scriptDir, "llama-swap-core.json")) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

// Build a peer entry ({ proxy, models[, apiKey] }) from a provider + model
// list.  apiKey is emitted as a ${env.*} reference (resolved by llama-swap at
// load time) when the generator's own environment has the key; otherwise it is
// omitted.
export function peerEntry(p, models) {
	const proxy = p.defaultBaseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
	const entry = { proxy, models };
	if (process.env[p.apiKeyEnv] !== undefined) {
		entry.apiKey = `\${env.${p.apiKeyEnv}}`;
	}
	return entry;
}

// Write an object as pretty JSON into config.d/ (the YAML loader accepts JSON
// content, and JSON-in-.yaml matches the repo's existing config style).
export function writeConfigD(name, obj, dir = join(scriptDir, "config.d")) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf-8");
	renameSync(tmp, path); // atomic on the same filesystem
	logInfo("wrote config.d layer", { path });
}
