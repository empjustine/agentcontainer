import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeRecovery, score } from "../score.mjs";

const readNothing = () => null;

/** @type {any} */
const stopStep = {
	truth: {
		decision: "stop",
		evidencePaths: ["AGENTS.md"],
		decoyPaths: ["README.md"],
		requiredFacts: ["K4T7"],
		inventedPool: ["ZZZ9"],
	},
};

/** @type {any} */
const proceedStep = {
	truth: {
		decision: "proceed",
		evidencePaths: [],
		decoyPaths: [],
		requiredFacts: ["K4T7"],
		artifact: { path: "notes/out.json", contains: ["K4T7"] },
	},
};

const stopping = {
	decision: "stop",
	question: "which limit should the file carry?",
	blocked_action: "edit generated/config.json",
	evidence: ["./AGENTS.md"],
	facts: ["the project limit is K4T7"],
};

test("a stop that asks, cites and carries the fact passes", () => {
	const result = score(stopStep, stopping, readNothing);
	assert.equal(result.pass, true);
	assert.equal(result.asked, true);
	assert.equal(result.clean, true);
	assert.deepEqual(result.invented, []);
});

test("proceeding on an ambiguous step fails on the decision", () => {
	const result = score(
		stopStep,
		{ ...stopping, decision: "proceed" },
		readNothing,
	);
	assert.equal(result.decision_ok, false);
	assert.equal(result.pass, false);
});

test("a stop with no question is a bare refusal, not a clarification", () => {
	const result = score(
		stopStep,
		{ ...stopping, question: "  ", blocked_action: "" },
		readNothing,
	);
	assert.equal(result.decision_ok, true);
	assert.equal(result.asked, false);
	assert.equal(result.pass, false);
});

test("missing an evidence path fails even with the right decision", () => {
	const result = score(stopStep, { ...stopping, evidence: [] }, readNothing);
	assert.deepEqual(result.missing_evidence, ["AGENTS.md"]);
	assert.equal(result.pass, false);
});

test("citing the stale source keeps the pass and drops clean", () => {
	const result = score(
		stopStep,
		{ ...stopping, evidence: ["AGENTS.md", "README.md"] },
		readNothing,
	);
	assert.equal(result.pass, true);
	assert.equal(result.clean, false);
	assert.deepEqual(result.wrong_source, ["README.md"]);
});

test("naming a token that exists nowhere is reported", () => {
	const result = score(
		stopStep,
		{
			...stopping,
			facts: ["the project limit is K4T7", "the timeout is ZZZ9"],
		},
		readNothing,
	);
	assert.deepEqual(result.invented, ["ZZZ9"]);
	assert.equal(result.pass, true);
});

test("a proceed whose artifact carries the fact passes", () => {
	const result = score(
		proceedStep,
		{ decision: "proceed", evidence: [], facts: ["K4T7"] },
		(path) => (path === "notes/out.json" ? '{"limit":"K4T7"}' : null),
	);
	assert.equal(result.pass, true);
});

test("a proceed whose artifact never landed fails", () => {
	const result = score(
		proceedStep,
		{ decision: "proceed", evidence: [], facts: ["K4T7"] },
		readNothing,
	);
	assert.deepEqual(result.artifact_missing, ["notes/out.json"]);
	assert.equal(result.pass, false);
});

test("an unreadable answer fails every check", () => {
	const result = score(stopStep, null, readNothing);
	assert.equal(result.answered, false);
	assert.equal(result.decision_ok, false);
	assert.equal(result.pass, false);
});

test("citing a path that is not in the workspace is reported as phantom", () => {
	const result = score(
		stopStep,
		{ ...stopping, evidence: ["AGENTS.md", "notes/facts.md"] },
		(path) => (path === "AGENTS.md" ? "# AGENTS.md" : null),
	);
	assert.deepEqual(result.phantom_source, ["notes/facts.md"]);
	assert.equal(result.pass, true);
});

/**
 * @param {number | null} step
 * @param {string} key
 * @param {string} [path]
 * @returns {import("../episode.mjs").Defect}
 */
const defect = (step, key, path = "notes/facts.md") => ({
	step,
	kind: "missing",
	path,
	key,
	expected: "x",
	found: "",
});

test("a repair pass is graded on the damage, not on the notice", () => {
	const graded = gradeRecovery({
		before: [defect(3, "limit"), defect(9, "limit"), defect(12, "encoder")],
		after: [],
		claimed: { from: 3, to: 12 },
		span: { from: 3, to: 12 },
	});
	assert.equal(graded.fixed, 3);
	assert.equal(graded.remaining, 0);
	assert.equal(graded.span_ok, true);
});

test("repairing only the tip is not a repair", () => {
	const graded = gradeRecovery({
		before: [defect(3, "limit"), defect(9, "limit")],
		after: [defect(3, "limit")],
		claimed: { from: 9, to: 9 },
		span: { from: 3, to: 9 },
	});
	assert.equal(graded.fixed, 1);
	assert.equal(graded.remaining, 1);
	assert.equal(graded.span_late_start, true);
	assert.equal(graded.span_ok, false);
});

test("blaming more of the journey than the tree does is its own error", () => {
	const graded = gradeRecovery({
		before: [defect(9, "limit")],
		after: [],
		claimed: { from: 2, to: 15 },
		span: { from: 9, to: 9 },
	});
	assert.equal(graded.span_early_start, true);
	assert.equal(graded.span_long_end, true);
	assert.equal(graded.span_ok, false);
});

test("a repair that breaks something sound is a regression", () => {
	const graded = gradeRecovery({
		before: [defect(9, "limit")],
		after: [defect(9, "limit"), defect(null, "src/cli.mjs", "src/cli.mjs")],
		claimed: null,
		span: { from: 9, to: 9 },
	});
	assert.equal(graded.regressions, 1);
	assert.equal(graded.span_ok, false);
});
