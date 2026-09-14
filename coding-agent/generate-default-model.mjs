/**
 * @fileoverview generate-default-model.mjs — Return the operator's hardcoded
 * defaultProvider/defaultModel, as is, from the settings source. The default
 * model is an OPERATOR DECISION, not a probed fact (docs/d036): the dynamic
 * models.json-probing picker this generator once hosted selected
 * unreachable-at-request-time providers and let pi fall back to its broken
 * built-in default. The hardcoded pair lives in `coding-agent/settings.json`
 * (the same file generate.sh installs and run.sh stages as the fallback),
 * and this generator re-emits it so the merge stage in generate.sh stays
 * idempotent and can no longer fail to find a default.
 *
 * To change the default: edit coding-agent/settings.json, then re-run
 * generation. There is no fallback heuristic — if the settings source does
 * not carry a pair, the generator says so and emits an empty overlay.
 *
 * Usage: node generate-default-model.mjs [out]
 *   out defaults to $PI_DEFAULT_MODEL_JSON else ./default-model.json.
 *   Settings source: $PI_SETTINGS (set by generate.sh) else
 *   ./settings.json next to this script.
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
 * The settings source whose defaultProvider/defaultModel this generator
 * returns. generate.sh points $PI_SETTINGS at the file it installs (the
 * agent dir's settings.json after the settings-install stage); manual runs
 * read the repo's committed copy.
 * @returns {string}
 */
function settingsPath() {
	return process.env.PI_SETTINGS ?? join(scriptDir, "settings.json");
}

/**
 * @typedef {object} SettingsSource
 * @property {string} [defaultProvider]
 * @property {string} [defaultModel]
 */

/** @returns {void} */
function main() {
	let settings = /** @type {SettingsSource} */ ({});
	try {
		settings = /** @type {SettingsSource} */ (
			JSON.parse(readFileSync(settingsPath(), "utf-8"))
		);
	} catch (err) {
		logWarn("settings source unreadable — no default model configuration", {
			path: settingsPath(),
			error: /** @type {Error} */ (err).message,
		});
	}

	const overlay = {};
	if (settings.defaultProvider)
		overlay.defaultProvider = settings.defaultProvider;
	if (settings.defaultModel) overlay.defaultModel = settings.defaultModel;

	const outPath =
		process.argv[2] ??
		process.env.PI_DEFAULT_MODEL_JSON ??
		join(scriptDir, "default-model.json");

	if (overlay.defaultProvider && overlay.defaultModel) {
		logInfo("default model: operator-hardcoded pair returned as is", {
			provider: overlay.defaultProvider,
			model: overlay.defaultModel,
			from: settingsPath(),
		});
	} else {
		logWarn(
			"settings source carries no defaultProvider/defaultModel — empty overlay written (pi's own default will apply)",
			{ path: settingsPath() },
		);
	}
	const written = writeArtifact(
		outPath,
		`${JSON.stringify(overlay, null, 2)}\n`,
	);
	logInfo("default model configuration written", { path: written });
}

main();
