/**
 * @fileoverview modality-allowlist.test.mjs — the docs/d049 contract for
 * pi's driving-capability declaration: the admit-but-trim GATE
 * (modalitiesEligible) judges what the record carries, the PROJECTION
 * (toInput) trims to the capability in capability order, and both read the
 * one PI_MODALITY_CAPABILITY constant — the properties this test pins are
 * the reason d049 can call eligibility and emission "one declaration".
 *
 * Run: node --test   (discovers tests/*.test.mjs from the repo root)
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	PI_MODALITY_CAPABILITY,
	modalitiesEligible,
	toInput,
} from "../coding-agent/gen-lib.mjs";

test("capability: text+image in, text out, frozen (the pipeline-wide constant)", () => {
	assert.deepEqual([...PI_MODALITY_CAPABILITY.input], ["text", "image"]);
	assert.deepEqual([...PI_MODALITY_CAPABILITY.output], ["text"]);
	assert.ok(Object.isFrozen(PI_MODALITY_CAPABILITY));
	// The drivable core gates and the fallback projection read input[0].
	assert.equal(PI_MODALITY_CAPABILITY.input[0], "text");
});

test("gate refuses what the client cannot drive (admit side)", () => {
	// Input without the drivable core: audio-only can never be driven.
	assert.equal(modalitiesEligible({ input: ["audio"] }), false);
	assert.equal(modalitiesEligible({ input: ["video", "audio"] }), false);
	// Output beyond text: a chat client cannot consume it — one foreign
	// entry refuses the model (no trim applies to what comes back).
	assert.equal(modalitiesEligible({ output: ["text", "audio"] }), false);
	assert.equal(modalitiesEligible({ output: ["image"] }), false);
});

test("gate admits chat sets and trims-later extras (trim side)", () => {
	assert.equal(modalitiesEligible({ input: ["text"], output: ["text"] }), true);
	assert.equal(
		modalitiesEligible({ input: ["text", "image"], output: ["text"] }),
		true,
	);
	// Admit-but-trim: extra INPUT next to text is fine — the projection
	// drops it at emission instead of refusing a usable model.
	assert.equal(
		modalitiesEligible({ input: ["text", "audio"], output: ["text"] }),
		true,
	);
});

test("gate passes unjudgeable dimensions (missing metadata is never enriched)", () => {
	assert.equal(modalitiesEligible(undefined), true);
	assert.equal(modalitiesEligible({}), true);
	// Partial records judge only what they carry (catwalk/hyper have no
	// output label; live listings type input only).
	assert.equal(modalitiesEligible({ input: ["text"] }), true);
	assert.equal(modalitiesEligible({ output: ["text"] }), true);
	assert.equal(modalitiesEligible({ input: [], output: [] }), true);
});

test("projection trims to the capability, in capability order", () => {
	assert.deepEqual(toInput(["text", "audio", "video"]), ["text"]);
	assert.deepEqual(toInput(["text", "image"]), ["text", "image"]);
	// Canonical order comes from the constant, not the record's order.
	assert.deepEqual(toInput(["image", "text"]), ["text", "image"]);
	assert.deepEqual(toInput(undefined), ["text"]);
	// Metadata-less or fully-trimmed records fall back to the drivable
	// core rather than emitting an array the schema rejects.
	assert.deepEqual(toInput(["audio"]), ["text"]);
	assert.deepEqual(toInput([]), ["text"]);
});

test("gate and projection agree by construction (both derive from the constant)", () => {
	// Every admitted input set, projected, still starts with the core the
	// gate required — emission can never contradict eligibility.
	const admitted = [
		["text"],
		["text", "image"],
		["text", "audio"],
		["image", "text", "pdf"],
	];
	for (const input of admitted) {
		assert.equal(modalitiesEligible({ input }), true);
		assert.equal(toInput(input)[0], PI_MODALITY_CAPABILITY.input[0]);
	}
});
