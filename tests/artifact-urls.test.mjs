/**
 * @fileoverview artifact-urls.test.mjs — the static half of d070's
 * Verification triad: every COMMITTED artifact must carry fact-table
 * canonical upstream URLs (route form belongs to installed copies only),
 * and the installed-direction detector must actually catch a canonical URL
 * that escaped route substitution.
 *
 * Both directions go through check-routed-artifacts.mjs — the same module
 * run.sh guards launches with — so a detector regression fails here rather
 * than only on a real host at launch time (d070 §5).
 *
 * Run: node --test   (discovers tests/*.test.mjs from the repo root)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
	committedViolations,
	installedViolations,
	providerUrlsOf,
	rewriteProviderUrls,
} = await import("../coding-agent/check-routed-artifacts.mjs");
const { routeUrlFromCanonical } = await import("../coding-agent/route-probe.mjs");
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
		const violations = committedViolations(readDoc(file));
		assert.deepEqual(violations, [], violations.join("\n"));
	});
}

test("installed detector flags a canonical URL that escaped substitution", () => {
	const doc = {
		providers: {
			"llama-swap": { baseUrl: "https://bazzite.coelacanth-barb.ts.net/v1" },
			mistral: { baseUrl: "https://api.mistral.ai/v1" },
		},
	};
	const violations = installedViolations(doc);
	assert.equal(violations.length, 2, violations.join("\n"));
	assert.match(violations[0], /still carries canonical upstream/);
	assert.match(violations[1], /still carries canonical upstream/);
});

// The funnel mount here is the canonical synthetic one (docs/d086): a real
// mount is the mode A capability, so it never appears in tracked files —
// the lint gate enforces the all-zero fixture.
test("installed detector passes route-form URLs under the configured base", () => {
	const base = "https://bazzite.coelacanth-barb.ts.net/00000000-0000-4000-8000-000000000000";
	const doc = {
		providers: {
			"llama-swap": { baseUrl: `${base}/bazzite.coelacanth-barb.ts.net/v1` },
			mistral: { baseUrl: `${base}/api.mistral.ai/v1` },
		},
	};
	assert.deepEqual(installedViolations(doc, base), []);
});

test("installed detector rejects route-form URLs off the configured base", () => {
	const doc = {
		providers: { mistral: { baseUrl: "https://other.example/api.mistral.ai/v1" } },
	};
	const violations = installedViolations(doc, "https://proxy.example/bucket");
	assert.equal(violations.length, 1);
	assert.match(violations[0], /not under the configured base/);
});

test("committed detector rejects an id the fact table does not know", () => {
	const violations = committedViolations({
		providers: { "mystery-corp": { baseUrl: "https://mystery.example/v1" } },
	});
	assert.equal(violations.length, 1);
	assert.match(violations[0], /no fact-table upstream/);
});

test("committed detector rejects an upstream prefix that is not at a path boundary", () => {
	const upstream = CLOUD_PROVIDERS.mistral?.baseUrl;
	assert.ok(upstream, "mistral must stay a fact-table row");
	const violations = committedViolations({
		providers: { mistral: { baseUrl: `${upstream}-suffixed` } },
	});
	assert.equal(violations.length, 1);
	assert.match(violations[0], /path boundary/);
});

// The bazzite collision: the funnel base SHARES its host with the
// llama-swap fact row (d070 Consequences) — the installed detector must
// tell a routed URL from a canonical one without being told the base.
test("installed detector (no base) accepts routes on a base that shares a host with a fact row", () => {
	const bazziteBase =
		"https://bazzite.coelacanth-barb.ts.net/00000000-0000-4000-8000-000000000000";
	const doc = {
		providers: {
			"llama-swap": { baseUrl: `${bazziteBase}/bazzite.coelacanth-barb.ts.net/v1` },
			openrouter: { baseUrl: `${bazziteBase}/openrouter.ai/api/v1` },
		},
	};
	assert.deepEqual(installedViolations(doc), []);
});

test("installed detector (no base) still flags a canonical URL on a colliding host", () => {
	const violations = installedViolations({
		providers: {
			"llama-swap": { baseUrl: "https://bazzite.coelacanth-barb.ts.net/v1" },
		},
	});
	assert.equal(violations.length, 1);
	assert.match(violations[0], /still carries canonical upstream/);
});

test("routeUrlFromCanonical composes the d047 host-form route and fails closed", () => {
	const base =
		"https://bazzite.coelacanth-barb.ts.net/00000000-0000-4000-8000-000000000000";
	assert.equal(
		routeUrlFromCanonical(base, "llama-swap", "https://bazzite.coelacanth-barb.ts.net/v1"),
		`${base}/bazzite.coelacanth-barb.ts.net/v1`,
	);
	assert.equal(
		routeUrlFromCanonical(base, "openrouter", "https://openrouter.ai/api/v1"),
		`${base}/openrouter.ai/api/v1`,
	);
	// an already-routed URL (same host as the base!) must still throw
	assert.throws(
		() =>
			routeUrlFromCanonical(
				base,
				"llama-swap",
				`${base}/bazzite.coelacanth-barb.ts.net/v1`,
			),
		/already under the configured base/,
	);
	// a URL that is neither canonical nor under the base throws on the
	// upstream check
	assert.throws(
		() =>
			routeUrlFromCanonical(
				base,
				"mistral",
				"https://some.other.host/api.mistral.ai/v1",
			),
		/is not the fact-table upstream/,
	);
});

// Substitution and verification share ONE walker (rewriteProviderUrls +
// installedViolations), which is what lets generate.mjs own no copy of the
// rule: a canonical doc rewritten with routeUrlFromCanonical must satisfy the
// installed detector, in both artifact shapes.
test("rewriteProviderUrls routes a pi doc through the fact table", () => {
	const base = "https://proxy.example/bucket";
	/** @type {any} */
	const doc = {
		providers: {
			"llama-swap": { baseUrl: "https://bazzite.coelacanth-barb.ts.net/v1" },
			mistral: { baseUrl: CLOUD_PROVIDERS.mistral?.baseUrl },
			unroutable: { models: [] },
		},
	};
	rewriteProviderUrls(doc, (factId, url) => routeUrlFromCanonical(base, factId, url));
	assert.deepEqual(installedViolations(doc, base), []);
	assert.equal(
		doc.providers["llama-swap"].baseUrl,
		`${base}/bazzite.coelacanth-barb.ts.net/v1`,
	);
	assert.equal(doc.providers.unroutable.models.length, 0);
});

test("rewriteProviderUrls maps opencode's local to the llama-swap fact row", () => {
	const base = "https://proxy.example/bucket";
	/** @type {any} */
	const doc = {
		provider: {
			local: { options: { baseURL: "https://bazzite.coelacanth-barb.ts.net/v1" } },
			blocker: { models: {} },
		},
	};
	rewriteProviderUrls(doc, (factId, url) => routeUrlFromCanonical(base, factId, url));
	assert.equal(
		doc.provider.local.options.baseURL,
		`${base}/bazzite.coelacanth-barb.ts.net/v1`,
	);
	assert.deepEqual(installedViolations(doc, base), []);
});

test("providerUrlsOf reads both pi and opencode artifact shapes", () => {
	assert.deepEqual(providerUrlsOf({ providers: { a: { baseUrl: "u" } } }), [
		{ id: "a", url: "u" },
	]);
	assert.deepEqual(providerUrlsOf({ provider: { b: { options: { baseURL: "v" } } } }), [
		{ id: "b", url: "v" },
	]);
	assert.deepEqual(providerUrlsOf({}), []);
});
