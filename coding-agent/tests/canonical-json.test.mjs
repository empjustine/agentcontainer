/**
 * @fileoverview canonical-json.test.mjs — the unit half of docs/d050: the
 * canonicalization rules that coding-agent/lib/canonical-json.mjs implements
 * (docs/d113 moved the committed-manifest drift guard to
 * tests/committed-manifests.test.mjs beside this file, because its subject is
 * this folder's committed manifests).
 *
 * Run: ../node-run.sh --test tests/*.test.mjs   (this folder)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	canonicalizeManifest,
	serializeArtifact,
} from "../lib/canonical-json.mjs";


test("providers map keys sort ascending in code-unit order, input untouched", () => {
	const doc = {
		providers: { openrouter: {}, Google: {}, mistral: {}, alpha: {} },
	};
	const out = canonicalizeManifest(doc);
	assert.deepEqual(Object.keys(/** @type {any} */ (out).providers), [
		"Google",
		"alpha",
		"mistral",
		"openrouter",
	]);
	// source key order unchanged — canonicalization never mutates the builder's doc
	assert.deepEqual(Object.keys(doc.providers), [
		"openrouter",
		"Google",
		"mistral",
		"alpha",
	]);
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
	const models = /** @type {any} */ (canonicalizeManifest(doc)).providers.x
		.models;
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
	assert.deepEqual(Object.keys(out.provider.zen.models), [
		"01b-a",
		"glm/y",
		"qwen/x",
	]);
});

test("non-manifest values pass through unchanged", () => {
	assert.equal(canonicalizeManifest(null), null);
	assert.deepEqual(canonicalizeManifest([2, 1]), [2, 1]);
	assert.deepEqual(canonicalizeManifest({ defaultProvider: "x" }), {
		defaultProvider: "x",
	});
});

test("serializeArtifact: pretty 2-space, trailing newline, valid JSON, idempotent", () => {
	const s = serializeArtifact({
		providers: { b: { models: [{ id: "y" }, { id: "a" }] }, a: {} },
	});
	assert.ok(s.endsWith("}\n"));
	assert.ok(s.includes('\n  "providers"'));
	assert.deepEqual(JSON.parse(serializeArtifact(JSON.parse(s))), JSON.parse(s));
	assert.equal(serializeArtifact(JSON.parse(s)), s);
});

