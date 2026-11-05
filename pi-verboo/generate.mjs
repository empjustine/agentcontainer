/**
 * @fileoverview generate.mjs — the pi-verboo generator: ONE fetch of the
 * provider's own `/models` listing in, TWO committed artifacts out
 * (`models.json`, the pi `models.json`-shaped provider block, and
 * `models.js`, the extension's offline seed).
 *
 * One source and one fetch (the pi-synthetic verdict, docs/d096/d100):
 * models.dev carries no verboo row (catalogOptional, docs/d057), so the
 * listing was always the only lineup — a second catalog cannot exist here
 * even in principle. A failure THROWS, and the committed artifact is what a
 * host without network (or without `VERBOO_API_KEY`) falls back to.
 *
 * Every write here is atomic AND canonical (docs/d023/d050): content goes to
 * `<artifact>.tmp` and is renamed into place, so a failed or partial run
 * leaves the committed pair untouched, and the JSON manifest additionally
 * goes through the schema-aware ordering so a rerun over unchanged input is
 * byte-identical. There is no dry-run mode (docs/d058): the artifacts are
 * committed, so a rerun's own git diff is the review surface.
 *
 * The route machinery never existed here. This reads the fact-table row's
 * canonical upstream (docs/d070) directly; the environment's forward proxy
 * carries the request (`NODE_USE_ENV_PROXY=1` + the forwarded
 * `HTTP(S)_PROXY`, set by the repo-root npm-run.sh wrapper, docs/d074).
 *
 * Both consumers live in ONE pi package: this file writes `index.ts`'s
 * sibling artifacts, so there is no copy step, no `extension/` subfolder,
 * and nothing to keep in sync with `cmp`.
 *
 * Usage: ./npm-run.sh pi-verboo generate [--check]
 *   --check verifies the committed artifacts match a fresh generation and
 *   exits non-zero on drift (the CI-shaped form; without it the run writes).
 *   Both forms need VERBOO_API_KEY — the listing is auth-gated.
 *
 * Env: VERBOO_API_KEY (the listing bearer). Nothing
 * else — no relay base, no catalog path.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logError, logInfo, setLogTool } from "./log.mjs";
import { shapeListing, toExtensionModel, toPiModel } from "./merge.mjs";
import {
	fetchListing,
	VERBOO_API_KEY_ENV,
	VERBOO_BASE_URL,
	VERBOO_PROVIDER_ID,
} from "./sources.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

setLogTool("pi-verboo/generate");

/* ------------------------- artifact writer (d023/d050) ---------------------- */

/**
 * Atomically write `text` to `out`: `<out>.tmp` then rename, so a failed run
 * cannot clobber the live artifact and a successful one swaps it in as one
 * filesystem step. Returns the destination path.
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
 * @returns {value is Record<string, unknown>} arrays and null are shapes
 *   with their own ordering rules, never key-sort targets
 */
function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rebuild `obj` with keys in code-unit order. Copy — the input is never
 * mutated, so a builder can canonicalize at the write without its own
 * in-memory state shifting under it.
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
 * A provider's `models` collection is a set keyed by id — its order carries
 * no meaning in either shape a generator uses: pi manifests hold an array of
 * id-bearing records, opencode an id-keyed record map (docs/d050 rules).
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
 * artifact uses (array of id-bearing records, or id-keyed record map); the
 * entry's other fields keep their constructed order.
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
 * Canonical form of a generated manifest — the docs/d050 rules in code:
 *
 *   - `providers` / `provider` map keys: ascending code-unit order;
 *   - each entry's `models`: array sorted by `id`, or record map key-sorted;
 *   - everything else (record field order, modality/effort arrays, headers,
 *     scalar maps) is returned exactly as constructed.
 *
 * Deliberately NOT a recursive deep key-sort: model-record field order is a
 * human-readable schema (`id` first) and inner arrays like modalities are
 * semantically ordered — sorting them would be a readability regression and
 * a meaning change.
 *
 * A shallow-reordered copy: top-level containers are rebuilt, untouched
 * values are shared with `doc`. Input is never mutated.
 *
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
 * Canonical serialized manifest: sorted + pretty (2-space) + trailing
 * newline — the format decision of docs/d050; the one-line-per-model
 * variant was considered and discarded. Always valid JSON.
 * @param {unknown} value manifest to serialize
 * @returns {string} file bytes for the canonical form of `value`
 */
function serializeArtifact(value) {
	return `${JSON.stringify(canonicalizeManifest(value), null, 2)}\n`;
}

/**
 * JSON-manifest writer: canonical serialization (docs/d050) fused with the
 * atomic write (docs/d023) at the ONE choke point, so a builder cannot emit
 * order-churning bytes without deliberately bypassing both contracts.
 * @param {string} out destination path (writeArtifact contract)
 * @param {unknown} value manifest to serialize canonically
 * @returns {string} path actually written (writeArtifact contract)
 */
function writeJsonArtifact(out, value) {
	return writeArtifact(out, serializeArtifact(value));
}

/* ------------------------------- generation -------------------------------- */

/**
 * The provider block, exactly the fields the fleet's row for this provider
 * carries (coding-agent/model-018-cloud-verboo.json — this provider is NOT
 * pi-native, so the whole block is ours to supply, sources.mjs's row).
 * `api` is pinned because nothing else can supply the dialect;
 * `authHeader` is true because the gateway wants `Authorization: Bearer`
 * rather than an `x-api-key` header; `baseUrl` is the fact table's
 * CANONICAL upstream (docs/d070). No compat block of any level: a plain
 * OpenAI-compatible gateway where pi's defaults are correct as-is (the
 * inferx shape, docs/d032 F7).
 * @param {import("./merge.mjs").MergedModel[]} models
 * @returns {Record<string, unknown>}
 */
function providerBlock(models) {
	return {
		name: "Verboo",
		baseUrl: VERBOO_BASE_URL,
		api: "openai-completions",
		apiKey: `$${VERBOO_API_KEY_ENV}`,
		authHeader: true,
		models: models.map(toPiModel),
	};
}

/**
 * The extension's committed seed — an ESM module rather than JSON so a cold
 * start needs no filesystem access and no parse step. No alias export:
 * verboo publishes no rotating tier ids, so an alias map would be an
 * invented contract.
 * @param {import("./merge.mjs").MergedModel[]} models
 * @returns {string}
 */
function seedSource(models) {
	return `/**
 * GENERATED by pi-verboo/generate.mjs — do not edit.
 *
 * The catalog the extension registers when it cannot read the provider's
 * listing: the same shaping that produced pi-verboo/models.json, rendered with
 * the pi-ai model field names (mandatory zero cost block — the one
 * deliberate divergence, see merge.mjs). Regenerate with ./npm-run.sh pi-verboo
 * generate; the git diff is the
 * review.
 */

export const VERBOO_MODELS = ${JSON.stringify(
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
				{ providers: { [VERBOO_PROVIDER_ID]: providerBlock(models) } },
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
