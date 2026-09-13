/**
 * @fileoverview generate-default-model.mjs — Emit a settings.json overlay
 * with dynamic defaultProvider/defaultModel based on provider reachability.
 *
 * A provider counts as usable when the merged models.json carries its layer
 * (the cascade emitted a real or peer route for it). We prioritize:
 *   - opencode-go/deepseek-v4.1-flash (falling back to deepseek-v4-flash when
 *     the emitted layer carries only the older id)
 *   - cline-pass/glm-5.3-flash
 *   - otherwise no default: openrouter only serves free reasoning models,
 *     which is not a sensible default for a coding agent.
 *
 * Usage: node generate-default-model.mjs [out]
 *   out defaults to $PI_DEFAULT_MODEL_JSON else ./default-model.json. Reads
 *   models.json from this script's own directory — generate.sh stages the
 *   generated layer there, after the models.json stage (see generate.sh).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	logInfo,
	logWarn,
	scriptDir,
	setLogTool,
	writeArtifact,
} from "./gen-lib.mjs";

setLogTool("coding-agent/generate-default-model");

/**
 * The merged models.json the generators produce. A provider is present only
 * when the cascade emitted a layer for it (real route or peer reroute), so
 * presence doubles as the usability signal this selector reads.
 * @typedef {object} GeneratedModelsJson
 * @property {Record<string, { models?: Array<{ id: string }> }>} [providers]
 */

/**
 * Load the models.json to check which providers are available.
 * @returns {GeneratedModelsJson} the parsed models.json
 */
function loadModelsJson() {
	const modelsJsonPath = join(scriptDir, "models.json");
	try {
		return /** @type {GeneratedModelsJson} */ (
			JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		);
	} catch (err) {
		logWarn("models.json unavailable — no default model configuration", {
			error: /** @type {Error} */ (err).message,
		});
		return { providers: {} };
	}
}

/**
 * Select the default provider and model based on provider reachability.
 * @param {GeneratedModelsJson} modelsJson the parsed models.json
 * @returns {{ defaultProvider?: string, defaultModel?: string }} the default configuration
 */
function selectDefaultModel(modelsJson) {
	const providers = modelsJson.providers ?? {};
	const providerIds = Object.keys(providers);

	// Priority order: opencode-go, cline-pass
	// These are the providers with the most capable free models.
	// If only openrouter is available (free reasoning only), don't set a default
	// - the user can always explicitly select a model when needed.

	// Check opencode-go first. V4.1 is the target; the emitted layer can carry
	// either id depending on whether the live /models listing or the catalog
	// supplied it, so accept both (V4.1 wins).
	if (providerIds.includes("opencode-go")) {
		const opencodeGoModels = providers["opencode-go"].models ?? [];
		const deepseekV4 =
			opencodeGoModels.find((m) => m.id === "deepseek-v4.1-flash") ??
			opencodeGoModels.find((m) => m.id === "deepseek-v4-flash");
		if (deepseekV4) {
			logInfo("default model selected", {
				provider: "opencode-go",
				model: deepseekV4.id,
				reason: "most capable free model when opencode-go is usable",
			});
			return {
				defaultProvider: "opencode-go",
				defaultModel: deepseekV4.id,
			};
		}
		logInfo("opencode-go usable but no deepseek-v4.1-flash found", {
			availableModels: opencodeGoModels.map((m) => m.id),
		});
	}

	// Check cline-pass (has glm-5.3-flash). Its layer keeps the provider prefix
	// on every id (generate-cloud-alternative-providers.mjs), so match both
	// spellings and return the id the layer actually carries.
	if (providerIds.includes("cline-pass")) {
		const clinePassModels = providers["cline-pass"].models ?? [];
		const glm5Flash = clinePassModels.find(
			(m) => m.id === "cline-pass/glm-5.3-flash" || m.id === "glm-5.3-flash",
		);
		if (glm5Flash) {
			logInfo("default model selected", {
				provider: "cline-pass",
				model: glm5Flash.id,
				reason: "capable GLM model when cline-pass is usable",
			});
			return {
				defaultProvider: "cline-pass",
				defaultModel: glm5Flash.id,
			};
		}
		logInfo("cline-pass usable but glm-5.3-flash not found", {
			availableModels: clinePassModels.map((m) => m.id),
		});
	}

	logInfo(
		"no suitable default model found - openrouter only provides free reasoning models which is insufficient for a sensible default",
	);
	return {};
}

/** @returns {void} */
function main() {
	const modelsJson = loadModelsJson();
	const defaultConfig = selectDefaultModel(modelsJson);

	// Emit a settings.json overlay with default provider/model if set
	const outPath =
		process.argv[2] ??
		process.env.PI_DEFAULT_MODEL_JSON ??
		join(scriptDir, "default-model.json");

	if (defaultConfig.defaultProvider && defaultConfig.defaultModel) {
		const overlay = {
			defaultProvider: defaultConfig.defaultProvider,
			defaultModel: defaultConfig.defaultModel,
		};
		const written = writeArtifact(
			outPath,
			`${JSON.stringify(overlay, null, 2)}\n`,
		);
		logInfo("default model configuration written", { path: written });
	} else {
		// Write empty object if no default can be determined
		const written = writeArtifact(
			outPath,
			`${JSON.stringify({}, null, 2)}\n`,
		);
		logInfo("no default model configuration - empty overlay written", {
			path: written,
		});
	}
}

main();
