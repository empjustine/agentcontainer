/**
 * @fileoverview generate-cline-pass.mjs — Emit the pi overlay
 * `model-015-cloud-cline-pass.json`: the ClinePass provider
 * (https://docs.cline.bot/getting-started/clinepass) as a single OpenAI-compatible Chat
 * Completions provider.
 *
 * Source of truth is the vendored models.dev catalog (models.dev.api.json).
 * ClinePass serves EVERY model over the same /api/v1 OpenAI-compatible endpoint
 * — confirmed by both reference extensions (jellydn/pi-clinepass-provider and
 * maxpaulus43/pi-cline), which each register one provider with
 * `api: "openai-completions"` and vary models only by capability + thinking
 * metadata. So a single provider block covers all models; there is no per-model
 * API divergence (unlike OpenCode Zen/Go, where upstreams keep native protocols).
 *
 * The block mirrors the provider/compat settings those extensions register:
 *   - api: "openai-completions"
 *   - baseUrl: provider.api            (https://api.cline.bot/api/v1)
 *   - apiKey: "$CLINE_API_KEY"         (auth presence gates /model availability)
 *   - authHeader: true                 (Authorization: Bearer)
 *   - compat.supportsDeveloperRole: false
 *       ClinePass rejects the `developer` role pi-ai emits for reasoning models;
 *       both reference extensions set this. Without it, reasoning models 400.
 *   - per-model thinkingLevelMap derived from models.dev reasoning_options
 *       (provider `reasoning_effort` enum values).
 *
 * Extension-only features that models.json cannot replicate (documented, not
 * emitted here — use pi install git:github.com/jellydn/pi-clinepass-provider
 * if you need them):
 *   - WorkOS device-code OAuth reuse (models.json `oauth` only supports "radius")
 *   - Cline prompt-cache `compat` + before_provider_request normalization
 *   - 403 subscription error surface via a message_end handler
 *
 * Usage: node generate-cline-pass.mjs [out]
 *   out defaults to ./model-015-cloud-cline-pass.json.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Structured logging (JSON lines on stderr; see lib/log.mjs).  The env
// override lets generate.sh point this at its scratch-dir copy.
const { logInfo, setLogTool } = await import(
	process.env.LOG_LIB ?? new URL("../lib/log.mjs", import.meta.url)
);
setLogTool("coding-agent/generate-cline-pass");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const OPENAI_COMPLETIONS_API = "openai-completions";
const PROVIDER_ID = "cline-pass";
const API_JSON = join(scriptDir, "models.dev.api.json");

// Map models.dev `reasoning_options` effort values onto pi thinking levels
// (off, minimal, low, medium, high, xhigh, max). ClinePass exposes enums like
// ["none","low","medium","high","xhigh"]; "none" disables thinking (pi "off"),
// the rest map 1:1. Levels absent from the provider enum are marked unsupported
// (null) so they are hidden in /model and pi never sends an out-of-enum value.
const EFFORT_TO_PI = {
	none: "off",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function buildThinkingLevelMap(reasoningOptions) {
	const values = new Set();
	for (const opt of reasoningOptions ?? []) {
		if (opt?.type === "effort" && Array.isArray(opt.values)) {
			for (const v of opt.values) values.add(String(v).toLowerCase());
		}
	}
	const map = {};
	for (const level of PI_LEVELS) {
		if (level === "minimal") {
			map.minimal = null; // no "minimal" in any ClinePass effort enum
			continue;
		}
		const effort = Object.keys(EFFORT_TO_PI).find(
			(e) => EFFORT_TO_PI[e] === level,
		);
		map[level] = effort && values.has(effort) ? effort : null;
	}
	return map;
}

// pi's input schema accepts only "text" and "image"; video/audio/... are dropped.
function toInput(modalitiesInput) {
	const set = new Set(modalitiesInput ?? ["text"]);
	const out = [];
	if (set.has("text")) out.push("text");
	if (set.has("image")) out.push("image");
	return out.length ? out : ["text"];
}

function toCost(cost) {
	if (!cost) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cache_read ?? 0,
		cacheWrite: cost.cache_write ?? 0,
	};
}

function main() {
	const catalog = JSON.parse(readFileSync(API_JSON, "utf-8"));
	const provider = catalog[PROVIDER_ID];
	if (!provider)
		throw new Error(`provider ${PROVIDER_ID} not found in ${API_JSON}`);

	const models = Object.values(provider.models ?? {}).map((m) => {
		const model = {
			id: m.id,
			name: m.name ?? m.id,
			reasoning: m.reasoning === true,
			input: toInput(m.modalities?.input),
			contextWindow: m.limit?.context ?? 128000,
			maxTokens: m.limit?.output ?? 16384,
			cost: toCost(m.cost),
		};
		if (model.reasoning) {
			model.thinkingLevelMap = buildThinkingLevelMap(m.reasoning_options);
		}
		return model;
	});

	const block = {
		providers: {
			[PROVIDER_ID]: {
				name: provider.name ?? "ClinePass",
				baseUrl: provider.api,
				api: OPENAI_COMPLETIONS_API,
				apiKey: "$CLINE_API_KEY",
				authHeader: true,
				compat: { supportsDeveloperRole: false },
				models,
			},
		},
	};

	const out =
		process.argv[2] ?? join(scriptDir, "model-015-cloud-cline-pass.json");
	const tmp = `${out}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(block, null, 2)}\n`);
	renameSync(tmp, out); // atomic on the same filesystem
	logInfo("wrote ClinePass models", { path: out, models: models.length });
}

main();
