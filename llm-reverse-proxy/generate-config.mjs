/**
 * @fileoverview generate-config.mjs — Emit `llm-reverse-proxy.json`, the
 * deployed llm-reverse-proxy routing table, from the ONE shared provider
 * fact table (lib/cloud-providers.mjs, docs/d024).
 *
 * The convention this locks in (docs/d027): every provider in the fact table
 * gets a routing entry whose key is the provider id and whose value is the
 * provider's FULL real base URL — path suffixes included:
 *
 *     "hyper": "https://hyper.charm.land/v1"
 *     "google": "https://generativelanguage.googleapis.com/v1beta"
 *
 * so that a client route is deterministic and trivial:
 * `<peerBase>/<providerId>` (lib/peer-probe.mjs peerProviderUrl). The proxy
 * strips the leading `/<providerId>` and single-joins the rest onto the
 * configured base — e.g. `<peerBase>/hyper/chat/completions` hits
 * `https://hyper.charm.land/v1/chat/completions`, and
 * `<peerBase>/google/models/…` carries Google's NATIVE generative-ai
 * dialect byte-for-byte, which is precisely what llama-swap's
 * openai-completions-only peer routing could never do (docs/d027). A
 * provider id that is in the fact table but NOT in the deployed config is
 * unreachable through the peer: the coding-agent probes route by route and
 * simply skip what the router does not serve.
 *
 * Keys are deliberately NOT consulted here: llm-reverse-proxy performs NO
 * credential handling — requests must already carry valid provider keys, so
 * every fact-table provider is exposed unconditionally and clients
 * authenticate themselves (the pre-gateway PEER_API_KEY scheme is gone with
 * llama-swap's peer machinery, docs/d027).
 *
 * The deployed config may also carry hand-added entries the fact table does
 * not know about — notably `llama-swap`, the LOCAL GGUF peer (llm-local-
 * inference, LAN 8101). It is generated here too (env: LLAMA_SWAP_BASE_URL),
 * because it is the other half of the port model (docs/d027): the proxy owns
 * host port 8080 — the one the tailscale funnel serves the <funnel-id> route
 * on — and points the local face at the llama-swap instance on loopback:
 *
 *     "llama-swap": "http://127.0.0.1:8101"
 *
 * so `<peerBase>/llama-swap/v1/…` → `http://127.0.0.1:8101/v1/…`. Loopback
 * (not the LAN address) is deliberate: llama-swap's inbound auth is its
 * bearer key, and the loopback hop never leaves the host. This entry is NOT
 * drift-checked (no fact-table row; a local peer is host-specific), and the
 * drift check only ever warns for ids the fact table knows. Two static
 * catalog passthroughs complete the table: `models.dev` (the public
 * catalog endpoint, docs/d027-models-dev-relay-fallback — the relay route
 * the catalog refresher falls back to when the vendored copy is stale or
 * absent) and `catwalk` (https://catwalk.charm.land, Charm's curated model
 * catalog, docs/d028 — serves /v2/providers, the metadata tier for
 * catalog-consuming clients riding the peer). Both are public metadata
 * endpoints: no keys, never drift-checked.
 *
 * Overwrite semantics follow the repo-wide generator standard
 * (lib/artifact.mjs): a rerun REPLACES the deployed config by default —
 * generators are the source of truth (the former OVERWRITE=1 gate is gone);
 * DRY_RUN=1 skips the replacement and writes an inspectable
 * llm-reverse-proxy.json.dry-run preview instead.
 *
 * Usage: ./generate.sh (the standard wrapper — node_run interpreter
 * selection, same as the other environments) or node generate-config.mjs
 * [out]
 *   out defaults to ./llm-reverse-proxy.json (the path run.sh serves).
 *   Env: LIB_DIR (default ../lib), DRY_RUN, LLAMA_SWAP_BASE_URL.
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
const { writeArtifact } = /** @type {typeof import("../lib/artifact.mjs")} */ (
	await import(`${LIB_DIR}/artifact.mjs`)
);
setLogTool("llm-reverse-proxy/generate-config");

const out = process.argv[2] ?? join(scriptDir, "llm-reverse-proxy.json");

// Overwrite is the default (lib/artifact.mjs); DRY_RUN=1 leaves the deployed
// config untouched and writes an <out>.dry-run preview instead.
/** @type {{ listen: string, providers: Record<string, string> }} */
const cfg = {
	listen: "0.0.0.0:8080",
	// id → FULL real base URL (docs/d027). Object.entries order follows
	// insertion order — the fact table's declaration order, kept for a
	// stable, reviewable diff. The LOCAL llama-swap peer (LAN 8101, see
	// the header) is appended last, on loopback, so the local GGUF face
	// rides the same funnel: <peerBase>/llama-swap/… → 127.0.0.1:8101/….
	providers: Object.fromEntries([
		...Object.values(CLOUD_PROVIDERS).map((p) => [p.id, p.baseUrl]),
		["llama-swap", process.env.LLAMA_SWAP_BASE_URL ?? "http://127.0.0.1:8101"],
		// Static catalog passthroughs — public metadata endpoints, no
		// keys, never fact-table rows:
		//   models.dev — the CATALOG the relay route serves so
		//     refresh-models-dev.mjs and the coding-agent generators can
		//     fall back to the PEER when the vendored catalog is
		//     stale/absent (docs/d027-models-dev-relay-fallback).
		//   catwalk — Charm's curated model catalog
		//     (https://catwalk.charm.land/v2/providers, source
		//     charmbracelet/catwalk, verified live in docs/d028): the
		//     metadata tier any catalog-consuming client can ride through
		//     the peer when the endpoint is unreachable. A complement to
		//     models.dev (first-party/subscription providers are absent
		//     from it), never a replacement.
		["models.dev", "https://models.dev"],
		["catwalk", "https://catwalk.charm.land"],
	]),
};
const written = writeArtifact(out, `${JSON.stringify(cfg, null, 2)}\n`);
logInfo("wrote llm-reverse-proxy config", {
	path: written,
	providers: Object.keys(cfg.providers).length,
});

// Best-effort summary of what is deployed vs what the fact table knows.
const deployed = existsSync(out)
	? /** @type {{ providers: Record<string, string> }} */ (
			JSON.parse(readFileSync(out, "utf-8")).providers ?? {}
		)
	: {};
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
