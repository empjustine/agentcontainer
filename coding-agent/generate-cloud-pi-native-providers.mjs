/**
 * @fileoverview generate-cloud-pi-native-providers.mjs — Emit the pi overlay
 * `model-012-cloud-pi-native.json`: the pi-NATIVE cloud half of the layered
 * models.json (the layer contract — naming, order, merge semantics — lives in
 * merge-models-json.mjs), carrying an override for every pi-native cloud
 * provider whose default routing is NOT usable from this host.
 *
 * This is the cloud cascade of the former catch-all `generate-models.json.mjs`,
 * split out so each file has one merge semantic (docs/d022, applied in docs/d024):
 * pi ships openrouter / opencode / opencode-go natively, so this layer is an
 * OPTIONAL override ("swap only baseUrl / apiKey" — when nothing is emitted,
 * pi's built-in providers just work). The opposite semantic — providers pi does
 * NOT ship natively, where the layer is the ONLY source of the full definition —
 * lives in `generate-cloud-alternative-providers.mjs` (layer `model-015-...`),
 * and the local GGUF cascade in `generate-local-llama-swap.mjs` (layer
 * `model-010-...`). `generate-opencode.jsonc.mjs` is the opencode-format twin
 * of this file: same cascade, same pi-native trio, opencode's
 * provider schema.
 *
 * Detection cascade:
 *
 *   Cloud providers (`openrouter`, `opencode`, `opencode-go`, `mistral` — the
 *   shared fact table lib/cloud-providers.mjs, PI_NATIVE_CLOUD_IDS): probe each
 *   provider's DEFAULT /v1/models endpoint.  Reachable ⇒ pi's built-in
 *   provider handles it natively, nothing is emitted.  Unreachable ⇒ look for
 *   the models behind a llama-swap peer router ($PEER_BASE_URL, then the
 *   shared fallback FQDN — lib/peer-probe.mjs DEFAULT_PEER_FALLBACK); if
 *   found, emit a provider override so pi routes that provider through the
 *   peer instead.  The peer is probed lazily: no unreachable provider means
 *   no peer route is needed, so we never spend the request (or log its
 *   failures).
 *
 * "Reachable" is about the NETWORK PATH, not about credentials: a 401/403 is
 * what an OpenAI-compatible endpoint returns to any unauthenticated request,
 * and this generator legitimately runs without provider keys (pi resolves its
 * own key / OAuth login at request time). Such a response proves the endpoint
 * is reachable and says nothing about whether pi's built-in provider works, so
 * it must NOT trigger a peer override. Only the absence of ANY http response
 * (dns failure, connection refused, tls failure, timeout) is evidence that
 * this host cannot reach the endpoint. The canonical wording lives in
 * lib/peer-probe.mjs's header.
 *
 * Emitted layer, per provider:
 *
 * - ClinePass is intentionally NOT here: pi has no native `cline-pass`
 *   provider and needs its full definition at all times, so it is owned
 *   exclusively by generate-cloud-alternative-providers.mjs (layer
 *   `model-015-...`) — see the merge contract in merge-models-json.mjs.
 *
 * - `baseUrl` is a LITERAL url resolved at generation time (pi does not expand
 *   ${vars} in baseUrl) and is normalized to `/v1`; `apiKey` is the literal
 *   "$PEER_API_KEY", which pi resolves from the environment at request time.
 *   Both come from lib/pi-models.mjs providerReroute: the override is
 *   REROUTE-ONLY — it deliberately carries NO `api` and NO `compat`, because
 *   these are pi-native providers whose built-in definition knows the right
 *   dialect (opencode's per-model api map, mistral's mistral-conversations)
 *   while the public models.dev API does not. The override changes where
 *   requests go, never how they are encoded.
 * - Cloud-model attribution: through the peers-only router ids arrive fully
 *   qualified as `<peerId>/<modelId>` (`openrouter/org/model:free`); that peer
 *   prefix is authoritative when present, and bare ids fall back to the suffix
 *   heuristics in classifyCloud().
 * - If nothing usable is detected, nothing is written and any existing layer is
 *   left untouched.
 *
 * Usage: node generate-cloud-pi-native-providers.mjs [out]
 *   out defaults to $PI_MODELS_JSON else ./model-012-cloud-pi-native.json.
 *   Env: PEER_BASE_URL (first probe candidate), PEER_API_KEY (peer bearer),
 *   per-provider key envs (direct probes only; see lib/cloud-providers.mjs).
 *   Typical run, then merge — see merge-models-json.mjs:
 *     node generate-local-llama-swap.mjs         # -> model-010-local-default.json
 *     node generate-cloud-pi-native-providers.mjs # -> model-012-cloud-pi-native.json
 *     node merge-models-json.mjs                  # -> models.json
 */

import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Shared lib/ helpers (docs/d023): the structured logger, the HTTP probe
// toolkit, the provider fact table and the pi model shaping, resolved through
// the LIB_DIR convention (generate.sh stages them into the scratch dir and
// points LIB_DIR there; manual in-place runs fall back to the sibling ../lib).
const LIB_DIR = process.env.LIB_DIR ?? join(scriptDir, "..", "lib");
const { logInfo, logWarn, setLogTool } =
	/** @type {typeof import("../lib/log.mjs")} */ (
		await import(`${LIB_DIR}/log.mjs`)
	);
const { bearerHeaders, DEFAULT_PEER_FALLBACK, probeCandidates, probeDirect } =
	/** @type {typeof import("../lib/peer-probe.mjs")} */ (
		await import(`${LIB_DIR}/peer-probe.mjs`)
	);
const { CLOUD_PROVIDERS: CLOUD_PROVIDER_FACTS, PI_NATIVE_CLOUD_IDS } =
	/** @type {typeof import("../lib/cloud-providers.mjs")} */ (
		await import(`${LIB_DIR}/cloud-providers.mjs`)
	);
const { piModel, providerReroute } =
	/** @type {typeof import("../lib/pi-models.mjs")} */ (
		await import(`${LIB_DIR}/pi-models.mjs`)
	);
setLogTool("coding-agent/generate-cloud-pi-native");

/**
 * A cloud provider pi can reach natively; overridden only when its default
 * endpoint is unreachable. `matches` attributes a peer-catalog model id to
 * this provider.
 * @typedef {object} CloudProvider
 * @property {string} baseUrl
 * @property {string} apiKeyEnv
 * @property {(id: string) => boolean} matches
 */

// The pi-native set, from the shared fact table (docs/d024): facts live once
// in lib/, this file only picks the subset it owns.
/** @type {Record<string, CloudProvider>} */
const CLOUD_PROVIDERS = Object.fromEntries(
	PI_NATIVE_CLOUD_IDS.map((id) => {
		const facts = CLOUD_PROVIDER_FACTS[id];
		return [
			id,
			{
				baseUrl: facts.baseUrl,
				apiKeyEnv: facts.apiKeyEnv,
				matches: (/** @type {string} */ id2) => classifyCloud(id2) === id,
			},
		];
	}),
);

// Cloud providers are attributed by their llama-swap peer id when models are
// seen through the peers-only router (ids arrive fully qualified as
// "<peerId>/<modelId>"); bare ids fall back to the same suffix heuristics the
// peer generators use (":free" -> openrouter, mistral-family -> mistral,
// remainder -> opencode-go).  ClinePass
// is deliberately NOT attributed here: pi has no native cline-pass provider,
// so it is owned solely by the dedicated generate-cloud-alternative-providers
// layer (model-015).  See gen-lib.mjs PROVIDERS / d018 for the peer-cloud side.
const CLOUD_PEER_IDS = PI_NATIVE_CLOUD_IDS;

// Bare-id fallback for Mistral models seen without their "mistral/" peer
// prefix: Mistral ships several model families (mistral/devstral/codestral/
// ministral/pixtral/magistral/voxtral plus the open-mistral/open-mixtral
// archives and the labs- research previews).  Ids matching no family (e.g.
// partner models like zai-glm-5-2) fall through to the opencode-go branch —
// they still attribute correctly via their "mistral/" prefix.
const MISTRAL_BARE_RE =
	/^(?:labs-|open-)?(?:mistral|mixtral|devstral|codestral|ministral|pixtral|magistral|voxtral|mathstral)(?:[-_]|$)/;

/**
 * Attribute a peer-catalog model id to a cloud provider.
 * @param {string} id
 * @returns {string|undefined} undefined when the id belongs to neither
 *   concern (local GGUF, ...)
 */
function classifyCloud(id) {
	const slash = id.indexOf("/");
	const head = slash === -1 ? undefined : id.slice(0, slash);
	const prefixed = CLOUD_PEER_IDS.includes(head ?? "");
	const bare = prefixed ? id.slice(slash + 1) : id;
	const owner = prefixed ? /** @type {string} */ (head) : undefined;
	if (bare.endsWith(":free")) return owner ?? "openrouter";
	if (MISTRAL_BARE_RE.test(bare)) return owner ?? "mistral";
	if (!bare.includes("/") && !id.includes("-GGUF")) {
		return owner ?? "opencode-go";
	}
	return undefined;
}

/** @returns {Promise<void>} */
async function main() {
	const out =
		process.argv[2] ??
		process.env.PI_MODELS_JSON ??
		join(scriptDir, "model-012-cloud-pi-native.json");

	// Direct-first: probe each provider's DEFAULT endpoint; only if that fails
	// do we look for a llama-swap peer route (lazy — no peer probe, no 401
	// noise, when every direct endpoint is reachable).
	/** @type {[string, CloudProvider][]} */
	const needsPeer = [];
	for (const [id, p] of Object.entries(CLOUD_PROVIDERS)) {
		const { result, error } = await probeDirect(
			p.baseUrl,
			bearerHeaders(process.env[p.apiKeyEnv]?.trim()),
		);
		if (result !== "unreachable") {
			if (result === "auth") {
				// Not a routing problem: the endpoint answered and refused our
				// (absent) credentials — pi authenticates itself at request time.
				logInfo(
					"default endpoint reachable but credential-gated — keeping built-in routing",
					{ provider: id, error },
				);
			} else if (result === "reachable") {
				logWarn(
					"default endpoint reachable but answered unexpectedly — keeping built-in routing",
					{ provider: id, error },
				);
			}
			continue; // direct endpoint reachable — pi's built-in provider handles it
		}
		logInfo("default endpoint unreachable — will probe peer route", {
			provider: id,
			error,
		});
		needsPeer.push([id, p]);
	}

	/** @type {Record<string, import("../lib/pi-models.mjs").PiProvider>} */
	const providers = {};
	if (needsPeer.length > 0) {
		const peer = await probeCandidates(
			/** @type {string[]} */ (
				[
					process.env.PEER_BASE_URL?.replace(/\/+$/, ""),
					DEFAULT_PEER_FALLBACK,
				].filter(Boolean)
			),
			(ids) => ids.some((id) => classifyCloud(id) !== undefined),
		);
		if (!peer)
			logInfo("no cloud-peer route visible — keeping built-in cloud routing");
		for (const [id, p] of needsPeer) {
			if (!peer) continue;
			const models = peer.entries.filter((e) => p.matches(e.id)).map(piModel);
			if (models.length === 0) {
				logWarn("provider models not visible via peer — skipping", {
					provider: id,
					peerBaseUrl: peer.baseUrl,
				});
				continue;
			}
			providers[id] = providerReroute(peer.baseUrl, models);
		}
	}

	if (Object.keys(providers).length === 0) {
		logWarn("nothing usable detected — output left untouched", { out });
		return;
	}

	const tmp = `${out}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ providers }, null, 2)}\n`);
	renameSync(tmp, out); // atomic on the same filesystem
	const summary = Object.entries(providers)
		.map(([id, p]) => `${id}=${p.baseUrl}(${p.models.length})`)
		.join(", ");
	logInfo("wrote models layer", { path: out, providers: summary });
}

await main();
