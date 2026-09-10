/**
 * @fileoverview gen-lib.mjs — shared helpers for the split llama-swap peer/general
 * generators. explanations live in docs/d018-split-config-d.md (merge contract) and
 * docs/d001 (proxy baseUrl / plain-env-var key naming). HTTP probing is delegated to the
 * shared lib/peer-probe.mjs toolkit and re-exported here (docs/d023) — the copy unit for
 * this folder is "the folder + ../lib" (see docs/architecture.md).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Shared lib/ helpers (docs/d023): the structured logger and the HTTP probe
// toolkit live in ../lib and are resolved through the LIB_DIR convention
// (default: this folder's sibling lib/).  Re-exported so the generators that
// import gen-lib get a consistent logger and fetcher without importing lib
// themselves.
const LIB_DIR =
	process.env.LIB_DIR ?? fileURLToPath(new URL("../lib", import.meta.url));
const { logInfo, logWarn, logError, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { fetchModelEntries, DEFAULT_PEER_FALLBACK } =
	/** @type {typeof import("../lib/peer-probe.mjs")} */ (
		await import(`${LIB_DIR}/peer-probe.mjs`)
	);
const { CLOUD_PROVIDERS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);
setLogTool("llm-reverse-proxy/gen-lib");

export { DEFAULT_PEER_FALLBACK, fetchModelEntries, logError, logInfo, logWarn };

export const scriptDir = dirname(fileURLToPath(import.meta.url));

// --- Providers ---------------------------------------------------------
// Keys match pi-coding-agent's built-in provider names so generated peer ids
// line up with what pi expects.  The stable FACTS (id / label / apiKeyEnv /
// default baseUrl) come from the shared lib/cloud-providers.mjs table
// (docs/d024) — this map only adds the per-provider llama-swap extras.  Two
// model-id sources:
//   - `modelsDev` — the vendored models.dev catalog (models.dev.api.json,
//     atomically refreshed by refresh-models-dev.mjs on every generate.sh
//     run); ALL models of that catalog provider are enumerated, no filtering
//     (access is decided at request time by the key the peer carries).
//   - otherwise the provider's own live /models endpoint, filtered by
//     `filter` (openrouter's ":free" slice).
//
// `apiKeyEnv` is the env var llama-swap reads for that peer's key at request
// time (from the shared fact table).  generate-peer-cloud.yaml.mjs iterates
// this map, so adding a provider here is the ONLY change needed to emit a new
// peer — and one that needs no extra facts needs no edit here at all.
//
// CURRENT PROVIDER SET (this table IS the provider list — it mirrors the key
// names documented in llm-reverse-proxy/.env.example):
//
//   | Provider     | Peer id      | Key env            | Base URL                       | Model ids                     |
//   |--------------|--------------|--------------------|--------------------------------|-------------------------------|
//   | OpenRouter   | openrouter   | OPENROUTER_API_KEY | https://openrouter.ai/api/v1   | live /models, ":free" slice   |
//   | OpenCode Zen | opencode     | OPENCODE_API_KEY   | https://opencode.ai/zen/v1     | models.dev catalog, all       |
//   | OpenCode Go  | opencode-go  | OPENCODE_API_KEY   | https://opencode.ai/zen/go/v1  | models.dev catalog, all       |
//   | ClinePass    | cline-pass   | CLINE_API_KEY      | https://api.cline.bot/api/v1   | models.dev catalog, all       |
//
// KEY-NAMING CONTRACT (docs/d001 §3 — plain un-prefixed env var names, the
// historical `__`-prefix is gone):
//   - PLAIN environment variable names — no `__` prefix.  The `__`-prefix
//     convention used to hide keys from pi's provider auto-detection, but
//     these keys are consumed SERVER-side (llama-swap resolves the ${env.*}
//     references in config.d/ from its own environment); pi is only a client
//     of llama-swap and authenticates with the llama-swap bearer key, so it
//     never sees them.  No `__`-prefix is recognized, ever — full rationale
//     in docs/d001.
//   - ONE unified OPENCODE_API_KEY covers both the Zen and the Go peers.  The
//     former split (OPENCODE_ZEN_API_KEY / OPENCODE_GO_API_KEY) is retired and
//     those names are ignored.
//   - `baseUrl` (the peer's proxy target, derived from the shared fact
//     table's real endpoint) is HARDCODED and deliberately NOT
//     env-overridable: the peer's proxy target is part of the provider
//     definition, not a host setting.  (Remote-target overrides live in the
//     gfx1030 peer generator, which is about *which instance* to route to —
//     PEER_BASE_URL.)
//
// Keys are read from the process environment (populated by load_secrets in
// generate.sh: infisical, or keys already in the caller's environment — no
// .env file is ever read).  A provider whose key
// is absent is still emitted — peerEntry() omits the apiKey field and access
// is decided at request time — except where the provider's own logic skips it.
export const PROVIDERS = {
	openrouter: {
		...CLOUD_PROVIDERS.openrouter,
		filter: (/** @type {import("../lib/peer-probe.mjs").RawModelEntry} */ m) =>
			m.id.endsWith(":free"),
	},
	opencode: {
		...CLOUD_PROVIDERS.opencode,
		modelsDev: "opencode",
	},
	"opencode-go": {
		...CLOUD_PROVIDERS["opencode-go"],
		modelsDev: "opencode-go",
	},
	"cline-pass": {
		...CLOUD_PROVIDERS["cline-pass"],
		modelsDev: "cline-pass",
	},
	mistral: {
		...CLOUD_PROVIDERS.mistral,
		modelsDev: "mistral",
		// Chat-only slice: the catalog also lists mistral-embed (embeddings)
		// and voxtral-*-tts (speech) which llama-swap would forward but no
		// chat client here can use.
		filter: (/** @type {import("../lib/peer-probe.mjs").RawModelEntry} */ m) =>
			!/embed|tts/i.test(m.id),
	},
};

// --- models.dev catalog ----------------------------------------------
// The SHARED vendored models.dev catalog (lib/models.dev.api.json, refreshed
// atomically by lib/refresh-models-dev.mjs — the tmp+rename contract means a
// failed fetch never corrupts the last good copy).  Providers flagged
// `modelsDev` in PROVIDERS take their model-id list from here, unfiltered.
function loadModelsDev(
	path = join(scriptDir, "..", "lib", "models.dev.api.json"),
) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

// --- Auth / fetch helpers ---------------------------------------------
// (the HTTP probe toolkit — fetchModelEntries and its /v1/models fallback,
// status-carrying errors and proxy handling — lives in lib/peer-probe.mjs and
// is re-exported above, docs/d023.)

// Resolve the model-id list for one provider: from the models.dev catalog
// when flagged `modelsDev` (filtered by `p.filter` when set), otherwise from
// the provider's own live /models endpoint filtered by `p.filter`.  Returns
// null on skip (catalog entry missing / fetch failure) so callers treat it as
// "no result".  The peer entry written to disk references the env var, never
// the key value.
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
		const ids = Object.keys(provider.models);
		return p.filter ? ids.filter((id) => p.filter({ id })) : ids;
	}
	const apiKey = process.env[p.apiKeyEnv] ?? "";
	try {
		const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
		const data = await fetchModelEntries(p.baseUrl, headers);
		if (data.length === 0) {
			throw new Error(`GET ${p.baseUrl}/models returned no models`);
		}
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
	const proxy = p.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
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
