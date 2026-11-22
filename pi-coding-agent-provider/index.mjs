/**
 * @fileoverview index.mjs — the ONE extension for pi-native providers:
 * mistral, opencode, opencode-go and openrouter (docs/d235).
 *
 * pi-coding-agent already ships each provider's catalog, wire dialect and
 * auth. An extension layer without `models` leaves that data untouched; a
 * returned list REPLACES it. So this entry adds nothing but the operator's
 * `*_BASE_URL` override, and only when the variable is set. A malformed URL
 * throws at load rather than silently retargeting traffic.
 *
 * opencode and opencode-go share one key env, so one `OPENCODE_BASE_URL`
 * overrides both, matching the generator's fact-table rows.
 */

/** @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI */
/** @typedef {import("@earendil-works/pi-coding-agent").ProviderConfig} ProviderConfig */

/** Provider id → the env var holding its real key. The override name is derived. */
const PROVIDER_KEY_ENVS = Object.freeze({
	mistral: "MISTRAL_API_KEY",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
});

/**
 * The override derived from a key env, or undefined when it is unset. The
 * spelling follows Azure's API-key/base-url pair (docs/d232), and an absolute
 * http(s) URL is the only accepted value.
 * @param {string} apiKeyEnv
 * @param {Record<string, string|undefined>} env
 * @returns {string|undefined}
 */
function baseUrlOverride(apiKeyEnv, env) {
	if (!apiKeyEnv.endsWith("_API_KEY")) {
		return;
	}
	const name = `${apiKeyEnv.slice(0, -"_API_KEY".length)}_BASE_URL`;
	const value = env[name]?.trim();
	if (!value) {
		return;
	}
	let protocol;
	try {
		protocol = new URL(value).protocol;
	} catch {
		protocol = "";
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`${name} is not an absolute http(s) URL: ${value}`);
	}
	return value.replace(/\/+$/, "");
}

/**
 * @param {ExtensionAPI} pi
 * @returns {void}
 */
export default function piCodingAgentProvider(pi) {
	for (const [id, apiKeyEnv] of Object.entries(PROVIDER_KEY_ENVS)) {
		const baseUrl = baseUrlOverride(apiKeyEnv, process.env);
		/** @type {ProviderConfig} */
		const config = baseUrl === undefined ? {} : { baseUrl };
		pi.registerProvider(id, config);
	}
}
