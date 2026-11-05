/**
 * @fileoverview generate.mjs — the pi-cline-pass generator: TWO published
 * sources in (the models.dev `cline-pass` slice and Cline's published docs
 * table), TWO committed artifacts out (`models.json`, the pi
 * `models.json`-shaped cline-pass provider block, and `models.js`, the
 * extension's offline seed).
 *
 * Why two sources plus a reconciliation floor here, when pi-synthetic
 * deleted its multi-source ladder (docs/d096): they are not rungs of one
 * ladder. The docs table is the SUBSCRIPTION CONTRACT (which ids ClinePass
 * serves), models.dev is the METADATA (prices, limits, effort enums), and
 * neither can stand in for the other — and neither is this provider's own
 * /models listing, which serves a DIFFERENT provider's catalog entirely
 * (docs/d040; sources.mjs carries the full contract). The floor decides
 * when the two still describe the same lineup; below it the committed
 * fallback lineup wins and the run says so loudly.
 *
 * Failure contract: a failed catalog fetch THROWS — no metadata source
 * means nothing publishable, and the committed artifact (written
 * atomically, see the writer below) is the offline fallback a network-less
 * host reads. The docs table degrades to the committed lineup with a
 * warning instead: a missing markdown file says nothing about whether the
 * subscription still serves its models (sources.mjs).
 *
 * The lineup is reconciled at BOTH refresh points with the SAME contract —
 * this file and the extension's refreshModels share sources.mjs/merge.mjs
 * — and at neither does the provider's own /models listing appear: the
 * fleet's cline-pass row carries liveSync: false for exactly that reason
 * (docs/d040 item 2), and this folder keeps the boundary.
 *
 * Usage: from the repo root, `./npm-run.sh pi-cline-pass
 * generate [--check]` — package.json's scripts are the entrypoint table
 * (docs/d113).
 *   --check verifies the committed artifacts match a fresh generation and
 *   exits non-zero on drift (the CI-shaped form; without it the run writes).
 *
 * Env: CLINE_PASS_MDX (a plain local copy of Cline's
 * docs file — see sources.mjs). Network rides the environment's forward
 * proxy (NODE_USE_ENV_PROXY=1, docs/d074); no vault, no relay ladder.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logError, logInfo, setLogTool } from "./log.mjs";
import {
	CLINE_PASS_COMPAT,
	shapeCatalog,
	toExtensionModel,
	toPiModel,
} from "./merge.mjs";
import {
	CLINE_PASS_API_KEY_ENV,
	CLINE_PASS_BASE_URL,
	CLINE_PASS_NAME,
	fetchCatalogSlice,
	fetchDocsIds,
	resolveAllowlist,
} from "./sources.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

setLogTool("pi-cline-pass/generate");

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
 * The provider block, exactly the fields the fleet's full row for this
 * provider carries (coding-agent/model-015-cloud-cline-pass.json — this
 * provider is NOT pi-native, so the whole block is ours to supply, sources.mjs's
 * row). `api` is pinned because nothing else can supply
 * the dialect; `authHeader` is true because the gateway wants
 * `Authorization: Bearer` rather than an `x-api-key` header; `baseUrl` is
 * the fact table's CANONICAL upstream (docs/d070).
 *
 * `compat.supportsDeveloperRole` is the ONE published compat fact for this
 * gateway (docs/d022, docs/d033): ClinePass rejects the `developer` role
 * pi-ai emits for reasoning models. It rides provider-level here — where
 * the fleet row carries it — while the extension's registration carries
 * the same fact per model, because ProviderConfig has no provider-level
 * compat field (merge.mjs, verified against pi 1.4.0).
 * @param {import("./merge.mjs").MergedModel[]} models
 * @returns {Record<string, unknown>}
 */
function providerBlock(models) {
	return {
		name: CLINE_PASS_NAME,
		baseUrl: CLINE_PASS_BASE_URL,
		api: "openai-completions",
		apiKey: `$${CLINE_PASS_API_KEY_ENV}`,
		authHeader: true,
		compat: { ...CLINE_PASS_COMPAT },
		models: models.map(toPiModel),
	};
}

/**
 * The extension's committed seed — an ESM module rather than JSON so a cold
 * start needs no filesystem access and no parse step.
 *
 * Deliberately NO alias export: ClinePass publishes no rotating tier ids,
 * so an alias map would be an invented contract (merge.mjs). The lineup
 * inside is the last reconciled docs ∪ catalog union (docs/d040) — the
 * fallback both the extension and a broken-facts regeneration read.
 * @param {import("./merge.mjs").MergedModel[]} models
 * @returns {string}
 */
function seedSource(models) {
	return `/**
 * GENERATED by pi-cline-pass/generate.mjs — do not edit.
 *
 * The catalog the extension registers before any fresher store exists: the
 * same shaping that produced pi-cline-pass/models.json, rendered with the
 * pi-ai model field names (mandatory cost block, per-model compat — the
 * two projections differ there deliberately, see merge.mjs).
 * Regenerate with ./npm-run.sh pi-cline-pass generate from the
 * repo root; the git diff is the review.
 */

export const CLINE_PASS_MODELS = ${JSON.stringify(
		models.map(toExtensionModel),
		null,
		"\t",
	)};
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
				{ providers: { "cline-pass": providerBlock(models) } },
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
	// Order IS the failure contract: the catalog fetch throws (no metadata
	// source = nothing publishable), the docs fetch degrades inside
	// resolveAllowlist (unreadable table = committed lineup + a warning).
	const records = await fetchCatalogSlice();
	const allowlist = resolveAllowlist(await fetchDocsIds(), records);
	const models = shapeCatalog(records, allowlist);
	// Zero rows means the prefix guard or the eligibility gates swallowed the
	// whole lineup: writing that would silently replace a working provider
	// with an empty one, which is a failure to publish, not a result.
	if (models.length === 0) {
		throw new Error(
			"cline-pass lineup shaped to zero models — nothing to publish",
		);
	}
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
		artifacts: artifacts.size,
	});
}

main().catch((err) => {
	logError("generation failed — committed artifacts left untouched", {
		error: err,
	});
	process.exit(1);
});
