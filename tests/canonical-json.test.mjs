/**
 * @fileoverview canonical-json.test.mjs — unit + canonicity guard for the
 * docs/d050 canonicalization (lib/canonical-json.mjs).
 *
 * Run: node --test   (discovers tests/*.test.mjs from the repo root)
 *
 * The committed-manifest guard is the drift detector d050 asks for: any
 * generator write path that bypasses writeJsonArtifact (or a hand edit)
 * re-introduces order churn, and this test names the exact file that went
 * non-canonical instead of letting it hide until the next diff review.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalizeManifest, serializeArtifact } from "../lib/canonical-json.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("providers map keys sort ascending in code-unit order, input untouched", () => {
	const doc = { providers: { openrouter: {}, Google: {}, mistral: {}, alpha: {} } };
	const out = canonicalizeManifest(doc);
	assert.deepEqual(Object.keys(/** @type {any} */ (out).providers), [
		"Google",
		"alpha",
		"mistral",
		"openrouter",
	]);
	// source key order unchanged — canonicalization never mutates the builder's doc
	assert.deepEqual(Object.keys(doc.providers), ["openrouter", "Google", "mistral", "alpha"]);
});

test("models arrays sort by id; record field order stays as constructed", () => {
	const doc = {
		providers: {
			x: {
				models: [
					{ id: "zeta", name: "Z", reasoning: true },
					{ id: "alpha", name: "A", reasoning: false },
				],
			},
		},
	};
	const models = /** @type {any} */ (canonicalizeManifest(doc)).providers.x.models;
	assert.deepEqual(
		models.map((/** @type {{ id: string }} */ m) => m.id),
		["alpha", "zeta"],
	);
	// id first is the human-reviewed schema (d050 §3) — a deep key-sort would break it
	assert.deepEqual(Object.keys(models[1]), ["id", "name", "reasoning"]);
});

test("opencode shape: provider map and its id-keyed models record both sort", () => {
	const doc = {
		provider: {
			zen: { models: { "qwen/x": {}, "01b-a": {}, "glm/y": {} } },
			local: { models: {} },
		},
	};
	const out = /** @type {any} */ (canonicalizeManifest(doc));
	assert.deepEqual(Object.keys(out.provider), ["local", "zen"]);
	assert.deepEqual(Object.keys(out.provider.zen.models), ["01b-a", "glm/y", "qwen/x"]);
});

test("allowHosts sorts; listen and other scalar maps stay put", () => {
	const doc = { listen: "0.0.0.0:8080", allowHosts: { "zeta.example": "u", "alpha.example": "u" } };
	const out = /** @type {any} */ (canonicalizeManifest(doc));
	assert.deepEqual(Object.keys(out.allowHosts), ["alpha.example", "zeta.example"]);
	assert.equal(out.listen, "0.0.0.0:8080");
});

test("non-manifest values pass through unchanged", () => {
	assert.equal(canonicalizeManifest(null), null);
	assert.deepEqual(canonicalizeManifest([2, 1]), [2, 1]);
	assert.deepEqual(canonicalizeManifest({ defaultProvider: "x" }), { defaultProvider: "x" });
});

test("serializeArtifact: pretty 2-space, trailing newline, valid JSON, idempotent", () => {
	const s = serializeArtifact({ providers: { b: { models: [{ id: "y" }, { id: "a" }] }, a: {} } });
	assert.ok(s.endsWith("}\n"));
	assert.ok(s.includes('\n  "providers"'));
	assert.deepEqual(JSON.parse(serializeArtifact(JSON.parse(s))), JSON.parse(s));
	assert.equal(serializeArtifact(JSON.parse(s)), s);
});

// --- committed-manifest canonicity guard (docs/d050 migration contract) ----
// Order-only edits to these files in a review now mean someone bypassed the
// write choke point — the whole point of d050 is that reruns are byte-stable.
const COMMITTED_MANIFESTS = [
	"coding-agent/model-010-local-default.json",
	"coding-agent/model-012-cloud-pi-native.json",
	"coding-agent/model-015-cloud-cline-pass.json",
	"coding-agent/model-016-cloud-hyper.json",
	"coding-agent/model-017-cloud-inferx.json",
	"coding-agent/models.json",
	"coding-agent/opencode.jsonc",
	"llm-reverse-proxy/llm-reverse-proxy.json",
];

for (const rel of COMMITTED_MANIFESTS) {
	test(`committed manifest is canonical: ${rel}`, () => {
		const text = readFileSync(join(repoRoot, rel), "utf-8");
		assert.equal(
			serializeArtifact(JSON.parse(text)),
			text,
			`${rel} is not in canonical form — regenerate through writeJsonArtifact (docs/d050)`,
		);
	});
}
