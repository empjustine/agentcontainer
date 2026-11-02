/**
 * @fileoverview fact-table.mjs — the docs/d086 churn recipe for the vendored
 * LLM fact tables: canonical serialization, hash short-circuit, and a stable
 * `_meta` provenance block. One home so the writers cannot drift apart.
 *
 * WHY the short-circuit is the point: a refresh that found the same upstream
 * facts used to rewrite the file anyway, and `fetchedAt` moved every time, so
 * a routine regen produced a diff in every cache with nothing in it to review
 * — and it buried the refactors and policy probes that ran beside it (the
 * measured churn anatomy is in docs/d086). Unchanged facts now produce no
 * write at all, not a smaller one.
 *
 * WHAT `fetchedAt` therefore means: when the CONTENT last moved, never when
 * the last fetch happened (docs/d086). A cache that has been checking daily
 * against a stable upstream for a month honestly reports a month-old
 * `fetchedAt` — that is the freshness signal d053/d021's stale-tolerant
 * consumers want — while the refresh log is where "checked, unchanged" is
 * recorded. A shape migration (a file written before `_meta` existed) is not
 * a content move: it preserves the timestamp it found.
 *
 * WHAT must never enter `_meta`: a URL (docs/d086/d070 — the funnel mount is
 * the mode A credential, and a committed file is the last place it can leak
 * from), or a per-run timestamp (it would restore the churn this module
 * deletes). `source` is a source ID, `regen` the exact command that rewrites
 * the file, `decision` the record that owns the shape.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { writeArtifact } from "./artifact.mjs";
import {
	canonicalizeFactsCache,
	canonicalizeProviderCatalog,
	serializeArtifact,
} from "./canonical-json.mjs";

/** `_meta.schema` of every cache `publishFactCache` writes. */
const FACT_CACHE_SCHEMA = "fact-cache/1";

/** The record that owns the cache shape and this recipe. */
const FACT_CACHE_DECISION = "docs/d086";

/**
 * The raw catalog mirror keeps its tab indentation while generated manifests
 * use the docs/d050 2-space form: it is 8.4 MB of vendored upstream JSON and
 * tabs are ~18% smaller on disk. Only its ORDER is contractual, so the
 * serializer difference cannot affect a consumer or a diff.
 */
const MIRROR_INDENT = "\t";

/**
 * @typedef {object} FactCacheProvenance
 * @property {string} source source ID recorded in `_meta` (never a URL)
 * @property {string} generator repo-relative script that writes the file
 * @property {string} regen exact command that reproduces the file
 * @property {string} listKey member holding the record list (`providers`, `models`)
 * @property {unknown[]} records the facts to publish
 */

/**
 * @param {string} text
 * @returns {string} lowercase hex sha256 — the identity a cache stores and
 *   compares, so "did the content move?" never depends on arrival order
 */
function sha256Hex(text) {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * @param {string} path
 * @returns {string | null} file content, or null when it does not exist yet
 */
function readTextOrNull(path) {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

/**
 * @param {string} path
 * @returns {{text: string, doc: Record<string, unknown>} | null} parsed
 *   document, or null when the file is missing or not a JSON object (a
 *   corrupt cache is simply not a source of truth — the caller rewrites it)
 */
function readJsonOrNull(path) {
	const text = readTextOrNull(path);
	if (text === null) {
		return null;
	}
	try {
		const doc = JSON.parse(text);
		if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
			return { text, doc: /** @type {Record<string, unknown>} */ (doc) };
		}
	} catch {
		// fall through: unparseable cache == absent cache
	}
	return null;
}

/**
 * Canonical facts text of a document's record list, ignoring everything else
 * (`_meta`, `fetchedAt`, provider-specific members). This is what the hash is
 * taken over, on both sides of the comparison.
 * @param {Record<string, unknown>} doc
 * @param {string} listKey
 * @returns {string}
 */
function canonicalRecordsText(doc, listKey) {
	const facts = canonicalizeFactsCache({ [listKey]: doc[listKey] }, listKey);
	return serializeArtifact(facts);
}

/**
 * The `fetchedAt` a stored cache carries, if it is usable.
 * @param {{text: string, doc: Record<string, unknown>} | null} existing
 * @returns {string | null}
 */
function storedFetchedAt(existing) {
	const value = existing?.doc.fetchedAt;
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Publish a wrapped fact cache (`_meta`, `fetchedAt`, and the record list).
 *
 * Rewrites the file only when the canonical bytes would change; the atomic
 * substitution itself is lib/artifact.mjs's contract. Returns the decision so
 * the caller can log `refreshed` vs `unchanged — not rewritten` honestly.
 *
 * @param {string} path destination cache path
 * @param {FactCacheProvenance} provenance source, list member, records
 * @returns {{changed: boolean, written: boolean, fetchedAt: string, contentSha256: string}}
 *   `changed` = the facts moved (so `fetchedAt` advanced), `written` = the
 *   bytes on disk were replaced (also true for a shape-only migration)
 */
export function publishFactCache(path, provenance) {
	const { source, generator, regen, listKey, records } = provenance;
	const facts = canonicalizeFactsCache({ [listKey]: records }, listKey);
	const contentText = serializeArtifact(facts);
	const contentSha256 = sha256Hex(contentText);

	const existing = readJsonOrNull(path);
	const previousFetchedAt = storedFetchedAt(existing);
	const changed =
		existing === null ||
		sha256Hex(canonicalRecordsText(existing.doc, listKey)) !== contentSha256;
	const fetchedAt =
		changed || previousFetchedAt === null
			? new Date().toISOString()
			: previousFetchedAt;

	const document = serializeArtifact({
		_meta: {
			schema: FACT_CACHE_SCHEMA,
			source,
			contentSha256,
			generator,
			regen,
			decision: FACT_CACHE_DECISION,
		},
		fetchedAt,
		.../** @type {Record<string, unknown>} */ (facts),
	});

	if (existing !== null && existing.text === document) {
		return { changed, written: false, fetchedAt, contentSha256 };
	}
	writeArtifact(path, document);
	return { changed, written: true, fetchedAt, contentSha256 };
}

/**
 * Publish the raw provider catalog mirror (`lib/models.dev.api.json`) — the
 * document that *is* the provider map, indexed by provider id.
 *
 * No `_meta` block here on purpose (docs/d086): the top level is the provider
 * namespace every consumer walks, so a provenance member would sit in it as a
 * provider and stop the file being a faithful mirror of upstream `api.json`.
 * Its provenance is the `contentSha256` in the refresh log until the mirror
 * leaves git (the deferred half of d086's recipe).
 *
 * @param {string} path destination mirror path
 * @param {unknown} catalog parsed upstream catalog
 * @returns {{written: boolean, contentSha256: string}} `written` = the bytes
 *   on disk were replaced; false means the mirror already held these facts
 */
export function publishProviderMirror(path, catalog) {
	const text = `${JSON.stringify(canonicalizeProviderCatalog(catalog), null, MIRROR_INDENT)}\n`;
	const contentSha256 = sha256Hex(text);
	if (readTextOrNull(path) === text) {
		return { written: false, contentSha256 };
	}
	writeArtifact(path, text);
	return { written: true, contentSha256 };
}
