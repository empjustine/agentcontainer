/**
 * @fileoverview The shared argv loop (docs/d121). These tests exist because
 * seven entries now depend on ONE parser: a divergence here is not a bug in a
 * tool, it is a bug in every tool's interface at once. Each case pins a rule a
 * hand-written switch used to encode, including the two the parser must not
 * "improve": a missing value stays undefined, and a boolean consumes nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseFlags } from "../lib/cli.mjs";

/** @type {Record<string, import("../lib/cli.mjs").FlagSpec>} */
const TABLE = {
	root: { default: "/tmp/farm" },
	"max-depth": { kind: "number", default: 3 },
	jobs: { kind: "number" },
	deep: { kind: "bool" },
	"no-optimize": { kind: "bool" },
	fetch: { names: ["--no-fetch"], kind: "bool", default: true },
	num: { kind: "number", default: 50 },
	only: { kind: "list" },
	dest: { names: ["--dest", "-d"] },
};

test("defaults come from the table when a flag never appears", () => {
	const { values, help } = parseFlags([], TABLE);
	assert.equal(values.root, "/tmp/farm");
	assert.equal(values["max-depth"], 3);
	assert.equal(values.deep, undefined);
	assert.equal(values.fetch, true);
	assert.deepEqual(values.only, []);
	assert.equal(help, false);
});

test("a value flag consumes the next token, numbers are coerced", () => {
	const { values } = parseFlags(
		["--root", "/srv/farm", "--max-depth", "7", "--jobs", "2"],
		TABLE,
	);
	assert.equal(values.root, "/srv/farm");
	assert.equal(values["max-depth"], 7);
	assert.equal(values.jobs, 2);
});

test("a boolean consumes NOTHING — the next flag stays a flag", () => {
	// The trap: `--deep-optimize --no-optimize` must read as two booleans. If
	// a boolean took the next token, --no-optimize would silently become its
	// value and the documented conflict would go unreported (docs/d089).
	const { values } = parseFlags(["--deep", "--no-optimize"], TABLE);
	assert.equal(values.deep, true);
	assert.equal(values["no-optimize"], true);
});

test("a list flag accumulates, in argv order", () => {
	const { values } = parseFlags(
		["--only", "a/*", "--only", "b/*", "--root", "/x"],
		TABLE,
	);
	assert.deepEqual(values.only, ["a/*", "b/*"]);
	assert.equal(values.root, "/x");
});

test("an alternate spelling reaches the same option", () => {
	const { values } = parseFlags(["--dest", "/mirrors"], TABLE);
	assert.equal(values.dest, "/mirrors");
	const short = parseFlags(["-d", "/mirrors"], TABLE);
	assert.equal(short.values.dest, "/mirrors");
});

test("a value flag at the end of argv yields undefined, not a throw", () => {
	// Loose on purpose: the letters `--root` with nothing after it stays the
	// benign case it always was, so no operator script starts failing on an
	// unrelated refactor.
	const { values } = parseFlags(["--root"], TABLE);
	assert.equal(values.root, undefined);
	assert.equal(parseFlags(["--jobs"], TABLE).values.jobs, Number(undefined));
});

test("an unknown flag throws the one message, carrying the token", () => {
	for (const token of ["--bogus", "-x"]) {
		assert.throws(
			() => parseFlags([token], TABLE),
			(/** @type {Error & { flag?: string }} */ err) => {
				assert.equal(err.message, "unknown flag (try --help)");
				assert.equal(err.flag, token);
				return true;
			},
		);
	}
});

test("-h and --help set help and keep parsing", () => {
	assert.equal(parseFlags(["-h"], TABLE).help, true);
	const withFlag = parseFlags(["--help", "--root", "/x"], TABLE);
	assert.equal(withFlag.help, true);
	assert.equal(withFlag.values.root, "/x");
});

test("positional policy reject turns any positional into an unknown flag", () => {
	assert.throws(() => parseFlags(["farm"], TABLE), /unknown flag/);
});

test("positional policy last keeps only the final positional", () => {
	const { values, positionals } = parseFlags(["a.har", "b.har"], TABLE, "last");
	assert.deepEqual(positionals, ["a.har", "b.har"]);
	assert.equal(values.positional, "b.har");
});

test("positional policy list accumulates every positional", () => {
	const { values } = parseFlags(["https://h/o/r", "dir"], TABLE, "list");
	assert.deepEqual(values.positional, ["https://h/o/r", "dir"]);
});

test("positional policy join rebuilds one space-joined query", () => {
	const { values } = parseFlags(
		["--num", "5", "pickaxe", "slow"],
		TABLE,
		"join",
	);
	assert.equal(values.positional, "pickaxe slow");
	assert.equal(values.num, 5);
});

test("a flag-shaped token is refused even when positionals are allowed", () => {
	// forge-mirror's rule: an option-shaped URL must die at the boundary, never
	// inside git's argv — so the policy never swallows a leading dash.
	/** @type {import("../lib/cli.mjs").PositionalPolicy[]} */
	const policies = ["last", "list", "join"];
	for (const policy of policies) {
		assert.throws(() => parseFlags(["--bogus"], TABLE, policy), /unknown flag/);
	}
});
