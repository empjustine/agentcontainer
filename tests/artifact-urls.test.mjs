/**
 * @fileoverview artifact-urls.test.mjs — the static half of d070's
 * Verification: every COMMITTED artifact must carry fact-table canonical
 * upstream URLs, and the detector must actually catch a URL that is not one
 * (the leftover route form of the deprecated reverse proxy, docs/d108).
 *
 * Everything goes through check-canonical-artifacts.mjs — the same module
 * run.sh guards launches with — so a detector regression fails here rather
 * than only on a real host at launch time (d070 Verification).
 *
 * Run: node --test   (discovers tests/*.test.mjs from the repo root)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
	canonicalViolations,
	providerUrlsOf,
} = await import("../coding-agent/check-canonical-artifacts.mjs");
const { CLOUD_PROVIDERS } = await import("../lib/cloud-providers.mjs");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readDoc = (/** @type {string} */ p) =>
	JSON.parse(readFileSync(join(repoRoot, "coding-agent", p), "utf-8"));

/** Every committed artifact that carries provider URLs (d070 §1). */
const COMMITTED = [
	"models.json",
	"model-010-local-default.json",
	"model-012-cloud-pi-native.json",
	"model-015-cloud-cline-pass.json",
	"model-016-cloud-hyper.json",
	"model-017-cloud-inferx.json",
	"model-018-cloud-verboo.json",
	"model-019-cloud-synthetic.json",
	"opencode.jsonc",
];

for (const file of COMMITTED) {
	test(`committed ${file} carries canonical upstreams only`, () => {
		const violations = canonicalViolations(readDoc(file));
		assert.deepEqual(violations, [], violations.join("\n"));
	});
}

test("detector rejects an id the fact table does not know", () => {
	const violations = canonicalViolations({
		providers: { "mystery-corp": { baseUrl: "https://mystery.example/v1" } },
	});
	assert.equal(violations.length, 1);
	assert.match(violations[0] ?? "no violation recorded", /no fact-table upstream/);
});

// The leftover this check exists for (docs/d108): a route-form URL from the
// deprecated reverse proxy is not a fact-table upstream, so it fails — that
// host config dir would point pi at a proxy this fleet no longer runs.
test("detector rejects the deprecated route form", () => {
	const base =
		"https://bazzite.coelacanth-barb.ts.net/00000000-0000-4000-8000-000000000000";
	const violations = canonicalViolations({
		providers: {
			"llama-swap": { baseUrl: `${base}/bazzite.coelacanth-barb.ts.net/v1` },
			mistral: { baseUrl: `${base}/api.mistral.ai/v1` },
		},
	});
	assert.equal(violations.length, 2, violations.join("\n"));
	// The route form's first segment is the destination host — the marker that
	// survives the funnel llama-swap collision (docs/d070 Consequences).
	assert.match(violations[0] ?? "no violation recorded", /fact-table host as a path segment/);
	assert.match(violations[1] ?? "no violation recorded", /not the fact-table upstream/);
});

test("detector rejects an upstream prefix that is not at a path boundary", () => {
	const upstream = CLOUD_PROVIDERS.mistral?.baseUrl;
	assert.ok(upstream, "mistral must stay a fact-table row");
	const violations = canonicalViolations({
		providers: { mistral: { baseUrl: `${upstream}-suffixed` } },
	});
	assert.equal(violations.length, 1);
	assert.match(violations[0] ?? "no violation recorded", /path boundary/);
});

test("detector accepts a client suffix past the upstream", () => {
	const upstream = CLOUD_PROVIDERS.mistral?.baseUrl;
	assert.ok(upstream, "mistral must stay a fact-table row");
	assert.deepEqual(
		canonicalViolations({ providers: { mistral: { baseUrl: `${upstream}/v1` } } }),
		[],
	);
});

test("detector maps opencode's local to the llama-swap fact row", () => {
	const upstream = CLOUD_PROVIDERS["llama-swap"]?.baseUrl;
	assert.ok(upstream, "llama-swap must stay a fact-table row");
	assert.deepEqual(
		canonicalViolations({
			provider: { local: { options: { baseURL: `${upstream}/v1` } } },
		}),
		[],
	);
	const violations = canonicalViolations({
		provider: { local: { options: { baseURL: "https://elsewhere.example/v1" } } },
	});
	assert.equal(violations.length, 1);
	assert.match(violations[0] ?? "no violation recorded", /not the fact-table upstream/);
});

test("providerUrlsOf reads both pi and opencode artifact shapes", () => {
	assert.deepEqual(providerUrlsOf({ providers: { a: { baseUrl: "u" } } }), [
		{ id: "a", url: "u" },
	]);
	assert.deepEqual(
		providerUrlsOf({ provider: { b: { options: { baseURL: "v" } } } }),
		[{ id: "b", url: "v" }],
	);
	assert.deepEqual(providerUrlsOf({}), []);
});
