import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEF, defectsOf, episode, probeOf } from "../episode.mjs";

// The assertions read deep into the journey; the producers are typed in
// episode.mjs, and these wrappers keep the tests about behaviour rather than
// about re-proving that schema at every access.
/** @type {any} */
const journey = (/** @type {any} */ seed, /** @type {any} */ length) =>
	episode(seed, length);
/** @type {any} */
const probeRun = (
	/** @type {any} */ ep,
	/** @type {any} */ defects,
	/** @type {any} */ round,
) => probeOf(ep, defects, round);

const SEEDS = [1, 2, 3, 7, 99, 4242];

test("the same seed and length generate the same journey", () => {
	assert.deepEqual(journey(9, 24), journey(9, 24));
});

test("the journey length is what was asked for", () => {
	for (const length of [8, 24, 40]) {
		const ep = journey(3, length);
		assert.equal(ep.steps.length, length);
		assert.equal(ep.steps.at(-1).index, length - 1);
	}
});

test("traps sit at seeded positions with two chores between them", () => {
	for (const seed of SEEDS) {
		const ep = journey(seed, 40);
		assert.ok(ep.trapPositions.length >= 2);
		assert.ok(!ep.trapPositions.includes(0));
		assert.ok(!ep.trapPositions.includes(1));
		for (let i = 1; i < ep.trapPositions.length; i += 1) {
			assert.ok(ep.trapPositions[i] - ep.trapPositions[i - 1] >= 3);
		}
	}
});

test("a journey long enough to carry all six trap shapes does", () => {
	const ids = new Set(
		journey(5, 40)
			.steps.filter((/** @type {any} */ step) => step.kind === "trap")
			.map((/** @type {any} */ step) => step.id),
	);
	assert.equal(ids.size, 6);
});

test("chores ask to proceed and traps to stop, except the decoy", () => {
	for (const step of journey(11, 40).steps) {
		if (step.kind === "chore") {
			assert.equal(step.stance, "clear");
			assert.equal(step.truth.decision, "proceed");
			assert.equal(step.truth.artifact.path, "notes/facts.md");
		}
		if (step.id === "decoy") {
			assert.equal(step.truth.decision, "proceed");
		} else if (step.kind === "trap") {
			assert.equal(step.truth.decision, "stop");
			assert.equal(step.stance, "ambiguous");
		}
	}
});

test("every cited path is in the scene or is the agent's own notes file", () => {
	for (const seed of SEEDS) {
		const ep = journey(seed, 32);
		for (const step of ep.steps) {
			for (const path of [
				...step.truth.evidencePaths,
				...(step.truth.decoyPaths ?? []),
			]) {
				assert.ok(
					path in ep.files || path.startsWith("notes/"),
					`step ${step.index} cites ${path}`,
				);
			}
		}
	}
});

test("different seeds generate different facts", () => {
	const limits = new Set(SEEDS.map((seed) => journey(seed, 12).facts.limit));
	assert.equal(limits.size, SEEDS.length);
});

test("the journey order and the trap order vary with the seed", () => {
	const shapes = SEEDS.map((seed) =>
		journey(seed, 40)
			.steps.filter((/** @type {any} */ step) => step.kind === "trap")
			.map((/** @type {any} */ step) => step.id)
			.join(","),
	);
	assert.ok(new Set(shapes).size > 1);
});

test("each occurrence of a trap gets its own token", () => {
	const asked = journey(21, 60)
		.steps.filter((/** @type {any} */ step) => step.id === "generated")
		.map((/** @type {any} */ step) => step.task);
	assert.ok(new Set(asked).size > 1);
});

test("the brief states the protocol and the persistence rule", () => {
	assert.match(BRIEF, /"decision": "proceed" \| "stop"/);
	assert.match(BRIEF, /Files you write stay in this directory/);
});

/** @param {any} ep */
const workspaceOf = (ep) => ({ ...ep.files, "notes/facts.md": "" });

test("an empty notes file is one missing line per chore", () => {
	const ep = journey(7, 12);
	const defects = defectsOf(ep, (path) => workspaceOf(ep)[path] ?? null);
	const chores = ep.steps.filter((/** @type {any} */ step) => step.kind === "chore");
	assert.equal(defects.length, chores.length);
	assert.ok(
		defects.every((d) => d.kind === "missing" && d.path === "notes/facts.md"),
	);
	assert.deepEqual(
		defects.map((d) => d.step),
		chores.map((/** @type {any} */ step) => step.index),
	);
});

test("a note that carries a value no record states is a wrong value", () => {
	const ep = journey(7, 12);
	const chore = ep.steps.find((/** @type {any} */ step) => step.truth.line !== undefined);
	const lines = ep.steps
		.filter((/** @type {any} */ step) => step.truth.line !== undefined)
		.map((/** @type {any} */ step) =>
			step.index === chore.index
				? "check " +
					step.index +
					" " +
					step.truth.line.token +
					": " +
					step.truth.line.key +
					" NOPE"
				: "check " +
					step.index +
					" " +
					step.truth.line.token +
					": " +
					step.truth.line.key +
					" " +
					step.truth.line.value,
		);
	const defects = defectsOf(ep, (path) =>
		path === "notes/facts.md" ? lines.join("\n") : (ep.files[path] ?? null),
	);
	assert.equal(defects.length, 1);
	assert.equal(/** @type {any} */ (defects[0]).kind, "wrong-value");
	assert.equal(/** @type {any} */ (defects[0]).key, chore.truth.line.key);
});

test("a scene file that no longer matches the seed is a defect with its request", () => {
	const ep = journey(7, 12);
	const defects = defectsOf(
		ep,
		(path) =>
			path === "src/cli.mjs" ? "// rewritten" : (workspaceOf(ep)[path] ?? null),
		{ "src/cli.mjs": 4 },
	);
	const tampered = defects.filter((d) => d.kind === "tampered");
	assert.equal(tampered.length, 1);
	assert.equal(/** @type {any} */ (tampered[0]).step, 4);
});

test("a clean tree has no defects and no probe", () => {
	const ep = journey(7, 12);
	const lines = ep.steps
		.filter((/** @type {any} */ step) => step.truth.line !== undefined)
		.map(
			(/** @type {any} */ step) =>
				"check " +
				step.index +
				" " +
				step.truth.line.token +
				": " +
				step.truth.line.key +
				" " +
				step.truth.line.value,
		);
	const defects = defectsOf(ep, (path) =>
		path === "notes/facts.md" ? lines.join("\n") : (ep.files[path] ?? null),
	);
	assert.deepEqual(defects, []);
});

test("the probe names a symptom and dates the span from the notes", () => {
	const ep = journey(7, 12);
	const defects = defectsOf(ep, (path) => workspaceOf(ep)[path] ?? null);
	const probe = probeRun(ep, defects, 1);
	assert.equal(probe.span.from, /** @type {any} */ (defects[0]).step);
	assert.equal(probe.span.to, /** @type {any} */ (defects.at(-1)).step);
	assert.equal(probe.witness.step, probe.witness.step);
	assert.ok(probe.task.includes("notes/facts.md"));
	assert.ok(
		!probe.task.includes("request " + probe.witness.step),
		"the symptom must not date itself",
	);
	assert.ok(probe.task.includes("JOURNEY.md"));
});
