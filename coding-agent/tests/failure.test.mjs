/**
 * @fileoverview failure.test.mjs — the failure shape is a VALUE (docs/d225):
 * the exit code rides `Symbol.for("process.exitCode")`, a plain error carries
 * none, and a foreign string `exitCode` field is not mistaken for it. That is
 * what lets an entry point's handler read the status without process.exit
 * turning refusals into a test-only subprocess.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { exitCodeOf, failure } from "../lib/failure.mjs";

test("a failure is an Error whose code rides the registry symbol", () => {
	const refused = failure("required mount source is gone", 91, { mount: "/x" });
	assert.ok(refused instanceof Error);
	assert.equal(exitCodeOf(refused), 91);
	assert.equal(refused.fields?.mount, "/x");
	assert.equal(
		/** @type {Record<symbol, unknown>} */ (refused)[
			Symbol.for("process.exitCode")
		],
		91,
	);
});

test("an ordinary error carries no exit code", () => {
	assert.equal(exitCodeOf(new Error("boom")), undefined);
	assert.equal(exitCodeOf("boom"), undefined);
	assert.equal(exitCodeOf(null), undefined);
});

test("a string exitCode field is not the contract", () => {
	const foreign = Object.assign(new Error("from a library"), { exitCode: 13 });
	assert.equal(exitCodeOf(foreign), undefined);
});
