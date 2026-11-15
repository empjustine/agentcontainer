import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgv, report, run } from "../bench.mjs";
import { episode } from "../episode.mjs";

const STUB = [
	'import { createInterface } from "node:readline";',
	"const lines = createInterface({ input: process.stdin });",
	'lines.on("line", (line) => {',
	"	const { step } = JSON.parse(line);",
	'	const answer = { step, decision: "proceed", question: "", blocked_action: "", evidence: [], facts: [] };',
	'	process.stdout.write(JSON.stringify(answer) + "\\n");',
	"});",
].join("\n");

const DYING = [
	'import { createInterface } from "node:readline";',
	"const lines = createInterface({ input: process.stdin });",
	"let seen = 0;",
	'lines.on("line", (line) => {',
	"	seen += 1;",
	"	if (seen > 2) {",
	"		process.exit(0);",
	"	}",
	"	const { step } = JSON.parse(line);",
	'	const answer = { step, decision: "stop", question: "q", blocked_action: "b", evidence: [], facts: [] };',
	'	process.stdout.write(JSON.stringify(answer) + "\\n");',
	"});",
].join("\n");

function harness(source) {
	const root = mkdtempSync(join(tmpdir(), "llm-local-bench-"));
	const agent = join(root, "agent.mjs");
	writeFileSync(agent, source);
	return {
		out: join(root, "run"),
		agent: `${JSON.stringify(process.execPath)} ${JSON.stringify(agent)}`,
	};
}

const opts = (dir, extra) => ({
	seeds: [3],
	out: dir.out,
	deadlineMs: 5000,
	length: 8,
	arm: "journey",
	agent: dir.agent,
	...extra,
});

const stepsOf = (records, arm) =>
	records.filter((r) => r.record === "step" && r.arm === arm);

test("a journey answers every step and reports a distance", async () => {
	const dir = harness(STUB);
	const records = await run(opts(dir));
	assert.equal(stepsOf(records, "journey").length, 8);
	const episode = records.find((r) => r.record === "episode");
	assert.equal(episode.answered, 8);
	assert.equal(episode.died, false);
	assert.equal(episode.firstFailure.ordinal, 1);
	assert.notEqual(episode.firstFailure.cause, "no-answer");
	assert.match(
		episode.firstFailure.cause,
		/^wrong-decision|bare-refusal|missed-source|missed-fact$/,
	);
	assert.match(report(records), /## Trap survival/);
});

test("resuming adds nothing to a completed journey", async () => {
	const dir = harness(STUB);
	const first = await run(opts(dir));
	const second = await run(opts(dir));
	assert.equal(
		stepsOf(second, "journey").length,
		stepsOf(first, "journey").length,
	);
	assert.equal(
		second.filter((r) => r.record === "episode").length,
		first.filter((r) => r.record === "episode").length,
	);
});

test("the two arms journal side by side on one seed", async () => {
	const dir = harness(STUB);
	const both = await run(opts(dir, { arm: "both" }));
	assert.equal(stepsOf(both, "journey").length, 8);
	assert.equal(stepsOf(both, "steps").length, 8);
	assert.match(report(both), /\| steps \| 1 \|/);
});

test("a dead session leaves the rest of the journey unreached", async () => {
	const dir = harness(DYING);
	const records = await run(opts(dir, { deadlineMs: 400 }));
	const episode = records.find((r) => r.record === "episode");
	assert.equal(episode.died, true);
	assert.equal(episode.answered, 2);
	assert.equal(stepsOf(records, "journey").length, 3);
	assert.match(report(records), /incomplete/);
});

test("the argv surface parses length and arm", () => {
	const parsed = parseArgv([
		"--seeds",
		"2-3",
		"--length",
		"40",
		"--arm",
		"both",
		"--agent",
		"true",
	]);
	assert.deepEqual(parsed.seeds, [2, 3]);
	assert.equal(parsed.length, 40);
	assert.equal(parsed.arm, "both");
});

test("a repair pass runs over the state the journey left, in a fresh session", async () => {
	const dir = harness(STUB);
	const records = await run(opts(dir, { passes: 2 }));
	const recovery = records.find((r) => r.record === "recovery");
	assert.ok(recovery.defects > 0);
	assert.ok(recovery.span.from <= recovery.span.to);
	assert.equal(recovery.fixed, 0);
	assert.equal(recovery.remaining, recovery.defects);
	assert.equal(recovery.regressions, 0);
	assert.equal(recovery.span_ok, false);
});

test("a second run does not repeat a finished repair pass", async () => {
	const dir = harness(STUB);
	const first = await run(opts(dir, { passes: 2 }));
	const second = await run(opts(dir, { passes: 2 }));
	assert.equal(
		second.filter((r) => r.record === "recovery").length,
		first.filter((r) => r.record === "recovery").length,
	);
});

test("a tree with nothing to repair records no witness", async () => {
	const dir = harness(STUB);
	await run(opts(dir, { passes: 1 }));
	const ep = episode(3, 8);
	const lines = ep.steps
		.filter((step) => step.truth.line !== undefined)
		.map(
			(step) =>
				"check " +
				step.index +
				" " +
				step.truth.line.token +
				": " +
				step.truth.line.key +
				" " +
				step.truth.line.value,
		);
	writeFileSync(
		join(dir.out, "seed-3", "journey", "notes/facts.md"),
		lines.join("\n") + "\n",
	);
	const records = await run(opts(dir, { passes: 2 }));
	const recovery = records.find((r) => r.record === "recovery");
	assert.equal(recovery.defects, 0);
	assert.equal(recovery.witness, null);
});
