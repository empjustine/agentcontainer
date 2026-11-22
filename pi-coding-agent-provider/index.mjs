/**
 * @fileoverview index.mjs — the ONE extension for pi-native providers:
 * mistral, opencode, opencode-go and openrouter (docs/d235).
 *
 * pi-coding-agent already ships each provider's catalog, wire dialect and
 * auth. An extension layer without `models` leaves that data untouched; a
 * returned list REPLACES it. So this entry adds nothing but the operator's
 * base-URL override, and only when the variable is set. A malformed URL throws
 * at load rather than silently retargeting traffic.
 *
 * The rows and the lookup live inside the default export: each load reads the
 * environment as it stands then, so a reload after an env change takes effect
 * without a fresh process.
 */

/** @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI */
/** @typedef {import("@earendil-works/pi-coding-agent").ProviderConfig} ProviderConfig */

/**
 * One row is [provider, apiKey, baseUrl], named after pi's own interface:
 * `provider` is the id passed to `registerProvider`; `apiKey` and `baseUrl`
 * are the env vars behind the `ProviderConfig` fields of those names. The
 * names are baked here — nothing derives one from another at run time.
 * @typedef {readonly [string, string, string]} ProviderEnv
 */

/**
 * @param {ExtensionAPI} pi
 * @returns {void}
 */
export default function piCodingAgentProvider(pi) {
	/** @type {readonly ProviderEnv[]} */
	const PROVIDERS = Object.freeze([
		["mistral", "MISTRAL_API_KEY", "MISTRAL_BASE_URL"],
		["opencode", "OPENCODE_API_KEY", "OPENCODE_BASE_URL"],
		["opencode-go", "OPENCODE_API_KEY", "OPENCODE_BASE_URL"],
		["openrouter", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"],
	]);

	/**
	 * The config for an env value, or undefined when it is unset. An absolute
	 * http(s) URL is the only accepted value; trailing slashes are trimmed so
	 * the override is one canonical spelling.
	 * @param {string|undefined} value the override's value in the environment
	 * @returns {ProviderConfig|undefined}
	 */
	const configBaseUrlFromEnv = (value) => {
		const override = value?.trim();
		if (!override) {
			return;
		}
		let protocol;
		try {
			protocol = new URL(override).protocol;
		} catch {
			protocol = "";
		}
		if (protocol !== "http:" && protocol !== "https:") {
			throw new Error(`base URL is not an absolute http(s) URL: ${override}`);
		}
		return { baseUrl: override.replace(/\/+$/, "") };
	};

	for (const [provider, apiKey, baseUrl] of PROVIDERS) {
		if (!(apiKey in process.env)) {
			continue;
		}
		const config = configBaseUrlFromEnv(process.env[baseUrl]);
		if (config) {
			pi.registerProvider(provider, config);
		}
	}
}
