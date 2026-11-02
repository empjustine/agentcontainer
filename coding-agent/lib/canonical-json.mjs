/**
 * @fileoverview canonical-json.mjs — schema-aware canonicalization of
 * generated manifests (docs/d050) and of the vendored fact tables
 * (docs/d086). Serialization half only: the atomic-write contract (and
 * `writeJsonArtifact`, which combines the two) lives in lib/artifact.mjs, the
 * write choke point. The d086 hash short-circuit that consumes these forms is
 * lib/fact-table.mjs.
 *
 * Why this exists: generators are the source of truth (docs/d023), but a
 * rerun over unchanged inputs used to emit different *bytes* because key and
 * array order followed assembly order (parallel `Promise.allSettled`
 * completion for model-012, upstream list order everywhere else). Ordering
 * churn buried real changes in diffs and broke "regenerate and compare" as a
 * drift detector (docs/d050).
 *
 * Deliberately NOT a recursive deep key-sort: model-record field order is a
 * human-readable schema (`id` first) and inner arrays like modalities are
 * semantically ordered — sorting them would be a readability regression and
 * a meaning change (docs/d050 §3). Only the dynamic maps and set-shaped
 * collections named below are reordered.
 *
 * The same rule covers both artifact classes because the question is the same
 * one — "is this collection a set?" — and answering it twice would let the
 * two answers drift: a manifest's `providers` map and the raw catalog's own
 * top-level map are the same set in two wrappings (docs/d086).
 */

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
 * A shallow-reordered copy: top-level containers are rebuilt, untouched
 * values are shared with `doc`. Input is never mutated.
 *
 * @param {unknown} doc parsed/built manifest
 * @returns {unknown} canonically ordered equivalent of `doc`
 */
export function canonicalizeManifest(doc) {
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
 * Canonical form of a provider CATALOG — the raw vendor shape where the
 * document itself *is* the provider map (`lib/models.dev.api.json`): its keys
 * ascend and each provider's `models` collection is canonical.
 *
 * The distinction from canonicalizeManifest matters: that one looks for a
 * `providers` map inside a generated document, while upstream sends no such
 * wrapper and no wrapper may be added — consumers index the document by
 * provider id, so the top level has to stay the provider namespace
 * (docs/d086).
 *
 * @param {unknown} catalog parsed upstream catalog
 * @returns {unknown} canonically ordered equivalent of `catalog`
 */
export function canonicalizeProviderCatalog(catalog) {
	return isPlainObject(catalog) ? sortProviderMap(catalog) : catalog;
}

/**
 * Canonical form of a fact-cache document (docs/d086): the record list under
 * `listKey` sorted by id and each record's own `models` collection canonical,
 * with every other member — the `_meta` block, `fetchedAt`, provider-specific
 * fields — exactly as given.
 *
 * Order-insensitivity is the whole point: the same facts arriving in a
 * different upstream order must produce the same bytes, because "did the
 * content move?" is the question the writer answers before it touches the
 * file (lib/fact-table.mjs).
 *
 * @param {unknown} doc parsed fact-cache document
 * @param {string} listKey member holding the record list (`providers`, `models`)
 * @returns {unknown} canonically ordered equivalent of `doc`
 */
export function canonicalizeFactsCache(doc, listKey) {
	if (!isPlainObject(doc) || !Array.isArray(doc[listKey])) {
		return doc;
	}
	const records = /** @type {unknown[]} */ (doc[listKey]).map(
		withCanonicalModels,
	);
	return { ...doc, [listKey]: sortModels(records) };
}

/**
 * Canonical serialized manifest: sorted + pretty (2-space) + trailing
 * newline — the format decision of docs/d050; the one-line-per-model
 * variant was considered and discarded. Always valid JSON.
 *
 * @param {unknown} value manifest to serialize
 * @returns {string} file bytes for the canonical form of `value`
 */
export function serializeArtifact(value) {
	return `${JSON.stringify(canonicalizeManifest(value), null, 2)}\n`;
}
