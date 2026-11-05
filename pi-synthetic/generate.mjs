/**
 * @fileoverview generate.mjs — the pi-synthetic generator: ONE fetch of the
 * provider's own model listing in, TWO committed artifacts out
 * (`models.json`, the pi `models.json`-shaped provider block, and
 * `models.js`, the extension's offline seed).
 *
 * Why one source and one fetch (docs/d096): the three-source ladder this
 * replaced changed zero emitted values on a live comparison while carrying four
 * models the provider had already rotated away. A second catalog cannot make a
 * broken network work. So a failure here THROWS, and the committed artifact —
 * written atomically by the writer below — is what a host without network
 * falls back to. There is deliberately no lineup floor and no "keep the old file"
 * branch: docs/d021's stale-copy rule protected a stale SECOND SOURCE, and with
 * one source the honest signal for "the provider is unreachable" is a failed
 * run, not a silently stale regeneration.
 *
 * The route machinery is gone too. This reads the fact table's canonical
 * upstream (docs/d070) directly; the environment's forward proxy carries the
 * request (`NODE_USE_ENV_PROXY=1` + the forwarded `HTTP(S)_PROXY`,
 * docs/d074), which is the whole reason a client-side routing ladder was never
 * needed here.
 *
 * Both consumers live in ONE pi package: this file writes `index.ts`'s sibling
 * artifacts, so there is no copy step, no `extension/` subfolder, and nothing to
 * keep in sync with `cmp`.
 *
 * Usage: from the repo root, `./npm-run.sh pi-synthetic generate
 * [--check]` — package.json's scripts are the entrypoint table (docs/d113).
 *   --check verifies the committed artifacts match a fresh generation and
 *   exits non-zero on drift (the CI-shaped form; without it the run writes).
 *
 * Env: nothing — no relay base, no catalog path (docs/d113).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logError, logInfo, setLogTool } from "./log.mjs";
import {
	aliasMap,
	shapeListing,
	toExtensionModel,
	toPiModel,
} from "./merge.mjs";
import {
	fetchListing,
	SYNTHETIC_API_KEY_ENV,
	SYNTHETIC_BASE_URL,
	SYNTHETIC_PROVIDER_ID,
	warnOnMissingTiers,
} from "./sources.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

setLogTool("pi-synthetic/generate");

/* ---------------------------- artifact writer ----------------------------- */

/**
 * Atomic write (temp file + rename) — the one way an artifact reaches disk
 * here: a failed or partial run never clobbers the committed artifact, and a
 * successful one swaps the new bytes in as a single filesystem step. There is
 * no dry-run mode (docs/d058): the artifacts are committed, so a rerun's own
 * git diff is the review surface.
 *
 * Inlined rather than shared because this folder is a copy unit and is the
 * only consumer of the writer it ships (docs/d113).
 * @param {string} out destination path
 * @param {string} text full file content
 * @returns {string} the destination path
 */
function writeArtifact(out, text) {
	const tmp = `${out}.tmp`;
	writeFileSync(tmp, text, "utf-8");
	renameSync(tmp, out); // atomic on the same filesystem
	return out;
}

/**
 * Code-unit order, never `localeCompare`: canonical bytes must not depend on
 * the host locale.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>} arrays and null are shapes with
 *   their own ordering rules, never key-sort targets
 */
function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rebuild `obj` with keys in code-unit order. A copy: the input is never
 * mutated, so the caller's in-memory state cannot shift under it.
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function sortKeys(obj) {
	return Object.fromEntries(
		Object.keys(obj)
			.sort(byCodeUnit)
			.map((key) => [key, obj[key]]),
	);
}

/**
 * A provider's `models` collection is a set keyed by id — its order carries no
 * meaning, in either shape a generator uses (an array of id-bearing records,
 * or an id-keyed record map).
 * @param {unknown} models
 * @returns {unknown} same shape, order canonical; anything else untouched
 */
function sortModels(models) {
	if (Array.isArray(models)) {
		return [...models].sort((a, b) => {
			const idA = isPlainObject(a) && typeof a.id === "string" ? a.id : "";
			const idB = isPlainObject(b) && typeof b.id === "string" ? b.id : "";
			return byCodeUnit(idA, idB);
		});
	}
	if (isPlainObject(models)) {
		return sortKeys(models);
	}
	return models;
}

/**
 * A provider entry carries its model collection in whichever shape the
 * artifact uses; the entry's other fields keep their constructed order.
 * @param {unknown} entry provider or model record
 * @returns {unknown} the record with a canonical `models`, or as given
 */
function withCanonicalModels(entry) {
	if (!isPlainObject(entry) || !("models" in entry)) {
		return entry;
	}
	return { ...entry, models: sortModels(entry.models) };
}

/**
 * @param {Record<string, unknown>} map provider id -> provider entry
 * @returns {Record<string, unknown>} keys and each entry's `models` canonical
 */
function sortProviderMap(map) {
	return Object.fromEntries(
		Object.entries(sortKeys(map)).map(([id, entry]) => [
			id,
			withCanonicalModels(entry),
		]),
	);
}

/**
 * Canonical form of a generated manifest — docs/d050's ordering rules, and
 * deliberately NOT a recursive deep key-sort: model-record field order is a
 * human-readable schema (`id` first) and inner arrays like modalities are
 * semantically ordered, so reordering those would be a readability regression
 * and a meaning change. Only the dynamic maps and set-shaped collections are
 * reordered, which is what makes a rerun over unchanged inputs byte-identical.
 * @param {unknown} doc parsed/built manifest
 * @returns {unknown} canonically ordered equivalent of `doc`
 */
function canonicalizeManifest(doc) {
	if (!isPlainObject(doc)) {
		return doc;
	}
	const out = { ...doc };

	for (const mapKey of ["providers", "provider"]) {
		const map = out[mapKey];
		if (isPlainObject(map)) {
			out[mapKey] = sortProviderMap(map);
		}
	}

	return out;
}

/**
 * Canonical serialized manifest: sorted + pretty (2-space) + trailing newline
 * — docs/d050's format decision; the one-line-per-model variant was
 * considered and discarded. Always valid JSON.
 * @param {unknown} value manifest to serialize
 * @returns {string} file bytes for the canonical form of `value`
 */
function serializeArtifact(value) {
	return `${JSON.stringify(canonicalizeManifest(value), null, 2)}\n`;
}

/**
 * JSON-manifest writer: canonical serialization (docs/d050) fused with the
 * atomic write at the ONE choke point, so a builder cannot emit order-churning
 * bytes without deliberately bypassing both contracts.
 * @param {string} out destination path (writeArtifact contract)
 * @param {unknown} value manifest to serialize canonically
 * @returns {string} path actually written (writeArtifact contract)
 */
function writeJsonArtifact(out, value) {
	return writeArtifact(out, serializeArtifact(value));
}

/**
 * The provider block, exactly the fields the fleet's row for this provider
 * carries today (docs/d092: the inferx shape — a plain OpenAI-compatible
 * gateway). `api` is pinned because pi does not ship this provider natively,
 * so nothing else can supply the dialect; `authHeader` is true because the
 * endpoint wants `Authorization: Bearer` rather than an `x-api-key` header.
 *
 * `baseUrl` stays CANONICAL (docs/d070) — routing is a runtime concern, and a
 * committed route URL would both leak the capability that addresses the proxy
 * and rot when the proxy moves.
 * @param {import("./merge.mjs").MergedModel[]} models
 * @returns {Record<string, unknown>}
 */
function providerBlock(models) {
	return {
		name: "Synthetic",
		baseUrl: SYNTHETIC_BASE_URL,
		api: "openai-completions",
		apiKey: `$${SYNTHETIC_API_KEY_ENV}`,
		authHeader: true,
		models: models.map(toPiModel),
	};
}

/**
 * The extension's committed seed — an ESM module rather than JSON so a cold
 * start needs no filesystem access and no parse step.
 *
 * `SYNTHETIC_ALIASES` is emitted as a real field because the alias resolution
 * must never be recovered from a display name (a name is display text; a model
 * called "… (NVFP4)" would poison it). It is data the extension reads, and
 * nothing is stored on a model row that pi did not define.
 * @param {import("./merge.mjs").MergedModel[]} models
 * @returns {string}
 */
function seedSource(models) {
	const aliases = aliasMap(models);
	return `/**
 * GENERATED by pi-synthetic/generate.mjs — do not edit.
 *
 * The catalog the extension registers when it cannot read the provider's
 * listing: the same shaping that produced pi-synthetic/models.json, rendered
 * with the pi-ai model field names. Regenerate with ./npm-run.sh pi-synthetic
 * generate; the git diff is the
 * review.
 */

export const SYNTHETIC_MODELS = ${JSON.stringify(
		models.map(toExtensionModel),
		null,
		"\t",
	)};

export const SYNTHETIC_ALIASES = ${JSON.stringify(aliases, null, "\t")};
`;
}

/**
 * The serialized form of every artifact this generator owns, by path.
 * @param {import("./merge.mjs").MergedModel[]} models
 * @returns {Map<string, string>}
 */
function renderArtifacts(models) {
	return new Map([
		[
			join(scriptDir, "models.json"),
			// Canonical JSON (docs/d050): schema-aware ordering on top of the
			// atomic write, so a rerun over unchanged input is byte-identical.
			`${JSON.stringify(
				{ providers: { [SYNTHETIC_PROVIDER_ID]: providerBlock(models) } },
				null,
				"  ",
			)}\n`,
		],
		[join(scriptDir, "models.js"), seedSource(models)],
	]);
}

/**
 * Whether an existing artifact already holds exactly these bytes.
 * @param {string} path
 * @param {string} content
 * @returns {boolean}
 */
function alreadyCommitted(path, content) {
	return existsSync(path) && readFileSync(path, "utf-8") === content;
}

async function main() {
	const models = shapeListing(await fetchListing());
	warnOnMissingTiers(models.map((m) => m.id));
	const artifacts = renderArtifacts(models);

	if (process.argv.includes("--check")) {
		const drifted = [...artifacts]
			.filter(([path, content]) => !alreadyCommitted(path, content))
			.map(([path]) => path);
		if (drifted.length > 0) {
			logError("committed artifacts differ from a fresh generation", {
				drifted,
			});
			process.exit(1);
		}
		logInfo("committed artifacts are current", { artifacts: artifacts.size });
		return;
	}

	for (const [path, content] of artifacts) {
		// models.json goes through the canonical JSON writer; the seed is text.
		if (path.endsWith(".json")) {
			writeJsonArtifact(path, JSON.parse(content));
		} else {
			writeArtifact(path, content);
		}
	}
	logInfo("artifacts written", {
		models: models.length,
		aliases: Object.keys(aliasMap(models)).length,
		artifacts: artifacts.size,
	});
}

main().catch((err) => {
	logError("generation failed — committed artifacts left untouched", {
		error: err,
	});
	process.exit(1);
});
