/**
 * @fileoverview git-glob.test.mjs — guards the --only/--exclude matcher's
 * separator contract (docs/d062). `path.relative()` spells separators `\`
 * on Windows while globs are documented in `/`, and a glob that silently
 * matches nothing is not cosmetic: an unmatched `--only` keeps the whole
 * fleet, an unmatched `--exclude` spares nothing — and
 * `migrate-to-bare.mjs --delete-originals` acts on that answer. The subjects
 * below are the exact strings Windows produces, built as literals so the guard
 * runs on any host.
 *
 * Run: node --test
 */
import assert from "node:assert/strict";
import test from "node:test";
import { filterByGlobs, globMatcher } from "../git/git-lib.mjs";

const WINDOWS_RELS = [
	"github.com\\owner\\repo.git",
	"codeberg.org\\q3k\\crowbar.git",
];

test("a '/' glob matches a Windows '\\' subject", () => {
	assert.ok(globMatcher("github.com/**")("github.com\\owner\\repo.git"));
	assert.ok(!globMatcher("github.com/**")("codeberg.org\\q3k\\crowbar.git"));
});

test("a glob argument spelled with '\\' compiles to the same matcher", () => {
	assert.ok(
		globMatcher("github.com\\owner\\repo.git")("github.com\\owner\\repo.git"),
	);
});

test("'*' stays inside a segment, '**' crosses it — on both spellings", () => {
	assert.ok(globMatcher("github.com/*")("github.com/owner"));
	assert.ok(!globMatcher("github.com/*")("github.com/owner/repo.git"));
	assert.ok(globMatcher("github.com/*")("github.com\\owner"));
	assert.ok(!globMatcher("github.com/*")("github.com\\owner\\repo.git"));
	assert.ok(globMatcher("github.com/**")("github.com/owner/repo.git"));
});

test("filterByGlobs keeps the ORIGINAL relative spelling of what it keeps", () => {
	// The caller matches the result back against its own relative() output
	// (same strings, same separators) — normalizing inside the predicate must
	// therefore never leak into the returned paths.
	assert.deepEqual(filterByGlobs(WINDOWS_RELS, ["github.com/**"], []), [
		"github.com\\owner\\repo.git",
	]);
	assert.deepEqual(filterByGlobs(WINDOWS_RELS, [], ["codeberg.org/**"]), [
		"github.com\\owner\\repo.git",
	]);
	assert.deepEqual(filterByGlobs(WINDOWS_RELS, ["no-such-host/**"], []), []);
});
