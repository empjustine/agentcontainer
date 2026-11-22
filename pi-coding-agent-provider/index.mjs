/**
 * @fileoverview index.mjs — the ONE extension for pi-native providers:
 * mistral, opencode, opencode-go and openrouter (docs/d235).
 *
 * pi-coding-agent already ships each provider's catalog, wire dialect and
 * auth. An extension layer without `models` leaves that data untouched; a
 * returned list REPLACES it. So this entry adds nothing but the operator's
 * base-URL override, and only when the variable is set. A malformed URL throws
 * at load, but as a UI error notification rather than a thrown exception: one
 * bad override must not stop the other providers from registering.
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
	 * @returns {ProviderConfig|Error|undefined}
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
			return new Error(`base URL is not an absolute http(s) URL: ${override}`);
		}
		return { baseUrl: override.replace(/\/+$/, "") };
	};

	/** @type {Error[]} */
	const errors = [];
	for (const [provider, apiKey, baseUrl] of PROVIDERS) {
		if (!(apiKey in process.env)) {
			continue;
		}
		const result = configBaseUrlFromEnv(process.env[baseUrl]);
		if (result instanceof Error) {
			errors.push(new Error(`${provider}: ${result.message}`));
		} else if (result) {
			pi.registerProvider(provider, result);
		}
	}
	if (errors.length > 0) {
		const problem = new AggregateError(
			errors,
		`invalid provider base-URL overrides: ${errors.map((error) => error.message).join("; ")}`,
		);
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(problem.message, "error");
		});
	}
}
