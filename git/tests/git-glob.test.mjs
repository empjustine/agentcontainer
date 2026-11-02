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
 * The second subject here is `caseGlob`: the shell `case` pattern the
 * identity filters carry (`--only org/slug/repo`, the farm's repo glob), whose
 * `*` CROSSES `/`. Two matchers exist because those are two different
 * questions — a path glob and an identity glob — and collapsing them would
 * silently narrow `--only` (docs/d121).
 *
 * Run: node --test
 */
import assert from "node:assert/strict";
import test from "node:test";
import { caseGlob, filterByGlobs, globMatcher } from "../lib/git-core.mjs";

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

test("caseGlob lets `*` and `?` cross `/`, as the shell `case` it replaces", () => {
	assert.ok(caseGlob("acme/*/alpha")("acme/one/alpha"));
	assert.ok(caseGlob("*/*/beta")("acme/two/beta"));
	assert.ok(caseGlob("acme/?lain/gamma")("acme/plain/gamma"));
	// The path matcher must NOT match where the wildcard has to cross a `/` —
	// the point of keeping both is that they answer different questions.
	assert.equal(globMatcher("acme/*")("acme/one/alpha"), false);
	assert.ok(caseGlob("acme/*")("acme/one/alpha"));
});

test("caseGlob carries `[...]` classes and `[!...]` negation", () => {
	assert.ok(caseGlob("acme/[op]*/alpha")("acme/one/alpha"));
	assert.equal(caseGlob("acme/[op]*/alpha")("acme/two/alpha"), false);
	assert.ok(caseGlob("acme/[!o]ne/alpha")("acme/two/alpha") === false);
	assert.ok(caseGlob("acme/[!o]*/alpha")("acme/two/alpha"));
	// An unclosed bracket is a literal, and `[]` is not an empty class.
	assert.ok(caseGlob("a[]b")("a[]b"));
	assert.ok(caseGlob("a[b")("a[b"));
	// Metacharacters outside a class are literals.
	assert.ok(caseGlob("acme/one/a+b")("acme/one/a+b"));
	assert.equal(caseGlob("acme/one/a+b")("acme/one/aab"), false);
});
